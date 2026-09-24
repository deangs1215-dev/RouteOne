import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createSqliteDbx, createMssqlDbx } from './dbx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configuredPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'data', 'fieldsales.db');
const dataDir = path.dirname(configuredPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

export const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const DB_PATH = configuredPath;
export const db = new Database(configuredPath);

// Releases the file lock on the live database - only ever used right before a
// restore replaces the file wholesale, followed immediately by process exit
// (see backup.js). Anything else querying `db` after this call will throw.
export function closeDb() {
  db.close();
}
// Tuning for many concurrent reps hitting a single SQLite file:
db.pragma('journal_mode = WAL');       // concurrent readers while one writer commits
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');     // safe with WAL, much faster writes
db.pragma('busy_timeout = 5000');      // wait (not error) if the DB is briefly write-locked
// 256MB - was 20MB, which couldn't hold syspro_customer_pricing (4.47M rows)
// plus its primary-key index. Rows arrive from SYSPRO in view order, not
// primary-key order, so upserting them was a mostly-random-access pattern
// against that table; with the working set far bigger than the cache, nearly
// every upsert faulted out to disk. Measured on production: 4.47M rows took
// 80 minutes to write (see [sync] log lines) against a sub-2-minute fetch -
// that gap is this, not the write batching (already tuned - see BATCH_SIZE in
// sync.js). Paired with sorting rows before upsert in runSync.
db.pragma('cache_size = -262144');
db.pragma('mmap_size = 268435456');    // 256MB memory-mapped I/O for faster reads
db.pragma('wal_autocheckpoint = 1000');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Column migrations for databases created before Phase 3 (CREATE TABLE IF NOT
// EXISTS won't add columns to an existing table).
for (const stmt of [
  'ALTER TABLE visits ADD COLUMN route_order INTEGER',
  'ALTER TABLE visits ADD COLUMN check_in_distance_m REAL',
  'ALTER TABLE users ADD COLUMN customer_id INTEGER REFERENCES customers(id)', // portal logins
  'ALTER TABLE users ADD COLUMN home_address TEXT',
  'ALTER TABLE users ADD COLUMN home_lat REAL',
  'ALTER TABLE users ADD COLUMN home_lng REAL',
  'ALTER TABLE customers ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id)',
  'ALTER TABLE orders ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id)',
  "ALTER TABLE form_templates ADD COLUMN category TEXT DEFAULT 'general'",
  'ALTER TABLE users ADD COLUMN rep_code TEXT',
  'ALTER TABLE users ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id)',
  'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE products ADD COLUMN pack_weight_kg REAL',
  'ALTER TABLE products ADD COLUMN conv_factor_alt_uom REAL',
  'ALTER TABLE products ADD COLUMN discontinued INTEGER DEFAULT 0',
  // The customer's own PO / reference for an order - see orders in schema.sql.
  'ALTER TABLE orders ADD COLUMN customer_order_no TEXT',
  // Delivery store on an invoice line - differs from the invoice's billed
  // customer under central/head-office billing. See invoices.routes.js.
  'ALTER TABLE invoice_items ADD COLUMN delivery_customer_id INTEGER REFERENCES customers(id)',
  'ALTER TABLE invoice_items ADD COLUMN delivery_customer_code TEXT',
  'CREATE INDEX IF NOT EXISTS idx_invoice_items_delivery_customer ON invoice_items(delivery_customer_id)',
  "ALTER TABLE visits ADD COLUMN check_in_type TEXT DEFAULT 'onsite'",
  'ALTER TABLE visits ADD COLUMN check_in_address TEXT',
  'ALTER TABLE orders ADD COLUMN signature TEXT',
  // Rep-captured onsite details (used when SYSPRO's info is wrong).
  'ALTER TABLE customers ADD COLUMN onsite_name TEXT',
  'ALTER TABLE customers ADD COLUMN onsite_phone TEXT',
  'ALTER TABLE customers ADD COLUMN onsite_address TEXT',
  'ALTER TABLE customers ADD COLUMN onsite_lat REAL',
  'ALTER TABLE customers ADD COLUMN onsite_lng REAL',
  'ALTER TABLE customers ADD COLUMN onsite_contact TEXT',
  'ALTER TABLE customers ADD COLUMN onsite_cell TEXT',
  'ALTER TABLE customers ADD COLUMN onsite_pricelist TEXT',
  'ALTER TABLE customers ADD COLUMN onsite_vat TEXT',
  // Contract / buying-group pricing validity dates (for date-based expiry).
  'ALTER TABLE syspro_customer_pricing ADD COLUMN contract_start_date TEXT',
  'ALTER TABLE syspro_customer_pricing ADD COLUMN contract_end_date TEXT',
  'ALTER TABLE syspro_customer_pricing ADD COLUMN buying_group_start_date TEXT',
  'ALTER TABLE syspro_customer_pricing ADD COLUMN buying_group_end_date TEXT',
  'ALTER TABLE form_templates ADD COLUMN notify_email TEXT',
  'ALTER TABLE users ADD COLUMN documents_last_viewed_at TEXT',
  'ALTER TABLE users ADD COLUMN reset_token_hash TEXT',
  'ALTER TABLE users ADD COLUMN reset_token_expires TEXT',
  // Bumped whenever a password changes, and carried in the JWT - see signToken
  // in auth.js. Invalidates every session issued before the change, so a stolen
  // token dies with the password reset rather than outliving it by 12 hours.
  'ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sync_runs ADD COLUMN rows_skipped INTEGER DEFAULT 0',
  // Existing rows predate the Orders/Technical split - they were all Orders
  // recipients (the only list that existed), so the default is correct for them.
  "ALTER TABLE email_recipients ADD COLUMN category TEXT NOT NULL DEFAULT 'orders'",
  // R1-044: which pricing tier produced a line's unit_price (see PRICE_SOURCES
  // below) - stored at submit time so "why is this price what it is" can
  // still be answered on an already-submitted order/quote, not just live in
  // the builder. NULL on rows created before this column existed.
  'ALTER TABLE order_items ADD COLUMN price_source TEXT',
  'ALTER TABLE quote_items ADD COLUMN price_source TEXT',
  // Branch-scoped order email recipients - NULL means "every branch" (kept
  // for any existing recipient not yet assigned to one, and for a genuinely
  // company-wide address like a general manager).
  'ALTER TABLE email_recipients ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id)',
  // Ship-to address fields from SYSPRO ARCustomer
  'ALTER TABLE customers ADD COLUMN ship_to_name TEXT',
  'ALTER TABLE customers ADD COLUMN ship_to_address TEXT',
  'ALTER TABLE customers ADD COLUMN ship_to_city TEXT',
  'ALTER TABLE customers ADD COLUMN ship_to_postcode TEXT',
  // Covering index for products.routes.js's "all pricing for this customer"
  // lookup (WHERE customer_code = ?, the /products/for-customer/:id hot path
  // reps hit on every order/quote capture). syspro_customer_pricing is a
  // ~13M-row table; its PRIMARY KEY(customer_code, product_code) is a plain
  // (non-WITHOUT ROWID) index, so a SELECT * against it does one extra
  // random-access rowid lookup per matched row - scattered across a 1GB+
  // table, that alone measured ~340ms cold-cache for one customer. Naming
  // every selected column here lets SQLite satisfy the query straight from
  // the index (COVERING INDEX in EXPLAIN QUERY PLAN, no rowid lookup at all)
  // - measured ~1ms with this index in place. One-time build cost is the
  // trade-off: expect it to take a while (tens of seconds locally; longer on
  // a slower disk) the first time this runs against an existing 13M-row table.
  `CREATE INDEX IF NOT EXISTS idx_pricing_customer_covering ON syspro_customer_pricing(
    customer_code, product_code, contract_price, buying_group_price, price_code_price,
    contract_start_date, contract_end_date, buying_group_start_date, buying_group_end_date
  )`
]) {
  try { db.exec(stmt); } catch { /* column already exists */ }
}

// Existing installations predate mandatory password changes. Mark every active
// account once so known bootstrap passwords cannot remain in production.
try {
  const migrated = db.prepare("SELECT value FROM settings WHERE key = 'security_force_password_change_v1'").get();
  if (!migrated) {
    db.prepare('UPDATE users SET must_change_password = 1 WHERE active = 1').run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('security_force_password_change_v1', '1')").run();
  }
} catch { /* fresh databases may not have users yet */ }

// Backfill invoice totals: SYSPRO's InvoiceValue sometimes synced as 0 even
// when subtotal + VAT were populated, leaving customer views showing R0. The
// gross is always subtotal + VAT, so repair the total for those rows. Balance
// and status are left alone - they depend on payment data we can't re-derive.
try {
  db.exec(`
    UPDATE invoices
    SET total = ROUND(subtotal + vat_amount, 2)
    WHERE (total IS NULL OR total = 0) AND (subtotal + vat_amount) > 0
  `);
} catch { /* invoices table may not exist yet on a fresh db */ }

// Async facade over the database - see dbx.js. New/migrated code should use
// `await dbx.prepare(...)` instead of the synchronous `db` above, so the backend
// can move from SQLite to SQL Server (DB_BACKEND=mssql) one caller at a time.
// `dbx` is a live binding: initDb() swaps it to the SQL Server backend.
export let dbx = createSqliteDbx(db);

// Call once at startup, before serving requests. A no-op on SQLite. On SQL
// Server it opens the connection pool. NOTE: do not enable DB_BACKEND=mssql
// until every caller of the synchronous `db` (including the helpers below)
// has moved to dbx - they still read the SQLite file.
export async function initDb() {
  if ((process.env.DB_BACKEND || 'sqlite').toLowerCase() !== 'mssql') return;
  const { default: sql } = await import('mssql');
  const pool = await new sql.ConnectionPool({
    server: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 1433,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    pool: { max: Number(process.env.DB_POOL_MAX) || 10, min: 0, idleTimeoutMillis: 30000 },
    options: { encrypt: process.env.DB_ENCRYPT === '1', trustServerCertificate: true }
  }).connect();
  dbx = createMssqlDbx(pool, sql);
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Sequential document numbers: ORD-00042, CUS-00007 ...
export function nextNumber(prefix) {
  const key = `counter_${prefix}`;
  const n = parseInt(getSetting(key, '0'), 10) + 1;
  setSetting(key, n);
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

// A rep's sales target for a given month (1-12): the rep_budgets figure for
// that month if the admin has set one, otherwise the flat sales_target on the
// user record as a fallback. Everywhere "this rep's target" is shown should
// go through this so the figure automatically rolls to the next month's
// budget as the calendar date changes, rather than needing a manual update.
export function repMonthTarget(repId, month) {
  const row = db.prepare('SELECT budget FROM rep_budgets WHERE rep_id = ? AND month = ?').get(repId, month);
  if (row) return row.budget;
  const user = db.prepare('SELECT sales_target FROM users WHERE id = ?').get(repId);
  return user?.sales_target || 0;
}

export function logActivity(userId, action, entityType, entityId, detail = null) {
  db.prepare(
    'INSERT INTO activity_log (user_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(userId ?? null, action, entityType, entityId ?? null, detail ? JSON.stringify(detail) : null);
}

export const VAT_RATE = 0.15;

// R1-028: 2-decimal-place monetary rounding, shared by every money calculation
// (order/quote line totals, VAT, price breaks) so the whole app rounds the
// same way in one place instead of several independently-drifting copies.
//
// Plain `Math.round(n * 100) / 100` misrounds at exact half-cent boundaries
// because those values cannot be represented exactly in IEEE-754 double
// precision - e.g. 1287.225 is actually stored as 1287.2249999999999..., so
// Math.round rounds it DOWN to 1287.22 instead of the expected 1287.23.
// Confirmed live: ~2% of randomly generated realistic order totals hit this
// in testing. The 1e-9 nudge corrects the representation error - it is far
// smaller than the gap between any two real cent values (0.01, i.e. 1 once
// scaled by 100), so it can never falsely push a genuine value across a
// boundary, only correct the artefact of the value's own storage.
export function round2(n) {
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(n) * 100 + 1e-9) / 100;
}

// Today as 'YYYY-MM-DD' in the server's local time. `new Date().toISOString()`
// converts through UTC first, which silently shifts the date whenever the
// server's local time and UTC fall on different calendar days (e.g. showing
// yesterday as "today" for the first couple of hours after local midnight in
// timezones ahead of UTC, like SAST) - this builds the string from local
// y/m/d components instead.
export function getTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Date N days from today in 'YYYY-MM-DD' format (local time, not UTC).
// Offset can be negative (past) or positive (future). Used for date calculations
// like "3 days from now" without UTC drift.
export function getLocalDateISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Save a base64 data-URL to the uploads folder, return relative path.
export function saveDataUrl(dataUrl, baseName, options = {}) {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const allowedTypes = options.allowedTypes || ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowedTypes.includes(m[1])) return null;
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' }[m[1]];
  if (!ext) return null;
  const data = Buffer.from(m[2], 'base64');
  const maxBytes = options.maxBytes || 5 * 1024 * 1024;
  if (!data.length || data.length > maxBytes) return null;
  const signatures = {
    'image/png': () => data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    'image/jpeg': () => data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')),
    'image/webp': () => data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP',
    'application/pdf': () => data.subarray(0, 5).toString('ascii') === '%PDF-'
  };
  if (!signatures[m[1]]?.()) return null;
  const safeBase = String(baseName || 'upload').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'upload';
  const filename = `${safeBase}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), data, { flag: 'wx' });
  return `/uploads/${filename}`;
}

export function deleteUploadedFile(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.startsWith('/uploads/')) return false;
  const filename = path.basename(relativePath);
  if (relativePath !== `/uploads/${filename}`) return false;
  const absolutePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(absolutePath)) return false;
  fs.unlinkSync(absolutePath);
  return true;
}

// Straight-line distance in metres between two GPS points (haversine).
export function distanceM(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null)) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// --- Pricing engine ---------------------------------------------------------
// Active price rules that could apply to a product (its own rules + category rules),
// within their promo date window. Returned ordered so callers can pick per qty.
export function rulesForProduct(product) {
  return db.prepare(`
    SELECT * FROM price_rules
    WHERE active = 1
      AND (product_id = ? OR (category_id IS NOT NULL AND category_id = ?))
      AND (starts_on IS NULL OR starts_on <= date('now'))
      AND (ends_on IS NULL OR ends_on >= date('now'))
    ORDER BY min_qty
  `).all(product.id, product.category_id);
}

// All in-window active rules in one query. Callers pricing a whole catalogue
// (sync snapshot, product lists) load these once and pass them to priceBreaks,
// turning an N-query-per-request loop into a single query.
export function activeRules() {
  return db.prepare(`
    SELECT * FROM price_rules
    WHERE active = 1
      AND (starts_on IS NULL OR starts_on <= date('now'))
      AND (ends_on IS NULL OR ends_on >= date('now'))
    ORDER BY min_qty
  `).all();
}

// SYSPRO's catalogue price (products.list_price) is a per-KG price, not a
// per-unit/per-pack price. conv_factor_alt_uom is SYSPRO's own ConvFactAltUom,
// read straight from InvMaster - it replaces packWeightKg()'s string-parse of
// pack_size, which mispriced products whose stocking UOM text doesn't equal the
// selling-unit factor (see docs/sql/vw_FS_Products-ConvFactAltUom.sql).
// Falls back to pack_weight_kg for products not yet re-synced.
export function productUnitPrice(product) {
  // R1-025/027/028: SYSPRO prices per kg; this scales to a per-selling-unit
  // price by the conversion factor, which can produce many decimal places
  // (e.g. 79.94 x 5.76 = 460.4544). Rounded to cents here, at the source,
  // rather than left to accumulate through every later multiplication by
  // quantity - a real invoicing system never charges a fraction of a cent per
  // unit, and rounding only the LINE TOTAL later (as orders/quotes already do)
  // is not equivalent: qty x an unrounded unit price can differ from qty x the
  // properly-rounded unit price by a growing amount as qty increases.
  return round2(product.list_price * (product.conv_factor_alt_uom || product.pack_weight_kg || 1));
}

// Parses a pack_size like "BAG 25KG", "BUCKET 2.7", "CARTON12.5", "EACH 500G",
// or bare "KG" into a kg weight. Real SYSPRO data has no consistent spacing
// or unit suffix - every pack in this catalogue is weight-based (no L/ml
// packs), so a bare number with no unit is treated as kg.
export function packWeightKg(packSize) {
  if (!packSize) return null;
  const s = String(packSize).toUpperCase().trim();
  if (s === 'KG') return 1;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(KG|G)?/);
  if (!m) return null;
  const amount = parseFloat(m[1]);
  if (!amount) return null;
  return m[2] === 'G' ? amount / 1000 : amount;
}

// One-time backfill: products synced/created before pack_weight_kg existed
// have it NULL. Parse it from their existing pack_size text so the fix takes
// effect immediately, not just for the next sync.
for (const p of db.prepare("SELECT id, pack_size FROM products WHERE pack_weight_kg IS NULL AND pack_size IS NOT NULL").all()) {
  const kg = packWeightKg(p.pack_size);
  if (kg) db.prepare('UPDATE products SET pack_weight_kg = ? WHERE id = ?').run(kg, p.id);
}

function rulePrice(rule, unitPrice) {
  if (rule.rule_type === 'fixed_price' && rule.fixed_price != null) return rule.fixed_price;
  if (rule.discount_pct != null) return unitPrice * (1 - rule.discount_pct / 100);
  return unitPrice;
}

// Price breaks a client can evaluate offline: [{ min_qty, price, rule_name }],
// already the best price at each break point. Base list price is min_qty 0.
// Pass a preloaded `rules` array (from activeRules) to avoid a per-product query.
export function priceBreaks(product, rules = null) {
  const applicable = rules
    ? rules.filter((r) => r.product_id === product.id || (r.category_id != null && r.category_id === product.category_id))
    : rulesForProduct(product);
  const unitPrice = productUnitPrice(product);
  const breaks = new Map([[0, { min_qty: 0, price: unitPrice, rule_name: null }]]);
  for (const rule of applicable) {
    const price = round2(rulePrice(rule, unitPrice));
    const key = rule.min_qty || 0;
    const existing = breaks.get(key);
    if (!existing || price < existing.price) breaks.set(key, { min_qty: key, price, rule_name: rule.name });
  }
  // A higher break must never cost more than a lower one.
  const sorted = [...breaks.values()].sort((a, b) => a.min_qty - b.min_qty);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].price > sorted[i - 1].price) sorted[i] = { ...sorted[i - 1], min_qty: sorted[i].min_qty };
  }
  return sorted;
}

// R1-044: which tier actually produced a price, for the "why is this price
// what it is" label shown to reps and printed onto order/quote lines. One
// decision tree shared by effectivePrice() (price only, used everywhere
// pricing is computed) and effectivePriceDetail() (price + source, used
// where the source needs to be stored/displayed) - duplicating this logic
// risks the two silently drifting apart on which price wins.
//
// PRICE_SOURCES values double as both the internal tag stored on order/quote
// lines and (via PRICE_SOURCE_LABELS) the human label shown for it.
export const PRICE_SOURCES = {
  CONTRACT: 'contract',
  BUYING_GROUP: 'buying_group',
  PRICE_CODE: 'price_code',
  CUSTOMER_PRICE: 'customer_price',
  QTY_BREAK: 'qty_break',
  G_PRICE: 'g_price',
  MANUAL_OVERRIDE: 'manual_override'
};

export const PRICE_SOURCE_LABELS = {
  [PRICE_SOURCES.CONTRACT]: 'Contract Price',
  [PRICE_SOURCES.BUYING_GROUP]: 'Buying Group Price',
  [PRICE_SOURCES.PRICE_CODE]: 'Price Code',
  [PRICE_SOURCES.CUSTOMER_PRICE]: 'Customer Price',
  [PRICE_SOURCES.QTY_BREAK]: 'Quantity Break',
  [PRICE_SOURCES.G_PRICE]: 'G Price',
  [PRICE_SOURCES.MANUAL_OVERRIDE]: 'Manual Override'
};

// Effective unit price and which tier produced it: SYSPRO contract price wins
// outright, then SYSPRO buying-group, then SYSPRO price-code; otherwise a
// RouteOne-side fixed customer price; otherwise the best qty-break rule price
// for the quantity; otherwise list price * pack weight (G Price - SYSPRO's
// normal selling price with no negotiated tier in play).
function effectivePriceDetail(customerId, productId, qty = 1) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return { price: 0, source: null };
  const customer = db.prepare('SELECT code FROM customers WHERE id = ?').get(customerId);
  if (customer) {
    const syspro = db.prepare(`
      SELECT contract_price, buying_group_price, price_code_price,
        contract_start_date, contract_end_date,
        buying_group_start_date, buying_group_end_date
      FROM syspro_customer_pricing
      WHERE customer_code = ? AND product_code = ?
    `).get(customer.code, product.code);
    if (syspro) {
      const today = getTodayISO();
      const inWindow = (start, end) => (!start || start <= today) && (!end || end >= today);
      const contractPrice = syspro.contract_price != null &&
        inWindow(syspro.contract_start_date, syspro.contract_end_date)
        ? syspro.contract_price : null;
      const groupPrice = syspro.buying_group_price != null &&
        inWindow(syspro.buying_group_start_date, syspro.buying_group_end_date)
        ? syspro.buying_group_price : null;
      const perKgPrice = contractPrice ?? groupPrice ?? syspro.price_code_price;
      // Rounded to cents for the same reason as productUnitPrice() above - this
      // is the actual contract/buying-group/price-code unit price a rep is
      // quoted and that gets multiplied by quantity on the order line.
      if (perKgPrice != null) {
        const source = contractPrice != null ? PRICE_SOURCES.CONTRACT
          : groupPrice != null ? PRICE_SOURCES.BUYING_GROUP
          : PRICE_SOURCES.PRICE_CODE;
        return { price: round2(perKgPrice * (product.conv_factor_alt_uom || product.pack_weight_kg || 1)), source };
      }
    }
  }
  const contract = db.prepare(
    'SELECT price FROM customer_prices WHERE customer_id = ? AND product_id = ?'
  ).get(customerId, productId);
  if (contract) return { price: contract.price, source: PRICE_SOURCES.CUSTOMER_PRICE };
  const applicable = priceBreaks(product).filter((b) => qty >= b.min_qty);
  if (applicable.length) {
    const best = applicable[applicable.length - 1];
    return { price: best.price, source: best.min_qty > 0 ? PRICE_SOURCES.QTY_BREAK : PRICE_SOURCES.G_PRICE };
  }
  return { price: productUnitPrice(product), source: PRICE_SOURCES.G_PRICE };
}

export function effectivePrice(customerId, productId, qty = 1) {
  return effectivePriceDetail(customerId, productId, qty).price;
}

export function effectivePriceSource(customerId, productId, qty = 1) {
  return effectivePriceDetail(customerId, productId, qty).source;
}

export function adjustOrderStock(orderId, direction) {
  if (![1, -1].includes(direction)) throw new Error('Invalid stock adjustment');
  const order = db.prepare('SELECT warehouse_id FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');
  const items = db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(orderId);
  const updateTotal = db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?');
  const updateWarehouse = db.prepare(`
    UPDATE product_stock SET qty_available = qty_available + ?
    WHERE product_id = ? AND warehouse_id = ?
  `);
  for (const item of items) {
    const delta = direction * item.qty;
    updateTotal.run(delta, item.product_id);
    if (order.warehouse_id) updateWarehouse.run(delta, item.product_id, order.warehouse_id);
  }
}
