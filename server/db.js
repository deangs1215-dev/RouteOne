import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

export const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(path.join(dataDir, 'fieldsales.db'));
// Tuning for many concurrent reps hitting a single SQLite file:
db.pragma('journal_mode = WAL');       // concurrent readers while one writer commits
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');     // safe with WAL, much faster writes
db.pragma('busy_timeout = 5000');      // wait (not error) if the DB is briefly write-locked
db.pragma('cache_size = -20000');      // ~20MB page cache per connection
db.pragma('mmap_size = 268435456');    // 256MB memory-mapped I/O for faster reads
db.pragma('wal_autocheckpoint = 1000');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Column migrations for databases created before Phase 3 (CREATE TABLE IF NOT
// EXISTS won't add columns to an existing table).
for (const stmt of [
  'ALTER TABLE visits ADD COLUMN route_order INTEGER',
  'ALTER TABLE visits ADD COLUMN check_in_distance_m REAL',
  'ALTER TABLE users ADD COLUMN customer_id INTEGER REFERENCES customers(id)' // portal logins
]) {
  try { db.exec(stmt); } catch { /* column already exists */ }
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

export function logActivity(userId, action, entityType, entityId, detail = null) {
  db.prepare(
    'INSERT INTO activity_log (user_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(userId ?? null, action, entityType, entityId ?? null, detail ? JSON.stringify(detail) : null);
}

export const VAT_RATE = 0.15;

// Save a base64 data-URL to the uploads folder, return relative path.
export function saveDataUrl(dataUrl, baseName) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[m[1]] || 'bin';
  const filename = `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.from(m[2], 'base64'));
  return `/uploads/${filename}`;
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

function rulePrice(rule, listPrice) {
  if (rule.rule_type === 'fixed_price' && rule.fixed_price != null) return rule.fixed_price;
  if (rule.discount_pct != null) return listPrice * (1 - rule.discount_pct / 100);
  return listPrice;
}

// Price breaks a client can evaluate offline: [{ min_qty, price, rule_name }],
// already the best price at each break point. Base list price is min_qty 0.
// Pass a preloaded `rules` array (from activeRules) to avoid a per-product query.
export function priceBreaks(product, rules = null) {
  const applicable = rules
    ? rules.filter((r) => r.product_id === product.id || (r.category_id != null && r.category_id === product.category_id))
    : rulesForProduct(product);
  const breaks = new Map([[0, { min_qty: 0, price: product.list_price, rule_name: null }]]);
  for (const rule of applicable) {
    const price = Math.round(rulePrice(rule, product.list_price) * 100) / 100;
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

// Effective unit price: customer contract price wins outright; otherwise the
// best rule price for the quantity; otherwise list price.
export function effectivePrice(customerId, productId, qty = 1) {
  const contract = db.prepare(
    'SELECT price FROM customer_prices WHERE customer_id = ? AND product_id = ?'
  ).get(customerId, productId);
  if (contract) return contract.price;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return 0;
  const applicable = priceBreaks(product).filter((b) => qty >= b.min_qty);
  return applicable.length ? applicable[applicable.length - 1].price : product.list_price;
}
