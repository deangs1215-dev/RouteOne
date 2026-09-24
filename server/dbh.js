// Async versions of the database helpers in db.js, built on dbx so they run on
// SQLite or SQL Server. Same names and arguments as their db.js counterparts
// (each returns a promise), so a file migrates by changing its import from
// './db.js' to './dbh.js' for these and adding `await`.
//
// Helpers that write accept a trailing `conn` - pass a `tx` from
// dbx.transaction() to run inside the caller's transaction (default: dbx).
//
// Once every caller has moved, db.js's synchronous copies are deleted and this
// file's contents fold back into db.js.
import { dbx, round2, getTodayISO, PRICE_SOURCES, productUnitPrice, priceBreaks } from './db.js';

// Runs fn over items with at most `limit` in flight, preserving order. Per-item
// query loops that were free on in-process SQLite cost a network round trip each
// on SQL Server; running them concurrently (bounded by the connection pool)
// keeps a report over ~100 reps from taking minutes.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// Every rep's monthly budget for months 1..upToMonth in ONE query, as a lookup
// (rep, month) -> budget, falling back to the rep's flat sales_target exactly as
// repMonthTarget() does. Use instead of calling repMonthTarget in a loop.
export async function repTargetLookup(upToMonth, conn = dbx) {
  const rows = await conn.prepare('SELECT rep_id, [month], budget FROM rep_budgets WHERE [month] <= ?').all(upToMonth);
  const budgets = new Map(rows.map((r) => [`${r.rep_id}:${r.month}`, r.budget]));
  return (rep, month) => {
    const key = `${rep.id}:${month}`;
    return budgets.has(key) ? budgets.get(key) : (rep.sales_target || 0);
  };
}

export async function getSetting(key, fallback = null, conn = dbx) {
  const row = await conn.prepare('SELECT [value] FROM settings WHERE [key] = ?').get(key);
  return row ? row.value : fallback;
}

// Portable upsert: UPDATE first, INSERT when no row matched. Runs in a
// transaction so two callers cannot both take the INSERT path.
export async function setSetting(key, value, conn = dbx) {
  const write = async (c) => {
    const r = await c.prepare('UPDATE settings SET [value] = ? WHERE [key] = ?').run(String(value), key);
    if (!r.changes) await c.prepare('INSERT INTO settings ([key], [value]) VALUES (?, ?)').run(key, String(value));
  };
  // Already inside a caller's transaction when a tx handle is passed.
  if (conn !== dbx) return write(conn);
  return dbx.transaction(write);
}

// Sequential document numbers: ORD-00042, CUS-00007 ...
// Increments in a single UPDATE so concurrent callers each get a distinct
// number (the old read-then-write could hand the same number to two requests
// once queries stopped being synchronous). The row lock taken by the UPDATE is
// held until the surrounding transaction ends.
export async function nextNumber(prefix, conn = dbx) {
  const key = `counter_${prefix}`;
  const next = async (c) => {
    const r = await c.prepare(
      'UPDATE settings SET [value] = CAST(CAST([value] AS INT) + 1 AS VARCHAR(20)) WHERE [key] = ?'
    ).run(key);
    if (!r.changes) await c.prepare('INSERT INTO settings ([key], [value]) VALUES (?, ?)').run(key, '0');
    if (!r.changes) await c.prepare(
      'UPDATE settings SET [value] = CAST(CAST([value] AS INT) + 1 AS VARCHAR(20)) WHERE [key] = ?'
    ).run(key);
    const row = await c.prepare('SELECT [value] FROM settings WHERE [key] = ?').get(key);
    return `${prefix}-${String(parseInt(row.value, 10)).padStart(5, '0')}`;
  };
  if (conn !== dbx) return next(conn);
  return dbx.transaction(next);
}

// See repMonthTarget in db.js for the rationale.
export async function repMonthTarget(repId, month, conn = dbx) {
  const row = await conn.prepare('SELECT budget FROM rep_budgets WHERE rep_id = ? AND [month] = ?').get(repId, month);
  if (row) return row.budget;
  const user = await conn.prepare('SELECT sales_target FROM users WHERE id = ?').get(repId);
  return user?.sales_target || 0;
}

export async function logActivity(userId, action, entityType, entityId, detail = null, conn = dbx) {
  await conn.prepare(
    'INSERT INTO activity_log (user_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(userId ?? null, action, entityType, entityId ?? null, detail ? JSON.stringify(detail) : null);
}

// --- Pricing engine ---------------------------------------------------------
// The in-window test uses the server's local date (getTodayISO) rather than
// SQLite's date('now'), which is UTC. T-SQL has no date('now') either, and a
// bound parameter keeps the query identical on both backends. The only
// behavioural difference is the first couple of hours after local midnight,
// where the local date is the correct one.
export async function rulesForProduct(product, conn = dbx) {
  const today = getTodayISO();
  return conn.prepare(`
    SELECT * FROM price_rules
    WHERE active = 1
      AND (product_id = ? OR (category_id IS NOT NULL AND category_id = ?))
      AND (starts_on IS NULL OR starts_on <= ?)
      AND (ends_on IS NULL OR ends_on >= ?)
    ORDER BY min_qty
  `).all(product.id, product.category_id, today, today);
}

export async function activeRules(conn = dbx) {
  const today = getTodayISO();
  return conn.prepare(`
    SELECT * FROM price_rules
    WHERE active = 1
      AND (starts_on IS NULL OR starts_on <= ?)
      AND (ends_on IS NULL OR ends_on >= ?)
    ORDER BY min_qty
  `).all(today, today);
}

// db.js's priceBreaks() is pure when handed a preloaded rules list, so the
// async version only has to load the rules when the caller did not.
export async function priceBreaksFor(product, rules = null, conn = dbx) {
  return priceBreaks(product, rules ?? await rulesForProduct(product, conn));
}

async function effectivePriceDetail(customerId, productId, qty = 1, conn = dbx) {
  const product = await conn.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return { price: 0, source: null };
  const customer = await conn.prepare('SELECT code FROM customers WHERE id = ?').get(customerId);
  if (customer) {
    const syspro = await conn.prepare(`
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
      if (perKgPrice != null) {
        const source = contractPrice != null ? PRICE_SOURCES.CONTRACT
          : groupPrice != null ? PRICE_SOURCES.BUYING_GROUP
          : PRICE_SOURCES.PRICE_CODE;
        return { price: round2(perKgPrice * (product.conv_factor_alt_uom || product.pack_weight_kg || 1)), source };
      }
    }
  }
  const contract = await conn.prepare(
    'SELECT price FROM customer_prices WHERE customer_id = ? AND product_id = ?'
  ).get(customerId, productId);
  if (contract) return { price: contract.price, source: PRICE_SOURCES.CUSTOMER_PRICE };
  const applicable = (await priceBreaksFor(product, null, conn)).filter((b) => qty >= b.min_qty);
  if (applicable.length) {
    const best = applicable[applicable.length - 1];
    return { price: best.price, source: best.min_qty > 0 ? PRICE_SOURCES.QTY_BREAK : PRICE_SOURCES.G_PRICE };
  }
  return { price: productUnitPrice(product), source: PRICE_SOURCES.G_PRICE };
}

export async function effectivePrice(customerId, productId, qty = 1, conn = dbx) {
  return (await effectivePriceDetail(customerId, productId, qty, conn)).price;
}

export async function effectivePriceSource(customerId, productId, qty = 1, conn = dbx) {
  return (await effectivePriceDetail(customerId, productId, qty, conn)).source;
}

export async function adjustOrderStock(orderId, direction, conn = dbx) {
  if (![1, -1].includes(direction)) throw new Error('Invalid stock adjustment');
  const order = await conn.prepare('SELECT warehouse_id FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');
  const items = await conn.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(orderId);
  const updateTotal = conn.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?');
  const updateWarehouse = conn.prepare(`
    UPDATE product_stock SET qty_available = qty_available + ?
    WHERE product_id = ? AND warehouse_id = ?
  `);
  for (const item of items) {
    const delta = direction * item.qty;
    await updateTotal.run(delta, item.product_id);
    if (order.warehouse_id) await updateWarehouse.run(delta, item.product_id, order.warehouse_id);
  }
}
