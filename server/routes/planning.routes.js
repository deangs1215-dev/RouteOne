// Phase 3: route planning, visit-frequency coverage, rep locations, rep KPIs.
import { Router } from 'express';
import { dbx, distanceM, getTodayISO } from '../db.js';
import { logActivity, repMonthTarget } from '../dbh.js';
import { requireRole, scopeForUser, userCanAccessCustomerAsync } from '../auth.js';

const router = Router();

const FREQUENCY_DAYS = { weekly: 7, biweekly: 14, monthly: 30 };

// --- Route planning ----------------------------------------------------------

// The planned route for one rep on one date, in stop order.
router.get('/routes', async (req, res) => {
  const scope = scopeForUser(req.user);
  const repId = scope.isRep ? req.user.id : req.query.rep_id;
  const date = req.query.date || getTodayISO();
  if (!repId) return res.status(400).json({ error: 'rep_id is required' });
  const visits = await dbx.prepare(`
    SELECT v.*, c.name AS customer_name, c.address, c.city, c.lat AS customer_lat, c.lng AS customer_lng,
      c.visit_frequency, c.classification,
      (SELECT COUNT(*) FROM orders o WHERE o.visit_id = v.id) AS order_count
    FROM visits v JOIN customers c ON c.id = v.customer_id
    WHERE v.rep_id = ? AND date(COALESCE(v.check_in_at, v.planned_date)) = date(?)
    ORDER BY CASE WHEN v.route_order IS NULL THEN 1 ELSE 0 END, v.route_order, v.id
  `).all(repId, date);
  res.json(visits);
});

// Add a stop to a rep's route for a date.
router.post('/routes/stops', async (req, res) => {
  const b = req.body || {};
  const scope = scopeForUser(req.user);
  const repId = scope.isRep ? req.user.id : b.rep_id;
  if (!b.customer_id || !repId) return res.status(400).json({ error: 'Customer and rep are required' });
  if (!await dbx.prepare('SELECT 1 FROM customers WHERE id = ?').get(b.customer_id)) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  if (!await dbx.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(repId)) {
    return res.status(404).json({ error: 'Rep not found' });
  }
  if (!await userCanAccessCustomerAsync(req.user, b.customer_id)) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  const date = b.date || getTodayISO();
  const maxOrder = (await dbx.prepare(
    'SELECT COALESCE(MAX(route_order), 0) AS m FROM visits WHERE rep_id = ? AND date(planned_date) = date(?)'
  ).get(repId, date)).m;
  const info = await dbx.prepare(`
    INSERT INTO visits (customer_id, rep_id, planned_date, purpose, status, route_order)
    VALUES (?, ?, ?, ?, 'planned', ?)
  `).run(b.customer_id, repId, date, b.purpose || 'sales call', maxOrder + 1);
  await logActivity(req.user.id, 'route_add', 'visit', info.lastInsertRowid);
  res.json(await dbx.prepare('SELECT * FROM visits WHERE id = ?').get(info.lastInsertRowid));
});

// Remove a planned (not yet started) stop.
router.delete('/routes/stops/:visitId', async (req, res) => {
  const visit = await dbx.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.visitId);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (scopeForUser(req.user).isRep && visit.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your route stop' });
  }
  if (visit.status !== 'planned') return res.status(400).json({ error: 'Only planned stops can be removed' });
  await dbx.prepare('DELETE FROM visits WHERE id = ?').run(visit.id);
  res.json({ ok: true });
});

// Reorder stops: body is { visit_ids: [id, id, ...] } in the desired order.
router.put('/routes/reorder', async (req, res) => {
  const ids = req.body?.visit_ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'visit_ids array is required' });
  // Reps may only reorder their own visits - the WHERE clause makes any
  // foreign id a silent no-op rather than a cross-rep write.
  const scope = scopeForUser(req.user);
  await dbx.transaction(async (tx) => {
    const update = scope.isRep
      ? tx.prepare('UPDATE visits SET route_order = ? WHERE id = ? AND rep_id = ?')
      : tx.prepare('UPDATE visits SET route_order = ? WHERE id = ?');
    for (const [i, id] of ids.entries()) {
      if (scope.isRep) await update.run(i + 1, id, req.user.id);
      else await update.run(i + 1, id);
    }
  });
  res.json({ ok: true });
});

// Where a rep's day begins, for anchoring the route optimiser and the map.
// Priority: today's earliest GPS ping (the rep opening the app for the day,
// usually at home before their first stop) > their saved home/office address
// > their most recent GPS ping ever (stale, but better than nothing) > null
// (falls back to the first planned stop).
async function dayStart(repId, date) {
  const todaysEarliest = await dbx.prepare(`
    SELECT lat, lng, recorded_at FROM rep_locations
    WHERE user_id = ? AND date(recorded_at) = date(?)
    ORDER BY recorded_at ASC LIMIT 1
  `).get(repId, date);
  if (todaysEarliest) return { ...todaysEarliest, source: 'gps_today' };

  const home = await dbx.prepare('SELECT home_lat AS lat, home_lng AS lng, home_address FROM users WHERE id = ?').get(repId);
  if (home?.lat != null && home?.lng != null) return { ...home, source: 'home' };

  const lastKnown = await dbx.prepare(
    'SELECT lat, lng, recorded_at FROM rep_locations WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1'
  ).get(repId);
  if (lastKnown) return { ...lastKnown, source: 'gps_stale' };

  return null;
}

// The anchor point for a rep's route on a given date — used to draw the
// "start here" pin on the Routes map and to seed the optimiser below.
router.get('/routes/start', async (req, res) => {
  const scope = scopeForUser(req.user);
  const repId = scope.isRep ? req.user.id : req.query.rep_id;
  const date = req.query.date || getTodayISO();
  if (!repId) return res.status(400).json({ error: 'rep_id is required' });
  res.json(await dayStart(repId, date) || { lat: null, lng: null, source: 'none' });
});

// Nearest-neighbour optimisation over the day's planned stops. Starts from
// the rep's day-start anchor (see dayStart above), otherwise the first stop.
router.post('/routes/optimize', async (req, res) => {
  const b = req.body || {};
  const scope = scopeForUser(req.user);
  const repId = scope.isRep ? req.user.id : b.rep_id;
  const date = b.date || getTodayISO();
  if (!repId) return res.status(400).json({ error: 'rep_id is required' });
  const stops = await dbx.prepare(`
    SELECT v.id, c.lat, c.lng FROM visits v JOIN customers c ON c.id = v.customer_id
    WHERE v.rep_id = ? AND date(v.planned_date) = date(?) AND v.status = 'planned'
  `).all(repId, date);
  if (stops.length < 2) return res.json({ ok: true, order: stops.map((s) => s.id) });

  const start = await dayStart(repId, date);

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

  await dbx.transaction(async (tx) => {
    const update = tx.prepare('UPDATE visits SET route_order = ? WHERE id = ?');
    for (const [i, stop] of ordered.entries()) await update.run(i + 1, stop.id);
  });
  await logActivity(req.user.id, 'route_optimize', 'visit', null, { rep_id: repId, date, stops: ordered.length, start_source: start?.source || 'first_stop' });
  res.json({ ok: true, order: ordered.map((s) => s.id) });
});

// --- Visit-frequency coverage --------------------------------------------------

// Every active customer with how overdue their next visit is. due_in_days < 0
// means overdue by that many days.
router.get('/coverage', async (req, res) => {
  const scope = scopeForUser(req.user);
  const where = scope.isRep ? 'AND c.rep_id = ?' : '';
  const params = scope.isRep ? [req.user.id] : [];
  const rows = await dbx.prepare(`
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

router.post('/locations', async (req, res) => {
  const { lat, lng } = req.body || {};
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return res.status(400).json({ error: 'Valid lat and lng are required' });
  }
  await dbx.prepare('INSERT INTO rep_locations (user_id, lat, lng) VALUES (?, ?, ?)').run(req.user.id, latitude, longitude);
  // Keep only the last 50 pings per rep.
  await dbx.prepare(`
    DELETE FROM rep_locations WHERE user_id = ? AND id NOT IN
      (SELECT id FROM rep_locations WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 50)
  `).run(req.user.id, req.user.id);
  res.json({ ok: true });
});

router.get('/locations/latest', requireRole('admin', 'manager', 'office'), async (req, res) => {
  res.json(await dbx.prepare(`
    SELECT rl.user_id, u.name, rl.lat, rl.lng, rl.recorded_at
    FROM rep_locations rl
    JOIN users u ON u.id = rl.user_id
    WHERE rl.id IN (SELECT MAX(id) FROM rep_locations GROUP BY user_id)
      AND u.active = 1
  `).all());
});

// --- Rep KPIs -------------------------------------------------------------------

// Month KPIs per rep: sales vs target, activity, compliance, strike rate.
router.get('/kpis', requireRole('admin', 'manager', 'office', 'rep'), async (req, res) => {
  const scope = scopeForUser(req.user);
  const month = req.query.month || getTodayISO().slice(0, 7); // YYYY-MM
  const monthNum = Number(month.slice(5, 7));
  const year = month.slice(0, 4);
  const start = `${month}-01`;
  const reps = await dbx.prepare(`
    SELECT u.id, u.name, u.sales_target
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'rep' AND u.active = 1 ${scope.isRep ? 'AND u.id = ?' : ''}
  `).all(...(scope.isRep ? [req.user.id] : []));

  const kpis = [];
  for (const rep of reps) {
    // Orders/AOV are app-native activity (orders actually captured in RouteOne);
    // the sales total itself comes from SYSPRO's actual invoiced sales
    // (rep_monthly_sales, synced from vw_FS_RepSalesByMonth) so "vs target"
    // reflects real sales, not just what happened to be placed through the app.
    const orderStats = await dbx.prepare(`
      SELECT COUNT(*) AS orders, COALESCE(AVG(total), 0) AS aov
      FROM orders WHERE rep_id = ? AND status != 'cancelled'
        AND strftime('%Y-%m', order_date) = ?
    `).get(rep.id, month);
    const repSales = await dbx.prepare(`
      SELECT sales_value FROM rep_monthly_sales WHERE rep_id = ? AND month = ?
    `).get(rep.id, month) || { sales_value: 0 };
    const visits = await dbx.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed,
        COUNT(CASE WHEN status IN ('planned', 'missed') AND date(planned_date) < date('now') THEN 1 END) AS missed,
        COUNT(CASE WHEN planned_date IS NOT NULL THEN 1 END) AS planned,
        COALESCE(SUM(CASE WHEN check_in_at IS NOT NULL AND check_out_at IS NOT NULL
          THEN (julianday(check_out_at) - julianday(check_in_at)) * 24 END), 0) AS hours_on_site
      FROM visits WHERE rep_id = ? AND strftime('%Y-%m', COALESCE(check_in_at, planned_date)) = ?
    `).get(rep.id, month);
    const coverage = await dbx.prepare(`
      SELECT
        (SELECT COUNT(*) FROM customers WHERE rep_id = ? AND status = 'active') AS assigned,
        (SELECT COUNT(DISTINCT customer_id) FROM visits
          WHERE rep_id = ? AND status = 'completed' AND strftime('%Y-%m', check_in_at) = ?) AS visited
    `).get(rep.id, rep.id, month);
    const quotes = await dbx.prepare(`
      SELECT COUNT(*) AS total, COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted
      FROM quotes WHERE rep_id = ? AND strftime('%Y-%m', quote_date) = ?
    `).get(rep.id, month);

    // Target rolls automatically with the selected month: a rep_budgets figure
    // for that month if set, otherwise the flat sales_target fallback.
    const target = await repMonthTarget(rep.id, monthNum);

    // R1-056: YTD = January through the selected month, not the full 12-month
    // annual target - comparing e.g. September YTD sales against a full-year
    // target would understate achievement for 3/4 of the year by design, not
    // by mistake, which is exactly the misleading percentage the ticket calls
    // out. Both sides of the fraction stop at the same month for that reason.
    const ytdSales = (await dbx.prepare(`
      SELECT COALESCE(SUM(sales_value), 0) AS total FROM rep_monthly_sales
      WHERE rep_id = ? AND month >= ? AND month <= ?
    `).get(rep.id, `${year}-01`, month)).total;
    let ytdTarget = 0;
    for (let m = 1; m <= monthNum; m++) ytdTarget += await repMonthTarget(rep.id, m);

    kpis.push({
      rep_id: rep.id,
      name: rep.name,
      sales: repSales.sales_value,
      target,
      target_pct: target ? Math.round((repSales.sales_value / target) * 100) : null,
      ytd_sales: ytdSales,
      ytd_target: ytdTarget,
      ytd_target_pct: ytdTarget ? Math.round((ytdSales / ytdTarget) * 100) : null,
      orders: orderStats.orders,
      avg_order_value: orderStats.aov,
      visits_completed: visits.completed,
      visits_missed: visits.missed,
      compliance_pct: visits.planned ? Math.round((visits.completed / visits.planned) * 100) : null,
      strike_rate_pct: visits.completed ? Math.round((orderStats.orders / visits.completed) * 100) : null,
      hours_on_site: Math.round(visits.hours_on_site * 10) / 10,
      customers_assigned: coverage.assigned,
      customers_visited: coverage.visited,
      coverage_pct: coverage.assigned ? Math.round((coverage.visited / coverage.assigned) * 100) : null,
      quotes: quotes.total,
      quotes_accepted: quotes.accepted
    });
  }

  res.json({ month, kpis: kpis.sort((a, b) => b.sales - a.sales) });
});

// Reps x current-calendar-year sales grid, for the "Monthly history" tab on
// Rep KPIs. Sourced from rep_monthly_sales (SYSPRO's actual invoiced sales,
// synced from vw_FS_RepSalesByMonth) - the same source as the current-month
// "sales vs target" figure on /kpis, not RouteOne's own order-capture.
router.get('/kpis/monthly-history', requireRole('admin', 'manager', 'office', 'rep'), async (req, res) => {
  const scope = scopeForUser(req.user);
  const reps = await dbx.prepare(`
    SELECT u.id, u.name
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'rep' AND u.active = 1 ${scope.isRep ? 'AND u.id = ?' : ''}
    ORDER BY u.name
  `).all(...(scope.isRep ? [req.user.id] : []));

  // January to December of the current calendar year (resets each January).
  const year = new Date().getFullYear();
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

  const salesByMonth = await dbx.prepare(`
    SELECT rep_id, month, sales_value
    FROM rep_monthly_sales
    WHERE month >= ? AND month <= ?
  `).all(months[0], months[11]);

  const byRep = new Map(reps.map((r) => [r.id, { rep_id: r.id, name: r.name, months: Object.fromEntries(months.map((m) => [m, 0])), total: 0 }]));
  for (const row of salesByMonth) {
    const entry = byRep.get(row.rep_id);
    if (entry && row.month in entry.months) {
      entry.months[row.month] = row.sales_value;
      entry.total += row.sales_value;
    }
  }

  res.json({ months, reps: [...byRep.values()].sort((a, b) => b.total - a.total) });
});

export default router;
