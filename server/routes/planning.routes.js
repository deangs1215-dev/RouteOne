// Phase 3: route planning, visit-frequency coverage, rep locations, rep KPIs.
import { Router } from 'express';
import { db, logActivity, distanceM } from '../db.js';
import { requireRole, scopeForUser } from '../auth.js';

const router = Router();

const FREQUENCY_DAYS = { weekly: 7, biweekly: 14, monthly: 30 };

// --- Route planning ----------------------------------------------------------

// The planned route for one rep on one date, in stop order.
router.get('/routes', (req, res) => {
  const scope = scopeForUser(req.user);
  const repId = scope.isRep ? req.user.id : req.query.rep_id;
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  if (!repId) return res.status(400).json({ error: 'rep_id is required' });
  const visits = db.prepare(`
    SELECT v.*, c.name AS customer_name, c.address, c.city, c.lat AS customer_lat, c.lng AS customer_lng,
      c.visit_frequency, c.classification,
      (SELECT COUNT(*) FROM orders o WHERE o.visit_id = v.id) AS order_count
    FROM visits v JOIN customers c ON c.id = v.customer_id
    WHERE v.rep_id = ? AND date(COALESCE(v.check_in_at, v.planned_date)) = date(?)
    ORDER BY v.route_order IS NULL, v.route_order, v.id
  `).all(repId, date);
  res.json(visits);
});

// Add a stop to a rep's route for a date.
router.post('/routes/stops', (req, res) => {
  const b = req.body || {};
  const scope = scopeForUser(req.user);
  const repId = scope.isRep ? req.user.id : b.rep_id;
  if (!b.customer_id || !repId) return res.status(400).json({ error: 'Customer and rep are required' });
  const date = b.date || new Date().toISOString().slice(0, 10);
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(route_order), 0) AS m FROM visits WHERE rep_id = ? AND date(planned_date) = date(?)'
  ).get(repId, date).m;
  const info = db.prepare(`
    INSERT INTO visits (customer_id, rep_id, planned_date, purpose, status, route_order)
    VALUES (?, ?, ?, ?, 'planned', ?)
  `).run(b.customer_id, repId, date, b.purpose || 'sales call', maxOrder + 1);
  logActivity(req.user.id, 'route_add', 'visit', info.lastInsertRowid);
  res.json(db.prepare('SELECT * FROM visits WHERE id = ?').get(info.lastInsertRowid));
});

// Remove a planned (not yet started) stop.
router.delete('/routes/stops/:visitId', (req, res) => {
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.visitId);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (visit.status !== 'planned') return res.status(400).json({ error: 'Only planned stops can be removed' });
  db.prepare('DELETE FROM visits WHERE id = ?').run(visit.id);
  res.json({ ok: true });
});

// Reorder stops: body is { visit_ids: [id, id, ...] } in the desired order.
router.put('/routes/reorder', (req, res) => {
  const ids = req.body?.visit_ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'visit_ids array is required' });
  const update = db.prepare('UPDATE visits SET route_order = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => update.run(i + 1, id)))();
  res.json({ ok: true });
});

// Nearest-neighbour optimisation over the day's planned stops. Starts from the
// rep's last known location if we have one, otherwise the first stop.
router.post('/routes/optimize', (req, res) => {
  const b = req.body || {};
  const scope = scopeForUser(req.user);
  const repId = scope.isRep ? req.user.id : b.rep_id;
  const date = b.date || new Date().toISOString().slice(0, 10);
  const stops = db.prepare(`
    SELECT v.id, c.lat, c.lng FROM visits v JOIN customers c ON c.id = v.customer_id
    WHERE v.rep_id = ? AND date(v.planned_date) = date(?) AND v.status = 'planned'
  `).all(repId, date);
  if (stops.length < 2) return res.json({ ok: true, order: stops.map((s) => s.id) });

  const start = db.prepare(
    'SELECT lat, lng FROM rep_locations WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1'
  ).get(repId);

  const remaining = [...stops];
  const ordered = [];
  let cur = start || remaining[0];
  if (!start) ordered.push(remaining.shift());
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = distanceM(cur.lat, cur.lng, s.lat, s.lng) ?? Infinity;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    cur = remaining[bestIdx];
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }

  const update = db.prepare('UPDATE visits SET route_order = ? WHERE id = ?');
  db.transaction(() => ordered.forEach((s, i) => update.run(i + 1, s.id)))();
  logActivity(req.user.id, 'route_optimize', 'visit', null, { rep_id: repId, date, stops: ordered.length });
  res.json({ ok: true, order: ordered.map((s) => s.id) });
});

// --- Visit-frequency coverage --------------------------------------------------

// Every active customer with how overdue their next visit is. due_in_days < 0
// means overdue by that many days.
router.get('/coverage', (req, res) => {
  const scope = scopeForUser(req.user);
  const where = scope.isRep ? 'AND c.rep_id = ?' : '';
  const params = scope.isRep ? [req.user.id] : [];
  const rows = db.prepare(`
    SELECT c.id, c.name, c.city, c.classification, c.visit_frequency, c.lat, c.lng,
      u.name AS rep_name, c.rep_id,
      (SELECT MAX(v.check_in_at) FROM visits v WHERE v.customer_id = c.id AND v.status = 'completed') AS last_visit_at,
      (SELECT COUNT(*) FROM visits v WHERE v.customer_id = c.id AND v.status = 'planned' AND date(v.planned_date) >= date('now')) AS upcoming_planned
    FROM customers c
    LEFT JOIN users u ON u.id = c.rep_id
    WHERE c.status = 'active' ${where}
    ORDER BY c.name
  `).all(...params);

  const today = new Date();
  res.json(rows.map((c) => {
    const freqDays = FREQUENCY_DAYS[c.visit_frequency] || 30;
    const daysSince = c.last_visit_at
      ? Math.floor((today - new Date(c.last_visit_at.replace(' ', 'T'))) / 86400000)
      : null;
    const dueIn = daysSince === null ? -freqDays : freqDays - daysSince;
    return { ...c, frequency_days: freqDays, days_since_visit: daysSince, due_in_days: dueIn, overdue: dueIn < 0 ? 1 : 0 };
  }));
});

// --- Rep locations (live map) ---------------------------------------------------

router.post('/locations', (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng are required' });
  db.prepare('INSERT INTO rep_locations (user_id, lat, lng) VALUES (?, ?, ?)').run(req.user.id, lat, lng);
  // Keep only the last 50 pings per rep.
  db.prepare(`
    DELETE FROM rep_locations WHERE user_id = ? AND id NOT IN
      (SELECT id FROM rep_locations WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 50)
  `).run(req.user.id, req.user.id);
  res.json({ ok: true });
});

router.get('/locations/latest', requireRole('admin', 'manager', 'office'), (req, res) => {
  res.json(db.prepare(`
    SELECT rl.user_id, u.name, rl.lat, rl.lng, rl.recorded_at
    FROM rep_locations rl
    JOIN users u ON u.id = rl.user_id
    WHERE rl.id IN (SELECT MAX(id) FROM rep_locations GROUP BY user_id)
      AND u.active = 1
  `).all());
});

// --- Rep KPIs -------------------------------------------------------------------

// Month KPIs per rep: sales vs target, activity, compliance, strike rate.
router.get('/kpis', requireRole('admin', 'manager', 'office'), (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
  const start = `${month}-01`;
  const reps = db.prepare(`
    SELECT u.id, u.name, u.sales_target, t.name AS territory_name
    FROM users u JOIN roles r ON r.id = u.role_id
    LEFT JOIN territories t ON t.id = u.territory_id
    WHERE r.name = 'rep' AND u.active = 1
  `).all();

  const kpis = reps.map((rep) => {
    const sales = db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS orders, COALESCE(AVG(total), 0) AS aov
      FROM orders WHERE rep_id = ? AND status != 'cancelled'
        AND strftime('%Y-%m', order_date) = ?
    `).get(rep.id, month);
    const visits = db.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed,
        COUNT(CASE WHEN status IN ('planned', 'missed') AND date(planned_date) < date('now') THEN 1 END) AS missed,
        COUNT(CASE WHEN planned_date IS NOT NULL THEN 1 END) AS planned,
        COALESCE(SUM(CASE WHEN check_in_at IS NOT NULL AND check_out_at IS NOT NULL
          THEN (julianday(check_out_at) - julianday(check_in_at)) * 24 END), 0) AS hours_on_site
      FROM visits WHERE rep_id = ? AND strftime('%Y-%m', COALESCE(check_in_at, planned_date)) = ?
    `).get(rep.id, month);
    const coverage = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM customers WHERE rep_id = ? AND status = 'active') AS assigned,
        (SELECT COUNT(DISTINCT customer_id) FROM visits
          WHERE rep_id = ? AND status = 'completed' AND strftime('%Y-%m', check_in_at) = ?) AS visited
    `).get(rep.id, rep.id, month);
    const quotes = db.prepare(`
      SELECT COUNT(*) AS total, COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted
      FROM quotes WHERE rep_id = ? AND strftime('%Y-%m', quote_date) = ?
    `).get(rep.id, month);

    return {
      rep_id: rep.id,
      name: rep.name,
      territory: rep.territory_name,
      sales: sales.total,
      target: rep.sales_target,
      target_pct: rep.sales_target ? Math.round((sales.total / rep.sales_target) * 100) : null,
      orders: sales.orders,
      avg_order_value: sales.aov,
      visits_completed: visits.completed,
      visits_missed: visits.missed,
      compliance_pct: visits.planned ? Math.round((visits.completed / visits.planned) * 100) : null,
      strike_rate_pct: visits.completed ? Math.round((sales.orders / visits.completed) * 100) : null,
      hours_on_site: Math.round(visits.hours_on_site * 10) / 10,
      customers_assigned: coverage.assigned,
      customers_visited: coverage.visited,
      coverage_pct: coverage.assigned ? Math.round((coverage.visited / coverage.assigned) * 100) : null,
      quotes: quotes.total,
      quotes_accepted: quotes.accepted
    };
  });

  res.json({ month, kpis: kpis.sort((a, b) => b.sales - a.sales) });
});

export default router;
