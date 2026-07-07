import { Router } from 'express';
import { db } from '../db.js';
import { requireRole } from '../auth.js';
import bcrypt from 'bcryptjs';

const router = Router();

router.get('/dashboard', (req, res) => {
  const stats = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(total), 0) FROM orders WHERE order_date >= date('now', 'start of month') AND status != 'cancelled') AS sales_mtd,
      (SELECT COUNT(*) FROM orders WHERE date(order_date) = date('now') AND status != 'cancelled') AS orders_today,
      (SELECT COUNT(*) FROM visits WHERE date(check_in_at) = date('now') AND status = 'completed') AS visits_today,
      (SELECT COUNT(*) FROM visits WHERE date(planned_date) = date('now') AND status = 'planned') AS visits_pending,
      (SELECT COUNT(*) FROM customers WHERE status = 'active') AS active_customers,
      (SELECT COALESCE(AVG(total), 0) FROM orders WHERE order_date >= date('now', '-30 days') AND status != 'cancelled') AS avg_order_value
  `).get();

  const salesByRep = db.prepare(`
    SELECT u.id, u.name, u.sales_target,
      COALESCE(SUM(CASE WHEN o.order_date >= date('now', 'start of month') AND o.status != 'cancelled' THEN o.total END), 0) AS sales_mtd,
      COUNT(DISTINCT CASE WHEN o.order_date >= date('now', 'start of month') AND o.status != 'cancelled' THEN o.id END) AS orders_mtd,
      (SELECT COUNT(*) FROM visits v WHERE v.rep_id = u.id AND v.check_in_at >= date('now', 'start of month') AND v.status = 'completed') AS visits_mtd
    FROM users u
    LEFT JOIN orders o ON o.rep_id = u.id
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'rep' AND u.active = 1
    GROUP BY u.id ORDER BY sales_mtd DESC
  `).all();

  const topCustomers = db.prepare(`
    SELECT c.id, c.name, c.city, COALESCE(SUM(o.total), 0) AS sales_mtd, COUNT(o.id) AS orders_mtd
    FROM customers c
    JOIN orders o ON o.customer_id = c.id AND o.order_date >= date('now', 'start of month') AND o.status != 'cancelled'
    GROUP BY c.id ORDER BY sales_mtd DESC LIMIT 8
  `).all();

  // Customers with no order in 30+ days - the "at risk" list.
  const atRisk = db.prepare(`
    SELECT c.id, c.name, c.city, u.name AS rep_name, MAX(o.order_date) AS last_order_at
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id AND o.status != 'cancelled'
    LEFT JOIN users u ON u.id = c.rep_id
    WHERE c.status = 'active'
    GROUP BY c.id
    HAVING last_order_at IS NULL OR last_order_at < date('now', '-30 days')
    ORDER BY last_order_at LIMIT 8
  `).all();

  const recentOrders = db.prepare(`
    SELECT o.id, o.number, o.total, o.status, o.order_date, c.name AS customer_name, u.name AS rep_name
    FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.rep_id
    ORDER BY o.order_date DESC LIMIT 10
  `).all();

  const salesTrend = db.prepare(`
    SELECT date(order_date) AS day, COALESCE(SUM(total), 0) AS total
    FROM orders WHERE order_date >= date('now', '-14 days') AND status != 'cancelled'
    GROUP BY day ORDER BY day
  `).all();

  res.json({ stats, salesByRep, topCustomers, atRisk, recentOrders, salesTrend });
});

// --- User admin (kept here to avoid a separate module for Phase 1) ---

router.get('/users', requireRole('admin', 'manager'), (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.active, u.sales_target, u.territory_id, u.customer_id,
      r.name AS role, t.name AS territory_name, c.name AS customer_name
    FROM users u JOIN roles r ON r.id = u.role_id
    LEFT JOIN territories t ON t.id = u.territory_id
    LEFT JOIN customers c ON c.id = u.customer_id
    ORDER BY u.name
  `).all());
});

router.get('/roles', requireRole('admin', 'manager'), (req, res) => {
  res.json(db.prepare('SELECT id, name FROM roles ORDER BY id').all());
});

router.post('/users', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email || !b.password || !b.role_id) {
    return res.status(400).json({ error: 'Name, email, password and role are required' });
  }
  try {
    const info = db.prepare(`
      INSERT INTO users (name, email, password_hash, phone, role_id, territory_id, customer_id, sales_target)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(b.name, b.email, bcrypt.hashSync(b.password, 10), b.phone || null, b.role_id, b.territory_id || null, b.customer_id || null, b.sales_target || 0);
    res.json({ id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Email already in use' });
  }
});

router.put('/users/:id', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  db.prepare(`
    UPDATE users SET name = ?, email = ?, phone = ?, role_id = ?, territory_id = ?, customer_id = ?, sales_target = ?, active = ?
    WHERE id = ?
  `).run(
    b.name ?? existing.name, b.email ?? existing.email, b.phone ?? existing.phone,
    b.role_id ?? existing.role_id, b.territory_id ?? existing.territory_id,
    b.customer_id ?? existing.customer_id,
    b.sales_target ?? existing.sales_target, b.active ?? existing.active, req.params.id
  );
  if (b.password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.password, 10), req.params.id);
  }
  res.json({ ok: true });
});

export default router;
