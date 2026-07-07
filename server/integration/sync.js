// Sync engine: pulls canonical rows from the active provider and upserts them
// into the app's tables, keyed on customer code / product (stock) code.
// Every run is recorded in sync_runs.
import { db, getSetting } from '../db.js';
import { getProvider } from './providers.js';

const upsertCustomer = (row) => {
  const existing = db.prepare('SELECT id FROM customers WHERE code = ?').get(row.code);
  const onHoldStatus = row.on_hold ? 'on_hold' : 'active';
  if (existing) {
    // ERP is the master for financial fields; app-managed fields (rep,
    // territory, grading, GPS, visit frequency) are left alone.
    db.prepare(`
      UPDATE customers SET name = ?, contact_name = COALESCE(?, contact_name), phone = COALESCE(?, phone),
        email = COALESCE(?, email), address = COALESCE(?, address), city = COALESCE(?, city),
        credit_limit = ?, balance = ?, payment_terms = COALESCE(?, payment_terms),
        status = CASE WHEN status = 'closed' THEN 'closed' ELSE ? END
      WHERE id = ?
    `).run(row.name, row.contact_name, row.phone, row.email, row.address, row.city,
      row.credit_limit ?? 0, row.balance ?? 0, row.payment_terms, onHoldStatus, existing.id);
  } else {
    db.prepare(`
      INSERT INTO customers (code, name, contact_name, phone, email, address, city, credit_limit, balance, payment_terms, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.code, row.name, row.contact_name || null, row.phone || null, row.email || null,
      row.address || null, row.city || null, row.credit_limit ?? 0, row.balance ?? 0,
      row.payment_terms || '30 days', onHoldStatus);
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
  const existing = db.prepare('SELECT id FROM products WHERE code = ?').get(row.code);
  if (existing) {
    db.prepare(`
      UPDATE products SET name = ?, category_id = COALESCE(?, category_id), description = COALESCE(?, description),
        uom = COALESCE(?, uom), pack_size = COALESCE(?, pack_size), list_price = ?, cost_price = COALESCE(?, cost_price)
      WHERE id = ?
    `).run(row.name, categoryId, row.description, row.uom, row.pack_size, row.list_price ?? 0, row.cost_price, existing.id);
  } else {
    db.prepare(`
      INSERT INTO products (code, name, category_id, description, uom, pack_size, list_price, cost_price, stock_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(row.code, row.name, categoryId, row.description || null, row.uom || 'each',
      row.pack_size || null, row.list_price ?? 0, row.cost_price ?? 0);
  }
};

const upsertStock = (row) => {
  const result = db.prepare('UPDATE products SET stock_qty = ? WHERE code = ?').run(row.qty_available ?? 0, row.code);
  if (result.changes === 0) throw new Error(`Stock row for unknown product code ${row.code}`);
};

const upsertPrice = (row) => {
  const customer = db.prepare('SELECT id FROM customers WHERE code = ?').get(row.customer_code);
  const product = db.prepare('SELECT id FROM products WHERE code = ?').get(row.product_code);
  if (!customer || !product) throw new Error(`Price row references unknown ${!customer ? 'customer ' + row.customer_code : 'product ' + row.product_code}`);
  db.prepare(`
    INSERT INTO customer_prices (customer_id, product_id, price) VALUES (?, ?, ?)
    ON CONFLICT(customer_id, product_id) DO UPDATE SET price = excluded.price
  `).run(customer.id, product.id, row.price);
};

const UPSERTERS = { customers: upsertCustomer, products: upsertProduct, stock: upsertStock, prices: upsertPrice };

// Order matters: prices reference customers and products.
export const SYNC_ENTITIES = ['customers', 'products', 'stock', 'prices'];

export async function runSync(entity) {
  if (!UPSERTERS[entity]) throw new Error(`Unknown sync entity: ${entity}`);
  const source = getSetting('intg_source', 'demo');
  const runId = db.prepare('INSERT INTO sync_runs (source, entity) VALUES (?, ?)').run(source, entity).lastInsertRowid;
  try {
    const rows = await getProvider().fetch(entity);
    let upserted = 0;
    const errors = [];
    for (const row of rows) {
      try {
        UPSERTERS[entity](row);
        upserted += 1;
      } catch (e) {
        errors.push(e.message);
      }
    }
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
  }
}
