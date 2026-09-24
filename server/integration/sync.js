// Sync engine: pulls canonical rows from the active provider and upserts them
// into the app's tables, keyed on customer code / product (stock) code.
// Every run is recorded in sync_runs.
import { dbx, packWeightKg, getTodayISO } from '../db.js';
import { getSetting } from '../dbh.js';
import { getProvider } from './providers.js';

// Every upserter takes (row, conn): conn is the transaction handle the row is
// written in (or dbx itself).
const upsertWarehouse = (row, conn) =>
  conn.upsert('warehouses', { keys: { code: row.code }, set: { name: row.name } });

// Match a customer to a rep using warehouse code + rep code.
// Rep codes aren't globally unique - the same code means different people
// under different branches. SYSPRO uses Branch+Salesperson as the key.
// Both sides are trimmed before comparing. SYSPRO's Branch and Salesperson are
// fixed-width `char` columns, so they arrive space-padded ('24  '), while
// import-reps.js trims rep_code/branch on the way in - so RouteOne holds '24'
// and a bare `=` never matches. Every other SYSPRO view in docs/sql RTRIMs its
// columns; vw_FS_RepSalesByMonth does not, which is why its sync was skipping
// ~51% of rows (run 7233: 5922 read, 2891 upserted, 3031 skipped) and a skipped
// row's NSV is dropped rather than credited to anyone - understating every
// rep's monthly sales. Normalising here rather than only in the view means
// RouteOne is not at the mercy of what a DBA-owned view happens to return.
//
// Trimming can only ever add matches, never remove one: two distinct codes
// would have to differ by whitespace alone to collide.
export const matchRep = async (warehouseCode, repCode, conn = dbx) => {
  const branch = String(warehouseCode ?? '').trim();
  const code = String(repCode ?? '').trim();
  if (!branch || !code) return null;
  const rep = await conn.prepare(`
    SELECT u.id FROM users u
    JOIN roles r ON r.id = u.role_id
    JOIN warehouses w ON w.id = u.warehouse_id
    WHERE r.name = 'rep' AND u.active = 1
      AND TRIM(u.rep_code) = ? AND TRIM(w.code) = ?
  `).get(code, branch);
  return rep?.id ?? null;
};

// Some customers reference a branch code that's missing from vw_FS_Warehouses
// (e.g. branch 30) - rather than dropping those customers from every sync, a
// placeholder warehouse is created for the code. If the view is later fixed
// to include it, the next warehouses sync just updates this stub's name.
const warehouseForCode = async (code, conn) => {
  if (!code) return null;
  let warehouse = await conn.prepare('SELECT id FROM warehouses WHERE code = ?').get(code);
  if (!warehouse) {
    const info = await conn.prepare('INSERT INTO warehouses (code, name) VALUES (?, ?)').run(code, `Branch ${code} (unmapped)`);
    warehouse = { id: info.lastInsertRowid };
  }
  return warehouse;
};

const upsertCustomer = async (row, conn) => {
  const existing = await conn.prepare('SELECT id FROM customers WHERE code = ?').get(row.code);
  const onHoldStatus = row.on_hold ? 'on_hold' : 'active';
  const warehouse = await warehouseForCode(row.warehouse_code, conn);
  const repId = await matchRep(row.warehouse_code, row.rep_code, conn);
  if (existing) {
    // ERP is the master for financial fields AND for rep ownership - a customer
    // reassigned in SYSPRO follows on the next sync, so the old rep stops seeing
    // it. Territory, grading, GPS and visit frequency stay app-managed.
    //
    // rep_id uses COALESCE deliberately: matchRep returns null when the rep code
    // has no user (house/export accounts) or the customer sits outside its rep's
    // home branch. Assigning that null would un-assign customers that are
    // currently matched, so a failed match leaves the existing rep in place.
    await conn.prepare(`
      UPDATE customers SET name = ?, contact_name = COALESCE(?, contact_name), phone = COALESCE(?, phone),
        email = COALESCE(?, email), address = COALESCE(?, address), city = COALESCE(?, city),
        ship_to_name = COALESCE(?, ship_to_name), ship_to_address = COALESCE(?, ship_to_address),
        ship_to_city = COALESCE(?, ship_to_city), ship_to_postcode = COALESCE(?, ship_to_postcode),
        credit_limit = ?, balance = ?, payment_terms = COALESCE(?, payment_terms),
        warehouse_id = COALESCE(?, warehouse_id),
        rep_id = COALESCE(?, rep_id),
        status = CASE WHEN status = 'closed' THEN 'closed' ELSE ? END
      WHERE id = ?
    `).run(row.name, row.contact_name, row.phone, row.email, row.address, row.city,
      row.ship_to_name, row.ship_to_address, row.ship_to_city, row.ship_to_postcode,
      row.credit_limit ?? 0, row.balance ?? 0, row.payment_terms, warehouse?.id ?? null,
      repId, onHoldStatus, existing.id);
  } else {
    // A brand-new customer is auto-assigned to its matching rep on first sync.
    await conn.prepare(`
      INSERT INTO customers (code, name, contact_name, phone, email, address, city, ship_to_name, ship_to_address, ship_to_city, ship_to_postcode, credit_limit, balance, payment_terms, warehouse_id, status, rep_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.code, row.name, row.contact_name || null, row.phone || null, row.email || null,
      row.address || null, row.city || null, row.ship_to_name || null, row.ship_to_address || null,
      row.ship_to_city || null, row.ship_to_postcode || null, row.credit_limit ?? 0, row.balance ?? 0,
      row.payment_terms || '30 days', warehouse?.id ?? null, onHoldStatus, repId);
  }
};

const upsertProduct = async (row, conn) => {
  let categoryId = null;
  if (row.category) {
    const cat = await conn.prepare('SELECT id FROM product_categories WHERE name = ?').get(row.category);
    categoryId = cat
      ? cat.id
      : (await conn.prepare('INSERT INTO product_categories (name) VALUES (?)').run(row.category)).lastInsertRowid;
  }
  const packWeight = packWeightKg(row.pack_size);
  // Null (not 1.0) when the view predates ConvFactAltUom - COALESCE below then
  // keeps any existing value, and productUnitPrice falls back to pack_weight_kg.
  const convFactorAltUom = row.conv_factor_alt_uom ?? null;
  // SYSPRO's Discontinued flag drives BOTH columns: `discontinued` is what the
  // UI badges in red, `active` is what actually blocks ordering (orders and
  // quotes both resolve line items with "WHERE id = ? AND active = 1", so the
  // rule holds server-side even if a client ignores the badge).
  //
  // Both are assigned unconditionally rather than via COALESCE: a product that
  // comes OFF discontinued in SYSPRO has to become orderable again on the next
  // sync, and COALESCE would strand it at active = 0 forever.
  const discontinued = row.discontinued ? 1 : 0;
  const existing = await conn.prepare('SELECT id FROM products WHERE code = ?').get(row.code);
  if (existing) {
    await conn.prepare(`
      UPDATE products SET name = ?, category_id = COALESCE(?, category_id), description = COALESCE(?, description),
        uom = COALESCE(?, uom), pack_size = COALESCE(?, pack_size), pack_weight_kg = COALESCE(?, pack_weight_kg),
        conv_factor_alt_uom = COALESCE(?, conv_factor_alt_uom), list_price = ?, cost_price = COALESCE(?, cost_price),
        discontinued = ?, active = ?
      WHERE id = ?
    `).run(row.name, categoryId, row.description, row.uom, row.pack_size, packWeight, convFactorAltUom, row.list_price ?? 0, row.cost_price,
      discontinued, discontinued ? 0 : 1, existing.id);
  } else {
    await conn.prepare(`
      INSERT INTO products (code, name, category_id, description, uom, pack_size, pack_weight_kg, conv_factor_alt_uom, list_price, cost_price, stock_qty, discontinued, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(row.code, row.name, categoryId, row.description || null, row.uom || 'each',
      row.pack_size || null, packWeight, convFactorAltUom, row.list_price ?? 0, row.cost_price ?? 0,
      discontinued, discontinued ? 0 : 1);
  }
};

// Stock arrives one row per (product, branch) so the Products page can show a
// per-warehouse breakdown; products.stock_qty is kept as the summed total for
// code that only needs a single number (order capture, low-stock warnings).
const upsertStock = async (row, conn) => {
  const product = await conn.prepare('SELECT id FROM products WHERE code = ?').get(row.code);
  if (!product) throw new Error(`Stock row for unknown product code ${row.code}`);
  const warehouse = await warehouseForCode(row.warehouse_code, conn);
  if (warehouse) {
    await conn.upsert('product_stock', {
      keys: { product_id: product.id, warehouse_id: warehouse.id },
      set: { qty_available: row.qty_available ?? 0 }
    });
  }
  const total = (await conn.prepare('SELECT COALESCE(SUM(qty_available), 0) AS total FROM product_stock WHERE product_id = ?').get(product.id)).total;
  await conn.prepare('UPDATE products SET stock_qty = ? WHERE id = ?').run(total, product.id);
};

const upsertInvoice = async (row, conn) => {
  const customer = await conn.prepare('SELECT id FROM customers WHERE code = ?').get(row.customer_code);
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
  await conn.upsert('invoices', {
    keys: { number: row.number },
    set: {
      customer_id: customer?.id ?? null, customer_code: row.customer_code,
      order_number: row.order_number || null, invoice_date: row.invoice_date,
      due_date: row.due_date || null, subtotal, vat_amount: vat,
      total, amount_paid: paid, balance, status
    }
  });
};

// Convert Date objects from SQL Server to ISO strings, coerce all values to safe types
const toSafeValue = (v) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().split('T')[0]; // YYYY-MM-DD
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v); // fallback: stringify anything else
};

// customer_pricing is millions of rows. On SQL Server it is loaded with
// dbx.bulkUpsert (staging table + set-based apply) instead of one upsert per
// row - see BULK_UPSERT. SQLite has no bulkUpsert and keeps the per-row path.
const PRICING_COLUMNS = [
  { name: 'customer_code', type: 'nvarchar(20)' },
  { name: 'product_code', type: 'nvarchar(20)' },
  { name: 'contract_price', type: 'float' },
  { name: 'buying_group_price', type: 'float' },
  { name: 'price_code_price', type: 'float' },
  { name: 'contract_start_date', type: 'nvarchar(10)' },
  { name: 'contract_end_date', type: 'nvarchar(10)' },
  { name: 'buying_group_start_date', type: 'nvarchar(10)' },
  { name: 'buying_group_end_date', type: 'nvarchar(10)' }
];

const toBulkNumber = (v) => {
  const x = toSafeValue(v);
  if (x === null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

// Same coercion as upsertCustomerPricing, shaped for the staging table.
// Returns null for a row with no usable key (counted as skipped).
const pricingBulkRow = (row) => {
  const customer_code = toSafeValue(row.customer_code);
  const product_code = toSafeValue(row.product_code);
  if (customer_code == null || product_code == null) return null;
  return {
    customer_code: String(customer_code), product_code: String(product_code),
    contract_price: toBulkNumber(row.contract_price),
    buying_group_price: toBulkNumber(row.buying_group_price),
    price_code_price: toBulkNumber(row.price_code_price),
    contract_start_date: toSafeValue(row.contract_start_date),
    contract_end_date: toSafeValue(row.contract_end_date),
    buying_group_start_date: toSafeValue(row.buying_group_start_date),
    buying_group_end_date: toSafeValue(row.buying_group_end_date)
  };
};

const BULK_UPSERT = {
  customer_pricing: {
    table: 'syspro_customer_pricing',
    columns: PRICING_COLUMNS,
    keys: ['customer_code', 'product_code'],
    now: ['synced_at'],
    mapRow: pricingBulkRow
  }
};

const upsertCustomerPricing = (row, conn) => {
  return conn.upsert('syspro_customer_pricing', {
    keys: { customer_code: toSafeValue(row.customer_code), product_code: toSafeValue(row.product_code) },
    set: {
      contract_price: toSafeValue(row.contract_price),
      buying_group_price: toSafeValue(row.buying_group_price),
      price_code_price: toSafeValue(row.price_code_price),
      contract_start_date: toSafeValue(row.contract_start_date),
      contract_end_date: toSafeValue(row.contract_end_date),
      buying_group_start_date: toSafeValue(row.buying_group_start_date),
      buying_group_end_date: toSafeValue(row.buying_group_end_date)
    },
    now: ['synced_at']
  });
};

// vw_FS_RepSalesByMonth gives one row per (year, month, branch, rep) - the
// same rep code can appear under several branches, and a rep's actual sales
// can be split across branches too, so rows are summed into a single
// per-rep-per-month total using matchRep's branch+code disambiguation (same
// rule customer sync already uses to resolve a rep code to a specific user).
// A row with no matching rep (house/export codes, etc.) is skipped, not an error.
//
// Uses CustomerBranch (the branch the "Customer SalesPerson" code actually
// belongs to), not TrnBranch (the transaction's branch) - a customer can be
// invoiced from a different branch than their own, and matchRep needs the
// branch paired with the salesperson code it was assigned under.
// Returns false (not undefined) when a row is deliberately skipped - lets
// runSync count "skipped, no match" separately from "matched and written"
// instead of both silently counting as a plain success.
const upsertRepSales = async (row, conn) => {
  const repId = await matchRep(row.CustomerBranch, row['Customer SalesPerson'], conn);
  if (!repId) return false;
  const year = row.TrnYear;
  const month = row.TrnMonth;
  if (!year || !month) return false;
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const salesValue = Number(row.NSV ?? 0);
  await conn.upsert('rep_monthly_sales', {
    keys: { rep_id: repId, month: monthKey },
    add: { sales_value: salesValue },
    now: ['synced_at']
  });
};

// Customer sales per month, ex-VAT, from vw_FS_CustomerSalesByMonth. Keyed on
// the customer CODE, not id: a code with no matching synced customer is still
// worth keeping (the customer may sync later), and dropping it would silently
// understate that account. Rows accumulate by SUM within a run, so the table is
// wiped first - see CLEAR_BEFORE_SYNC, same pattern as rep_monthly_sales.
const upsertCustomerSales = async (row, conn) => {
  const code = String(row.customer_code ?? '').trim();
  const year = row.trn_year;
  const month = row.trn_month;
  if (!code || !year || !month) return false;
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  await conn.upsert('customer_monthly_sales', {
    keys: { customer_code: code, month: monthKey },
    add: { sales_value: Number(row.nsv ?? 0) },
    now: ['synced_at']
  });
};

// vw_FS_InvoiceLines has no stable per-line natural key (the same product can
// appear on more than one line of an invoice - confirmed against live data),
// so this table is fully wiped and rebuilt each run (see CLEAR_BEFORE_SYNC)
// rather than upserted. A row whose invoice isn't synced yet (outside the
// header view's own window, or a sync-order hiccup) is skipped, not an error.
// Code -> customers.id, memoised for the duration of one sync run. The lines
// view is ~285k rows over 90 days and the same store repeats across many of
// them, so a per-row lookup would be a quarter-million redundant queries.
// Cleared at the start of each run (see CLEAR_BEFORE_SYNC) so a customer synced
// later in the day is picked up rather than cached as missing forever.
let deliveryCustomerCache = new Map();
const deliveryCustomerId = async (code, conn) => {
  if (!code) return null;
  if (deliveryCustomerCache.has(code)) return deliveryCustomerCache.get(code);
  const id = (await conn.prepare('SELECT id FROM customers WHERE code = ?').get(code))?.id ?? null;
  deliveryCustomerCache.set(code, id);
  return id;
};

// dbx caches prepared statements by SQL text, so these are parsed once however
// many times this runs (~270k times per invoice_lines sync, inside one atomic
// transaction - preparing per row once stretched that to a 57-68s freeze on
// production).
const upsertInvoiceLine = async (row, conn) => {
  const invoice = await conn.prepare('SELECT id FROM invoices WHERE number = ?').get(row.invoice_number);
  if (!invoice) return false;
  const product = await conn.prepare('SELECT id FROM products WHERE code = ?').get(row.product_code);
  // The store the goods went to. Under central billing this differs from the
  // invoice's own customer (PICK N PAY RETAILERS billed, OAKDENE delivered) and
  // it is what the rep is actually assigned to - see invoices.routes.js.
  // Null when the view predates the column, or the store was never synced as a
  // customer; scoping then falls back to the billed customer alone, i.e. the
  // behaviour before this change.
  const deliveryCode = row.delivery_customer_code ?? null;
  await conn.prepare(`
    INSERT INTO invoice_items (invoice_id, product_id, product_code, delivery_customer_id, delivery_customer_code, qty, unit_price, line_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(invoice.id, product?.id ?? null, row.product_code,
    await deliveryCustomerId(deliveryCode, conn), deliveryCode,
    row.qty ?? 0, row.unit_price ?? 0, row.line_total ?? 0);
};

const UPSERTERS = { warehouses: upsertWarehouse, customers: upsertCustomer, products: upsertProduct, stock: upsertStock, invoices: upsertInvoice, invoice_lines: upsertInvoiceLine, customer_pricing: upsertCustomerPricing, rep_sales: upsertRepSales, customer_sales: upsertCustomerSales };

// Entities whose upserter accumulates (SUM) or has no natural key to upsert
// on must clear their destination table before each run - otherwise
// re-syncing would keep adding to the same rep-month total, or duplicating
// invoice lines, instead of recomputing from scratch.
const CLEAR_BEFORE_SYNC = {
  rep_sales: (conn) => conn.prepare('DELETE FROM rep_monthly_sales').run(),
  customer_sales: (conn) => conn.prepare('DELETE FROM customer_monthly_sales').run(),
  invoice_lines: async (conn) => {
    await conn.prepare('DELETE FROM invoice_items').run();
    deliveryCustomerCache = new Map();  // don't carry stale "not found" entries between runs
  }
};

// Entities worth sorting before upsert, keyed by their destination table's
// primary key column pair - see the comment above where this is used in
// runSync. Only customer_pricing is large enough for random-order upserts to
// matter; every other entity is small enough (thousands of rows, not
// millions) that a sort would just add overhead for no measurable gain.
const SORT_KEYS = {
  customer_pricing: ['customer_code', 'product_code']
};

// Order matters: customers reference warehouses; customer_pricing and invoices reference customers (and products).
// invoice_lines must come after invoices (resolves invoice_number -> invoice_id).
// Rep-to-warehouse assignment is managed manually in RouteOne (SalSalesperson branch data is
// unreliable - the same rep code can show multiple conflicting branches), so "reps" is not synced here.
export const SYNC_ENTITIES = ['warehouses', 'customers', 'products', 'stock', 'invoices', 'invoice_lines', 'customer_pricing', 'rep_sales', 'customer_sales'];
const syncsInFlight = new Set();

// Rows are committed in batches of this size, yielding to the event loop
// between batches (see runSync). Measured on this exact path - 300k rows
// through runSync/upsertCustomerPricing - with a 50ms timer probing how often
// the event loop got a turn:
//
//   batch     total     worst stall   loop turns during the run
//   single    9.4s      (blocked)     2      <- the bug: loop is dead throughout
//   1 000     12.7s     246ms         149
//   2 000     12.3s     270ms         138
//   5 000     11.9s     436ms          61
//   20 000    9.8s      1034ms         16
//
// Note how little throughput the small batches actually cost: 2k is 31% slower
// than one big transaction, but the loop gets 138 turns instead of 2. The real
// per-row work (value coercion, a 9-column upsert) dominates, so commit
// overhead barely registers - which makes a small batch close to free. Total
// time matters little now that this runs nightly; responsiveness is the point.
//
// Per-row cost is higher on the production box (1.2GB DB, slower shared disk),
// so expect a larger stall there - tune it down via env without a redeploy if
// the [sync] timings show it is still too coarse.
const BATCH_SIZE = Number(process.env.SYNC_BATCH_SIZE) || 2000;

// `provider` is injectable for tests; production callers use the configured one.
export async function runSync(entity, { provider = null } = {}) {
  if (!UPSERTERS[entity]) throw new Error(`Unknown sync entity: ${entity}`);
  if (syncsInFlight.has(entity)) throw new Error(`${entity} sync is already running`);
  const source = await getSetting('intg_source', 'demo');
  const runId = (await dbx.prepare('INSERT INTO sync_runs (source, entity) VALUES (?, ?)').run(source, entity)).lastInsertRowid;
  syncsInFlight.add(entity);
  try {
    const fetchStart = Date.now();
    const rows = await (provider ?? getProvider()).fetch(entity);
    const fetchMs = Date.now() - fetchStart;
    // customer_pricing arrives in SYSPRO view order, which has no relation to
    // its (customer_code, product_code) primary key - upserting 4.47M rows in
    // that order means each one likely lands on a different, uncached B-tree
    // page. Sorting first turns that into a sequential scan through the
    // index instead, so cache_size (see db.js) actually gets reused across
    // consecutive rows rather than thrashing. Cheap relative to the write it
    // is fixing: a JS sort of ~4.5M plain objects is seconds, not minutes.
    if (SORT_KEYS[entity]) {
      const [keyA, keyB] = SORT_KEYS[entity];
      rows.sort((a, b) => {
        const c = String(a[keyA]).localeCompare(String(b[keyA]));
        return c !== 0 ? c : String(a[keyB]).localeCompare(String(b[keyB]));
      });
    }
    const writeStart = Date.now();
    let upserted = 0;
    let skipped = 0;
    const errors = [];

    const applyRow = async (row, conn) => {
      try {
        // An upserter returning false means "deliberately skipped, not an
        // error" (e.g. rep_sales rows with no matching rep) - counted
        // separately so a sync full of silent skips doesn't read as success.
        if (await UPSERTERS[entity](row, conn) === false) skipped += 1;
        else upserted += 1;
      } catch (e) {
        errors.push(e.message);
      }
    };

    // Row writes must be batched into transactions - committing each row
    // individually is what made the multi-million-row customer_pricing sync
    // take over an hour. But better-sqlite3 is synchronous, so wrapping the
    // WHOLE run in one transaction blocked the event loop for ~20 minutes a
    // run: the API served nothing (reps saw an endless spinner) and the health
    // check timed out every hour. So: batch, then hand control back to the
    // event loop between batches.
    //
    // The trade-off is that a batched run is no longer atomic. That is safe
    // for the plain upsert entities - they mirror SYSPRO and every upsert is
    // idempotent, so a run that dies halfway just leaves a mix of fresh and
    // stale rows that the next run reconciles. Entities that CLEAR first are
    // not safe that way: the table is emptied before it is repopulated, so a
    // reader mid-run would see missing or half-summed totals. Those stay in a
    // single atomic transaction - they are small enough (thousands of rows,
    // not millions) that the blocking window is short.
    if (CLEAR_BEFORE_SYNC[entity]) {
      await dbx.transaction(async (tx) => {
        await CLEAR_BEFORE_SYNC[entity](tx);
        for (const row of rows) await applyRow(row, tx);
      });
    } else if (BULK_UPSERT[entity] && dbx.bulkUpsert) {
      const { mapRow, ...spec } = BULK_UPSERT[entity];
      const bulkRows = [];
      for (const row of rows) {
        const mapped = mapRow(row);
        if (mapped) bulkRows.push(mapped);
        else skipped += 1;
      }
      const { inserted, updated } = await dbx.bulkUpsert(spec.table, { ...spec, rows: bulkRows });
      // "upserted" means read and applied. Unchanged rows are deliberately not
      // rewritten (see dbx.bulkUpsert), so the split is logged, not reported.
      upserted = bulkRows.length;
      console.log(`[sync] ${entity}: ${inserted} inserted, ${updated} changed, ${bulkRows.length - inserted - updated} unchanged`);
    } else {
      // Indices rather than array slices - avoids copying batches out of a
      // list that is already several million rows on this path.
      for (let start = 0; start < rows.length; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE, rows.length);
        await dbx.transaction(async (tx) => {
          for (let i = start; i < end; i++) await applyRow(rows[i], tx);
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const writeMs = Date.now() - writeStart;
    await dbx.prepare(`
      UPDATE sync_runs SET status = 'completed', rows_read = ?, rows_upserted = ?, rows_skipped = ?, error = ?, finished_at = ${dbx.nowSql}
      WHERE id = ?
    `).run(rows.length, upserted, skipped, errors.length ? errors.slice(0, 10).join('; ') : null, runId);
    // Split fetch vs write so a slow run can be attributed without guesswork -
    // pulling millions of rows out of SYSPRO and writing them to SQLite are
    // very different problems with very different fixes.
    console.log(`[sync] ${entity}: ${rows.length} rows — fetch ${(fetchMs / 1000).toFixed(1)}s, write ${(writeMs / 1000).toFixed(1)}s`);
    return { run_id: runId, entity, rows_read: rows.length, rows_upserted: upserted, rows_skipped: skipped, row_errors: errors.length, fetch_ms: fetchMs, write_ms: writeMs };
  } catch (e) {
    await dbx.prepare(`
      UPDATE sync_runs SET status = 'failed', error = ?, finished_at = ${dbx.nowSql} WHERE id = ?
    `).run(e.message, runId);
    throw e;
  } finally {
    syncsInFlight.delete(entity);
  }
}
