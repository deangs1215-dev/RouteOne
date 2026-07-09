import { Router } from 'express';
import { db, nextNumber, logActivity } from '../db.js';
import { requireRole, scopeForUser } from '../auth.js';

const router = Router();

router.get('/customers', (req, res) => {
  const { q, territory_id, status } = req.query;
  const scope = scopeForUser(req.user);
  const where = [];
  const params = [];
  if (scope.isRep) { where.push('c.rep_id = ?'); params.push(req.user.id); }
  if (q) { where.push('(c.name LIKE ? OR c.code LIKE ? OR c.city LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (territory_id) { where.push('c.territory_id = ?'); params.push(territory_id); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  const rows = db.prepare(`
    SELECT c.*, t.name AS territory_name, u.name AS rep_name,
      (SELECT MAX(order_date) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS last_order_at,
      (SELECT MAX(check_in_at) FROM visits v WHERE v.customer_id = c.id) AS last_visit_at
    FROM customers c
    LEFT JOIN territories t ON t.id = c.territory_id
    LEFT JOIN users u ON u.id = c.rep_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.name
  `).all(...params);
  res.json(rows);
});

router.get('/customers/:id', (req, res) => {
  const customer = db.prepare(`
    SELECT c.*, t.name AS territory_name, u.name AS rep_name
    FROM customers c
    LEFT JOIN territories t ON t.id = c.territory_id
    LEFT JOIN users u ON u.id = c.rep_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  customer.contacts = db.prepare('SELECT * FROM customer_contacts WHERE customer_id = ?').all(customer.id);
  customer.recent_orders = db.prepare(`
    SELECT o.*, u.name AS rep_name FROM orders o
    LEFT JOIN users u ON u.id = o.rep_id
    WHERE o.customer_id = ? ORDER BY o.order_date DESC LIMIT 20
  `).all(customer.id);
  customer.recent_visits = db.prepare(`
    SELECT v.*, u.name AS rep_name FROM visits v
    JOIN users u ON u.id = v.rep_id
    WHERE v.customer_id = ? ORDER BY COALESCE(v.check_in_at, v.planned_date) DESC LIMIT 20
  `).all(customer.id);
  customer.recent_quotes = db.prepare(`
    SELECT q.*, u.name AS rep_name FROM quotes q
    LEFT JOIN users u ON u.id = q.rep_id
    WHERE q.customer_id = ? ORDER BY q.quote_date DESC LIMIT 10
  `).all(customer.id);
  customer.recent_forms = db.prepare(`
    SELECT s.id, s.created_at, t.name AS template_name, u.name AS rep_name
    FROM form_submissions s
    JOIN form_templates t ON t.id = s.template_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.customer_id = ? ORDER BY s.created_at DESC LIMIT 10
  `).all(customer.id);
  customer.prices = db.prepare(`
    SELECT cp.product_id, cp.price, p.code, p.name, p.list_price
    FROM customer_prices cp JOIN products p ON p.id = cp.product_id
    WHERE cp.customer_id = ? ORDER BY p.name
  `).all(customer.id);
  customer.stats = db.prepare(`
    SELECT
      COUNT(*) AS order_count,
      COALESCE(SUM(total), 0) AS sales_total,
      COALESCE(SUM(CASE WHEN order_date >= date('now', 'start of month') THEN total END), 0) AS sales_mtd,
      COALESCE(SUM(CASE WHEN order_date >= date('now', '-365 days') THEN total END), 0) AS sales_12m
    FROM orders WHERE customer_id = ? AND status != 'cancelled'
  `).get(customer.id);
  res.json(customer);
});

router.post('/customers', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Customer name is required' });
  const code = b.code || nextNumber('CUS');
  const info = db.prepare(`
    INSERT INTO customers (code, name, classification, territory_id, rep_id, contact_name, phone, email,
      address, city, lat, lng, credit_limit, payment_terms, visit_frequency, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code, b.name, b.classification || 'B', b.territory_id || null, b.rep_id || null,
    b.contact_name || null, b.phone || null, b.email || null, b.address || null, b.city || null,
    b.lat || null, b.lng || null, b.credit_limit || 0, b.payment_terms || '30 days',
    b.visit_frequency || 'weekly', b.status || 'active', b.notes || null
  );
  logActivity(req.user.id, 'create', 'customer', info.lastInsertRowid, { name: b.name });
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/customers/:id', (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });
  db.prepare(`
    UPDATE customers SET name = ?, classification = ?, territory_id = ?, rep_id = ?, contact_name = ?,
      phone = ?, email = ?, address = ?, city = ?, lat = ?, lng = ?, credit_limit = ?, balance = ?,
      payment_terms = ?, visit_frequency = ?, status = ?, notes = ?
    WHERE id = ?
  `).run(
    b.name ?? existing.name, b.classification ?? existing.classification,
    b.territory_id ?? existing.territory_id, b.rep_id ?? existing.rep_id,
    b.contact_name ?? existing.contact_name, b.phone ?? existing.phone, b.email ?? existing.email,
    b.address ?? existing.address, b.city ?? existing.city, b.lat ?? existing.lat, b.lng ?? existing.lng,
    b.credit_limit ?? existing.credit_limit, b.balance ?? existing.balance,
    b.payment_terms ?? existing.payment_terms, b.visit_frequency ?? existing.visit_frequency,
    b.status ?? existing.status, b.notes ?? existing.notes, req.params.id
  );
  logActivity(req.user.id, 'update', 'customer', req.params.id);
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

router.post('/customers/:id/contacts', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Contact name is required' });
  const info = db.prepare(
    'INSERT INTO customer_contacts (customer_id, name, role, phone, email) VALUES (?, ?, ?, ?, ?)'
  ).run(req.params.id, b.name, b.role || null, b.phone || null, b.email || null);
  res.json(db.prepare('SELECT * FROM customer_contacts WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/contacts/:id', (req, res) => {
  db.prepare('DELETE FROM customer_contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Set or clear a contract price for one product.
router.put('/customers/:id/prices/:productId', requireRole('admin', 'manager', 'office'), (req, res) => {
  const price = req.body?.price;
  if (price === null || price === '' || price === undefined) {
    db.prepare('DELETE FROM customer_prices WHERE customer_id = ? AND product_id = ?').run(req.params.id, req.params.productId);
  } else {
    db.prepare(`
      INSERT INTO customer_prices (customer_id, product_id, price) VALUES (?, ?, ?)
      ON CONFLICT(customer_id, product_id) DO UPDATE SET price = excluded.price
    `).run(req.params.id, req.params.productId, Number(price));
  }
  logActivity(req.user.id, 'price_change', 'customer', req.params.id, { product_id: req.params.productId, price });
  res.json({ ok: true });
});

router.get('/territories', (req, res) => {
  res.json(db.prepare('SELECT * FROM territories ORDER BY name').all());
});

router.post('/territories', requireRole('admin', 'manager'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Territory name is required' });
  const info = db.prepare('INSERT INTO territories (name, region) VALUES (?, ?)').run(b.name, b.region || null);
  res.json(db.prepare('SELECT * FROM territories WHERE id = ?').get(info.lastInsertRowid));
});

export default router;
