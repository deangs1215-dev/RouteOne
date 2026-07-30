// Sync engine: pulls canonical rows from the active provider and upserts them
// into the app's tables, keyed on customer code / product (stock) code.
// Every run is recorded in sync_runs.
import { db, getSetting, packWeightKg, getTodayISO } from '../db.js';
import { getProvider } from './providers.js';

const upsertWarehouse = (row) => {
  db.prepare(`
    INSERT INTO warehouses (code, name) VALUES (?, ?)
    ON CONFLICT(code) DO UPDATE SET name = excluded.name
  `).run(row.code, row.name);
};

// Match a customer to a rep using warehouse code + rep code.
// Rep codes aren't globally unique - the same code means different people
// under different branches. SYSPRO uses Branch+Salesperson as the key.
export const matchRep = (warehouseCode, repCode) => {
  if (!warehouseCode || !repCode) return null;
  // Look up the rep by matching warehouse code + rep code
  const rep = db.prepare(`
    SELECT u.id FROM users u
    JOIN roles r ON r.id = u.role_id
    JOIN warehouses w ON w.id = u.warehouse_id
    WHERE r.name = 'rep' AND u.active = 1 AND u.rep_code = ? AND w.code = ?
  `).get(repCode, warehouseCode);
  return rep?.id ?? null;
};

// Some customers reference a branch code that's missing from vw_FS_Warehouses
// (e.g. branch 30) - rather than dropping those customers from every sync, a
// placeholder warehouse is created for the code. If the view is later fixed
// to include it, the next warehouses sync just updates this stub's name.
const warehouseForCode = (code) => {
  if (!code) return null;
  let warehouse = db.prepare('SELECT id FROM warehouses WHERE code = ?').get(code);
  if (!warehouse) {
    const info = db.prepare('INSERT INTO warehouses (code, name) VALUES (?, ?)').run(code, `Branch ${code} (unmapped)`);
    warehouse = { id: info.lastInsertRowid };
  }
  return warehouse;
};

const upsertCustomer = (row) => {
  const existing = db.prepare('SELECT id FROM customers WHERE code = ?').get(row.code);
  const onHoldStatus = row.on_hold ? 'on_hold' : 'active';
  const warehouse = warehouseForCode(row.warehouse_code);
  const repId = matchRep(row.warehouse_code, row.rep_code);
  if (existing) {
    // ERP is the master for financial fields AND for rep ownership - a customer
    // reassigned in SYSPRO follows on the next sync, so the old rep stops seeing
    // it. Territory, grading, GPS and visit frequency stay app-managed.
    //
    // rep_id uses COALESCE deliberately: matchRep returns null when the rep code
    // has no user (house/export accounts) or the customer sits outside its rep's
    // home branch. Assigning that null would un-assign customers that are
    // currently matched, so a failed match leaves the existing rep in place.
    db.prepare(`
      UPDATE customers SET name = ?, contact_name = COALESCE(?, contact_name), phone = COALESCE(?, phone),
        email = COALESCE(?, email), address = COALESCE(?, address), city = COALESCE(?, city),
        credit_limit = ?, balance = ?, payment_terms = COALESCE(?, payment_terms),
        warehouse_id = COALESCE(?, warehouse_id),
        rep_id = COALESCE(?, rep_id),
        status = CASE WHEN status = 'closed' THEN 'closed' ELSE ? END
      WHERE id = ?
    `).run(row.name, row.contact_name, row.phone, row.email, row.address, row.city,
      row.credit_limit ?? 0, row.balance ?? 0, row.payment_terms, warehouse?.id ?? null,
      repId, onHoldStatus, existing.id);
  } else {
    // A brand-new customer is auto-assigned to its matching rep on first sync.
    db.prepare(`
      INSERT INTO customers (code, name, contact_name, phone, email, address, city, credit_limit, balance, payment_terms, warehouse_id, status, rep_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.code, row.name, row.contact_name || null, row.phone || null, row.email || null,
      row.address || null, row.city || null, row.credit_limit ?? 0, row.balance ?? 0,
      row.payment_terms || '30 days', warehouse?.id ?? null, onHoldStatus, repId);
  }
};

const upsertProduct = (row) => {
  let categoryId = null;
  if (row.category) {
    const cat = db.prepare('SELECT id FROM product_categories WHERE name = ?').get(row.category);
    categoryId = cat
      ? cat.id
      : db.prepare('INSERT INTO product_categories (name) VALUES (?)').run(row.category).lastInsertRowid;
  }
  const packWeight = packWeightKg(row.pack_size);
  const existing = db.prepare('SELECT id FROM products WHERE code = ?').get(row.code);
  if (existing) {
    db.prepare(`
      UPDATE products SET name = ?, category_id = COALESCE(?, category_id), description = COALESCE(?, description),
        uom = COALESCE(?, uom), pack_size = COALESCE(?, pack_size), pack_weight_kg = COALESCE(?, pack_weight_kg),
        list_price = ?, cost_price = COALESCE(?, cost_price)
      WHERE id = ?
    `).run(row.name, categoryId, row.description, row.uom, row.pack_size, packWeight, row.list_price ?? 0, row.cost_price, existing.id);
  } else {
    db.prepare(`
      INSERT INTO products (code, name, category_id, description, uom, pack_size, pack_weight_kg, list_price, cost_price, stock_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(row.code, row.name, categoryId, row.description || null, row.uom || 'each',
      row.pack_size || null, packWeight, row.list_price ?? 0, row.cost_price ?? 0);
  }
};

// Stock arrives one row per (product, branch) so the Products page can show a
// per-warehouse breakdown; products.stock_qty is kept as the summed total for
// code that only needs a single number (order capture, low-stock warnings).
const upsertStock = (row) => {
  const product = db.prepare('SELECT id FROM products WHERE code = ?').get(row.code);
  if (!product) throw new Error(`Stock row for unknown product code ${row.code}`);
  const warehouse = warehouseForCode(row.warehouse_code);
  if (warehouse) {
    db.prepare(`
      INSERT INTO product_stock (product_id, warehouse_id, qty_available) VALUES (?, ?, ?)
      ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty_available = excluded.qty_available
    `).run(product.id, warehouse.id, row.qty_available ?? 0);
  }
  const total = db.prepare('SELECT COALESCE(SUM(qty_available), 0) AS total FROM product_stock WHERE product_id = ?').get(product.id).total;
  db.prepare('UPDATE products SET stock_qty = ? WHERE id = ?').run(total, product.id);
};

const upsertInvoice = (row) => {
  const customer = db.prepare('SELECT id FROM customers WHERE code = ?').get(row.customer_code);
  const subtotal = row.subtotal ?? 0;
  const vat = row.vat_amount ?? 0;
  // SYSPRO's InvoiceValue occasionally comes through as 0 even when the
  // merchandise + tax values are populated (view/column quirk). The gross is
  // always subtotal + VAT, so derive it when the supplied total is missing/0.
  let total = row.total ?? 0;
  if (!(total > 0) && (subtotal + vat) > 0) total = Math.round((subtotal + vat) * 100) / 100;
  const paid = row.amount_paid ?? 0;
  const balance = row.balance ?? (total - paid);
  // Derive status if the ERP didn't supply one.
  let status = row.status;
  if (!status) {
    if (balance <= 0.005) status = 'paid';
    else if (row.due_date && row.due_date < getTodayISO()) status = 'overdue';
    else status = 'outstanding';
  }
  db.prepare(`
    INSERT INTO invoices (number, customer_id, customer_code, order_number, invoice_date, due_date,
      subtotal, vat_amount, total, amount_paid, balance, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(number) DO UPDATE SET
      customer_id = excluded.customer_id, customer_code = excluded.customer_code,
      order_number = excluded.order_number, invoice_date = excluded.invoice_date,
      due_date = excluded.due_date, subtotal = excluded.subtotal, vat_amount = excluded.vat_amount,
      total = excluded.total, amount_paid = excluded.amount_paid, balance = excluded.balance,
      status = excluded.status
  `).run(row.number, customer?.id ?? null, row.customer_code, row.order_number || null,
    row.invoice_date, row.due_date || null, subtotal, vat,
    total, paid, balance, status);
};

const upsertCustomerPricing = (row) => {
  db.prepare(`
    INSERT INTO syspro_customer_pricing (customer_code, product_code, contract_price, buying_group_price, price_code_price, contract_start_date, contract_end_date, buying_group_start_date, buying_group_end_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(customer_code, product_code) DO UPDATE SET
      contract_price = excluded.contract_price,
      buying_group_price = excluded.buying_group_price,
      price_code_price = excluded.price_code_price,
      contract_start_date = excluded.contract_start_date,
      contract_end_date = excluded.contract_end_date,
      buying_group_start_date = excluded.buying_group_start_date,
      buying_group_end_date = excluded.buying_group_end_date,
      synced_at = datetime('now')
  `).run(
    row.customer_code, row.product_code,
    row.contract_price ?? null, row.buying_group_price ?? null, row.price_code_price ?? null,
    row.contract_start_date ?? null, row.contract_end_date ?? null,
    row.buying_group_start_date ?? null, row.buying_group_end_date ?? null
  );
};

const UPSERTERS = { warehouses: upsertWarehouse, customers: upsertCustomer, products: upsertProduct, stock: upsertStock, invoices: upsertInvoice, customer_pricing: upsertCustomerPricing };

// Order matters: customers reference warehouses; customer_pricing and invoices reference customers (and products).
// Rep-to-warehouse assignment is managed manually in RouteOne (SalSalesperson branch data is
// unreliable - the same rep code can show multiple conflicting branches), so "reps" is not synced here.
export const SYNC_ENTITIES = ['warehouses', 'customers', 'products', 'stock', 'invoices', 'customer_pricing'];
const syncsInFlight = new Set();

export async function runSync(entity) {
  if (!UPSERTERS[entity]) throw new Error(`Unknown sync entity: ${entity}`);
  if (syncsInFlight.has(entity)) throw new Error(`${entity} sync is already running`);
  const source = getSetting('intg_source', 'demo');
  const runId = db.prepare('INSERT INTO sync_runs (source, entity) VALUES (?, ?)').run(source, entity).lastInsertRowid;
  syncsInFlight.add(entity);
  try {
    const rows = await getProvider().fetch(entity);
    let upserted = 0;
    const errors = [];
    // Wrapped in a single transaction - without this, better-sqlite3 commits
    // each row individually, which is what made the ~13M-row customer_pricing
    // sync take over an hour. Batching as one transaction cuts that to seconds.
    const upsertAll = db.transaction((rows) => {
      for (const row of rows) {
        try {
          UPSERTERS[entity](row);
          upserted += 1;
        } catch (e) {
          errors.push(e.message);
        }
      }
    });
    upsertAll(rows);
    db.prepare(`
      UPDATE sync_runs SET status = 'completed', rows_read = ?, rows_upserted = ?, error = ?, finished_at = datetime('now')
      WHERE id = ?
    `).run(rows.length, upserted, errors.length ? errors.slice(0, 10).join('; ') : null, runId);
    return { run_id: runId, entity, rows_read: rows.length, rows_upserted: upserted, row_errors: errors.length };
  } catch (e) {
    db.prepare(`
      UPDATE sync_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?
    `).run(e.message, runId);
    throw e;
  } finally {
    syncsInFlight.delete(entity);
  }
}
