import { Router } from 'express';
import { db, logActivity, priceBreaks, activeRules } from '../db.js';
import { requireRole } from '../auth.js';

const router = Router();

router.get('/products', (req, res) => {
  const { q, category_id, active } = req.query;
  const where = [];
  const params = [];
  if (q) { where.push('(p.name LIKE ? OR p.code LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (category_id) { where.push('p.category_id = ?'); params.push(category_id); }
  if (active !== undefined) { where.push('p.active = ?'); params.push(active === 'false' ? 0 : 1); }
  const rows = db.prepare(`
    SELECT p.*, c.name AS category_name
    FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.name
  `).all(...params);
  res.json(rows);
});

// Product list with the effective price for one customer (contract price beats
// list price) plus price breaks so the client can price qty discounts locally.
router.get('/products/for-customer/:customerId', (req, res) => {
  const cid = req.params.customerId;
  const rows = db.prepare(`
    SELECT p.*, c.name AS category_name,
      COALESCE(cp.price, p.list_price) AS effective_price,
      CASE WHEN cp.price IS NOT NULL THEN 1 ELSE 0 END AS has_contract_price,
      (SELECT COUNT(DISTINCT oi.order_id) FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.customer_id = ? AND oi.product_id = p.id AND o.status != 'cancelled') AS times_bought,
      (SELECT MAX(o.order_date) FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.customer_id = ? AND oi.product_id = p.id AND o.status != 'cancelled') AS last_bought_at
    FROM products p
    LEFT JOIN product_categories c ON c.id = p.category_id
    LEFT JOIN customer_prices cp ON cp.product_id = p.id AND cp.customer_id = ?
    WHERE p.active = 1
    ORDER BY p.name
  `).all(cid, cid, cid);
  const rules = activeRules();
  res.json(rows.map((p) => {
    const breaks = p.has_contract_price ? [] : priceBreaks(p, rules);
    const base = breaks.length ? breaks[0].price : p.effective_price;
    return { ...p, price_breaks: breaks, effective_price: p.has_contract_price ? p.effective_price : base };
  }));
});

// --- Price rules (Phase 2 pricing beyond contract prices) ---

router.get('/price-rules', (req, res) => {
  res.json(db.prepare(`
    SELECT r.*, p.name AS product_name, c.name AS category_name
    FROM price_rules r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN product_categories c ON c.id = r.category_id
    ORDER BY r.name
  `).all());
});

router.post('/price-rules', requireRole('admin', 'manager', 'office'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Rule name is required' });
  if (!b.product_id && !b.category_id) return res.status(400).json({ error: 'Pick a product or a category' });
  if (b.rule_type === 'fixed_price' ? b.fixed_price == null : b.discount_pct == null) {
    return res.status(400).json({ error: 'Set a discount % or a fixed price' });
  }
  const info = db.prepare(`
    INSERT INTO price_rules (name, product_id, category_id, rule_type, discount_pct, fixed_price, min_qty, starts_on, ends_on, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.name, b.product_id || null, b.category_id || null, b.rule_type || 'discount_pct',
    b.discount_pct ?? null, b.fixed_price ?? null, b.min_qty || 0,
    b.starts_on || null, b.ends_on || null, b.active === 0 ? 0 : 1
  );
  logActivity(req.user.id, 'create', 'price_rule', info.lastInsertRowid, { name: b.name });
  res.json({ id: info.lastInsertRowid });
});

router.put('/price-rules/:id', requireRole('admin', 'manager', 'office'), (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM price_rules WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Rule not found' });
  db.prepare(`
    UPDATE price_rules SET name = ?, product_id = ?, category_id = ?, rule_type = ?, discount_pct = ?,
      fixed_price = ?, min_qty = ?, starts_on = ?, ends_on = ?, active = ?
    WHERE id = ?
  `).run(
    b.name ?? existing.name, b.product_id ?? existing.product_id, b.category_id ?? existing.category_id,
    b.rule_type ?? existing.rule_type, b.discount_pct ?? existing.discount_pct, b.fixed_price ?? existing.fixed_price,
    b.min_qty ?? existing.min_qty, b.starts_on ?? existing.starts_on, b.ends_on ?? existing.ends_on,
    b.active ?? existing.active, req.params.id
  );
  res.json({ ok: true });
});

router.delete('/price-rules/:id', requireRole('admin', 'manager', 'office'), (req, res) => {
  db.prepare('DELETE FROM price_rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/products', requireRole('admin', 'manager', 'office'), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.name) return res.status(400).json({ error: 'Product code and name are required' });
  const info = db.prepare(`
    INSERT INTO products (code, name, category_id, description, uom, pack_size, list_price, cost_price, stock_qty, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.code, b.name, b.category_id || null, b.description || null, b.uom || 'each',
    b.pack_size || null, b.list_price || 0, b.cost_price || 0, b.stock_qty || 0, b.active === 0 ? 0 : 1
  );
  logActivity(req.user.id, 'create', 'product', info.lastInsertRowid, { name: b.name });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/products/:id', requireRole('admin', 'manager', 'office'), (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  db.prepare(`
    UPDATE products SET code = ?, name = ?, category_id = ?, description = ?, uom = ?, pack_size = ?,
      list_price = ?, cost_price = ?, stock_qty = ?, active = ?
    WHERE id = ?
  `).run(
    b.code ?? existing.code, b.name ?? existing.name, b.category_id ?? existing.category_id,
    b.description ?? existing.description, b.uom ?? existing.uom, b.pack_size ?? existing.pack_size,
    b.list_price ?? existing.list_price, b.cost_price ?? existing.cost_price,
    b.stock_qty ?? existing.stock_qty, b.active ?? existing.active, req.params.id
  );
  logActivity(req.user.id, 'update', 'product', req.params.id);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

router.get('/product-categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM product_categories ORDER BY name').all());
});

router.post('/product-categories', requireRole('admin', 'manager', 'office'), (req, res) => {
  const name = req.body?.name;
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  const info = db.prepare('INSERT INTO product_categories (name) VALUES (?)').run(name);
  res.json(db.prepare('SELECT * FROM product_categories WHERE id = ?').get(info.lastInsertRowid));
});

export default router;
