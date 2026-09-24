import { Router } from 'express';
import { isConstraintViolation } from '../dbx.js';
import { dbx, getLocalDateISO } from '../db.js';
import { logActivity } from '../dbh.js';
import { passwordIsStrong, requireRole, scopeForUser } from '../auth.js';
import { buildLoginDetailsEmail, sendEmail } from '../integration/email.js';
import bcrypt from 'bcryptjs';

const router = Router();

router.get('/dashboard', async (req, res) => {
  const scope = scopeForUser(req.user);
  const repId = req.user.id;

  // sales_mtd is SYSPRO's actual invoiced sales for this month (rep_monthly_sales,
  // synced from vw_FS_RepSalesByMonth) - same source as Rep KPIs "vs target".
  // Everything else here (orders/visits/customers) stays RouteOne-native, since
  // rep_monthly_sales is a monthly total only - no daily or per-order detail.
  const stats = scope.isRep ? await dbx.prepare(`
    SELECT
      (SELECT COALESCE(sales_value, 0) FROM rep_monthly_sales WHERE rep_id = ? AND month = strftime('%Y-%m', 'now')) AS sales_mtd,
      (SELECT COUNT(*) FROM orders WHERE rep_id = ? AND date(order_date) = date('now') AND status != 'cancelled') AS orders_today,
      (SELECT COUNT(*) FROM visits WHERE rep_id = ? AND date(check_in_at) = date('now') AND status = 'completed') AS visits_today,
      (SELECT COUNT(*) FROM visits WHERE rep_id = ? AND date(planned_date) = date('now') AND status = 'planned') AS visits_pending,
      (SELECT COUNT(*) FROM customers WHERE rep_id = ? AND status = 'active') AS active_customers,
      (SELECT COALESCE(AVG(total), 0) FROM orders WHERE rep_id = ? AND order_date >= date('now', '-30 days') AND status != 'cancelled') AS avg_order_value
  `).get(repId, repId, repId, repId, repId, repId) : await dbx.prepare(`
    SELECT
      (SELECT COALESCE(SUM(sales_value), 0) FROM rep_monthly_sales WHERE month = strftime('%Y-%m', 'now')) AS sales_mtd,
      (SELECT COUNT(*) FROM orders WHERE date(order_date) = date('now') AND status != 'cancelled') AS orders_today,
      (SELECT COUNT(*) FROM visits WHERE date(check_in_at) = date('now') AND status = 'completed') AS visits_today,
      (SELECT COUNT(*) FROM visits WHERE date(planned_date) = date('now') AND status = 'planned') AS visits_pending,
      (SELECT COUNT(*) FROM customers WHERE status = 'active') AS active_customers,
      (SELECT COALESCE(AVG(total), 0) FROM orders WHERE order_date >= date('now', '-30 days') AND status != 'cancelled') AS avg_order_value
  `).get();

  // "Sales by rep" leaderboard doesn't apply to a single rep's own dashboard.
  const salesByRep = scope.isRep ? [] : await dbx.prepare(`
    SELECT u.id, u.name, u.sales_target,
      COALESCE((SELECT sales_value FROM rep_monthly_sales rm WHERE rm.rep_id = u.id AND rm.month = strftime('%Y-%m', 'now')), 0) AS sales_mtd,
      COUNT(DISTINCT CASE WHEN o.order_date >= date('now', 'start of month') AND o.status != 'cancelled' THEN o.id END) AS orders_mtd,
      (SELECT COUNT(*) FROM visits v WHERE v.rep_id = u.id AND v.check_in_at >= date('now', 'start of month') AND v.status = 'completed') AS visits_mtd
    FROM users u
    LEFT JOIN orders o ON o.rep_id = u.id
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'rep' AND u.active = 1
    GROUP BY u.id, u.name, u.sales_target ORDER BY sales_mtd DESC
  `).all();

  const topCustomers = await dbx.prepare(`
    SELECT c.id, c.name, c.city, COALESCE(SUM(o.total), 0) AS sales_mtd, COUNT(o.id) AS orders_mtd
    FROM customers c
    JOIN orders o ON o.customer_id = c.id AND o.order_date >= date('now', 'start of month') AND o.status != 'cancelled'
    ${scope.isRep ? 'WHERE o.rep_id = ?' : ''}
    GROUP BY c.id, c.name, c.city ORDER BY sales_mtd DESC LIMIT 8
  `).all(...(scope.isRep ? [repId] : []));

  // Customers with no order in 30+ days - the "at risk" list.
  const atRisk = await dbx.prepare(`
    SELECT c.id, c.name, c.city, u.name AS rep_name, MAX(o.order_date) AS last_order_at
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id AND o.status != 'cancelled'
    LEFT JOIN users u ON u.id = c.rep_id
    WHERE c.status = 'active' ${scope.isRep ? 'AND c.rep_id = ?' : ''}
    GROUP BY c.id, c.name, c.city, u.name
    HAVING MAX(o.order_date) IS NULL OR MAX(o.order_date) < date('now', '-30 days')
    ORDER BY last_order_at LIMIT 8
  `).all(...(scope.isRep ? [repId] : []));

  const recentOrders = await dbx.prepare(`
    SELECT o.id, o.number, o.total, o.status, o.order_date, c.name AS customer_name, u.name AS rep_name
    FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.rep_id
    ${scope.isRep ? 'WHERE o.rep_id = ?' : ''}
    ORDER BY o.order_date DESC LIMIT 10
  `).all(...(scope.isRep ? [repId] : []));

  // Sourced from invoices (SYSPRO's actual invoiced sales, synced from
  // vw_FS_Invoices) rather than RouteOne's own orders table - reps capturing
  // (or not capturing) orders in the app shouldn't make this chart look like
  // sales stopped. Invoices has no rep_id of its own, so rep scoping goes
  // through the customer it's billed to.
  //
  // GROUP BY only returns days that had at least one invoice, so a quiet day
  // is simply absent from the rows rather than a zero - zero-fill every day
  // in the window here so the chart always draws 14 bars, not just the days
  // with sales.
  const salesByDay = await dbx.prepare(`
    SELECT i.invoice_date AS day, COALESCE(SUM(i.total), 0) AS total
    FROM invoices i ${scope.isRep ? 'JOIN customers c ON c.id = i.customer_id' : ''}
    WHERE i.invoice_date >= date('now', '-14 days') ${scope.isRep ? 'AND c.rep_id = ?' : ''}
    GROUP BY i.invoice_date
  `).all(...(scope.isRep ? [repId] : []));
  const salesByDayMap = Object.fromEntries(salesByDay.map((r) => [r.day, r.total]));
  const salesTrend = Array.from({ length: 14 }, (_, i) => {
    const day = getLocalDateISO(i - 13);
    return { day, total: salesByDayMap[day] || 0 };
  });

  res.json({ stats, salesByRep, topCustomers, atRisk, recentOrders, salesTrend });
});

// --- User admin (kept here to avoid a separate module for Phase 1) ---

router.get('/users', requireRole('admin', 'manager'), async (req, res) => {
  const users = await dbx.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.active, u.rep_code, u.sales_target, u.customer_id,
      u.warehouse_id, w.name AS warehouse_name,
      u.home_address, u.home_lat, u.home_lng,
      r.name AS role, c.name AS customer_name
    FROM users u JOIN roles r ON r.id = u.role_id
    LEFT JOIN customers c ON c.id = u.customer_id
    LEFT JOIN warehouses w ON w.id = u.warehouse_id
    ORDER BY u.name
  `).all();

  // Load manager warehouses for each manager
  for (const u of users) {
    if (u.role === 'manager') {
      u.manager_warehouses = (await dbx.prepare(`
        SELECT warehouse_id FROM manager_warehouses WHERE manager_id = ?
      `).all(u.id)).map(mw => mw.warehouse_id);
    }
  }

  res.json(users);
});

router.get('/roles', requireRole('admin', 'manager'), async (req, res) => {
  res.json(await dbx.prepare('SELECT id, name FROM roles ORDER BY id').all());
});

// A manager may manage users, but never admin accounts (no self-escalation).
async function adminRoleId() {
  return (await dbx.prepare("SELECT id FROM roles WHERE name = 'admin'").get())?.id;
}

router.post('/users', requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email || !b.password || !b.role_id) {
    return res.status(400).json({ error: 'Name, email, password and role are required' });
  }
  if (!passwordIsStrong(b.password)) {
    return res.status(400).json({ error: 'Password must be at least 9 characters, contain a capital letter and a number' });
  }
  if (req.user.role_name === 'manager' && Number(b.role_id) === await adminRoleId()) {
    return res.status(403).json({ error: 'Only an admin can create admin users' });
  }
  try {
    const info = await dbx.prepare(`
      INSERT INTO users (name, email, password_hash, phone, role_id, customer_id, rep_code, warehouse_id, sales_target, home_address, home_lat, home_lng, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(b.name, b.email, bcrypt.hashSync(b.password, 12), b.phone || null, b.role_id, b.customer_id || null, b.rep_code || null, b.warehouse_id || null, b.sales_target || 0,
      b.home_address || null, b.home_lat ?? null, b.home_lng ?? null);
    res.json({ id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Email already in use' });
  }
});

router.put('/users/:id', requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body || {};
  const existing = await dbx.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  if (req.user.role_name === 'manager' &&
      (existing.role_id === await adminRoleId() || (b.role_id != null && Number(b.role_id) === await adminRoleId()))) {
    return res.status(403).json({ error: 'Only an admin can manage admin users' });
  }
  if (b.password && !passwordIsStrong(b.password)) {
    return res.status(400).json({ error: 'Password must be at least 9 characters, contain a capital letter and a number' });
  }
  await dbx.prepare(`
    UPDATE users SET name = ?, email = ?, phone = ?, role_id = ?, customer_id = ?, rep_code = ?, warehouse_id = ?, sales_target = ?, active = ?,
      home_address = ?, home_lat = ?, home_lng = ?
    WHERE id = ?
  `).run(
    b.name ?? existing.name, b.email ?? existing.email, b.phone ?? existing.phone,
    b.role_id ?? existing.role_id,
    b.customer_id ?? existing.customer_id, b.rep_code ?? existing.rep_code, b.warehouse_id ?? existing.warehouse_id,
    b.sales_target ?? existing.sales_target, b.active ?? existing.active,
    b.home_address ?? existing.home_address, b.home_lat ?? existing.home_lat, b.home_lng ?? existing.home_lng,
    req.params.id
  );
  if (b.password) {
    // An admin setting someone's password is usually a response to that account
    // being compromised or handed over, so it ends that user's live sessions too.
    await dbx.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?')
      .run(bcrypt.hashSync(b.password, 12), req.params.id);
  }

  // Handle manager warehouse assignments
  const roleId = b.role_id ?? existing.role_id;
  const roleInfo = await dbx.prepare('SELECT name FROM roles WHERE id = ?').get(roleId);
  if (roleInfo?.name === 'manager' && b.manager_warehouses) {
    // Clear existing manager warehouse assignments
    await dbx.prepare('DELETE FROM manager_warehouses WHERE manager_id = ?').run(req.params.id);
    // Add new ones
    const stmt = dbx.prepare('INSERT INTO manager_warehouses (manager_id, warehouse_id) VALUES (?, ?)');
    for (const warehouseId of b.manager_warehouses) {
      await stmt.run(req.params.id, warehouseId);
    }
  } else if (roleInfo?.name !== 'manager') {
    // Clear manager warehouse assignments if no longer a manager
    await dbx.prepare('DELETE FROM manager_warehouses WHERE manager_id = ?').run(req.params.id);
  }

  res.json({ ok: true });
});

router.delete('/users/:id', requireRole('admin', 'manager'), async (req, res) => {
  const existing = await dbx.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  if (req.user.role_name === 'manager' && existing.role_id === await adminRoleId()) {
    return res.status(403).json({ error: 'Only an admin can delete admin users' });
  }
  // GPS ping history is live-map telemetry with no business value once the
  // account is gone - clear it first so it never blocks an otherwise-clean delete.
  await dbx.prepare('DELETE FROM rep_locations WHERE user_id = ?').run(req.params.id);
  try {
    await dbx.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  } catch (e) {
    // A rep with orders/customers/visits/quotes is referenced elsewhere, so a
    // hard delete would break that history. Guide the admin to deactivate.
    if (isConstraintViolation(e)) {
      return res.status(409).json({
        error: 'This user has linked records (orders, customers, visits or quotes) and can’t be deleted. Set them to Inactive instead.'
      });
    }
    throw e;
  }
  await logActivity(req.user.id, 'delete', 'user', Number(req.params.id), { name: existing.name });
  res.json({ ok: true });
});

// Send login details email to a user with temporary password
router.post('/users/:id/send-login-details', requireRole('admin', 'manager'), async (req, res) => {
  const user = await dbx.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (req.user.role_name === 'manager' && user.role_id === await adminRoleId()) {
    return res.status(403).json({ error: 'Only an admin can send login details to admin users' });
  }

  // Generate temporary password (9+ chars, capital letter, number)
  const tempPassword = 'Welcome' + Math.random().toString(36).substring(2, 8).charAt(0).toUpperCase() + Math.floor(Math.random() * 90) + 1;

  try {
    // Update user with temp password and must_change_password flag
    await dbx.prepare(`
      UPDATE users SET
        password_hash = ?,
        must_change_password = 1,
        token_version = token_version + 1
      WHERE id = ?
    `).run(bcrypt.hashSync(tempPassword, 12), req.params.id);

    // Send welcome email. sendEmail logs the outcome instead of throwing, so
    // check the result - the password has already been reset at this point.
    const sent = await sendEmail(buildLoginDetailsEmail(user, tempPassword));
    if (sent.status !== 'sent') {
      console.error('Login details email not sent:', sent.error);
      return res.status(502).json({ error: `Password was reset but the email was not sent (${sent.error || 'unknown error'}). Use Send login details again once email is working.` });
    }

    await logActivity(req.user.id, 'send', 'user-login-details', user.id, { name: user.name, email: user.email });
    res.json({ ok: true, message: `Login details sent to ${user.email}` });
  } catch (e) {
    console.error('Failed to send login details email:', e);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// --- Monthly budgets ---

router.get('/budgets/:repId', requireRole('admin', 'manager'), async (req, res) => {
  const budgets = await dbx.prepare(`
    SELECT month, budget FROM rep_budgets
    WHERE rep_id = ? ORDER BY month
  `).all(req.params.repId);

  // Return all 12 months, filling in 0 for missing months
  const result = {};
  for (let m = 1; m <= 12; m++) {
    const found = budgets.find(b => b.month === m);
    result[m] = found ? found.budget : 0;
  }
  res.json(result);
});

router.put('/budgets/:repId', requireRole('admin', 'manager'), async (req, res) => {
  const budgets = req.body || {};
  const repId = req.params.repId;

  try {
    await dbx.transaction(async (tx) => {
      for (let month = 1; month <= 12; month++) {
        const budget = Number(budgets[month]) || 0;
        await tx.upsert('rep_budgets', {
          keys: { rep_id: repId, month },
          set: { budget },
          now: ['updated_at']
        });
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
