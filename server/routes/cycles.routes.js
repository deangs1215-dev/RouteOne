// Phase 5: call-cycle route plans and compliance.
// A rep follows a fixed N-week plan (loaded from the planning sheet). Compliance
// = of the customers planned for a period, how many were actually visited.
// Default matching is "same week": a planned customer counts as visited if the
// rep checked in to them any day in that calendar week (Mon–Sun).
import { Router } from 'express';
import { dbx, getTodayISO } from '../db.js';
import { logActivity, repMonthTarget, repTargetLookup } from '../dbh.js';
import { requireRole, scopeForUser } from '../auth.js';

const router = Router();

// --- date helpers (local, no timezone drift) ---------------------------------
const toDate = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
const addDays = (dt, n) => { const c = new Date(dt); c.setDate(c.getDate() + n); return c; };
// Monday of the given date's week (getDay: 0=Sun..6=Sat → Mon=1).
const mondayOf = (dt) => { const day = (dt.getDay() + 6) % 7; return addDays(dt, -day); };
const weeksBetween = (a, b) => Math.round((mondayOf(b) - mondayOf(a)) / (7 * 86400000));

// --- Import a schedule --------------------------------------------------------
// Body: { rep_id, name?, start_date, repeat_count?, cycle_weeks?,
//         weeks: [{ week_no, days: { Monday:[codes], Tuesday:[...], ... } }] }
// Weekday keys map Monday..Friday → 1..5. Codes resolve to customers via code.
// rep_code is taken from the selected rep's own record, not the request body.
router.post('/route-cycles/import', requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body || {};
  if (!b.rep_id) return res.status(400).json({ error: 'A rep must be selected' });
  if (!b.start_date) return res.status(400).json({ error: 'Start date is required' });
  if (!Array.isArray(b.weeks) || b.weeks.length === 0) return res.status(400).json({ error: 'No schedule weeks were provided' });

  const rep = await dbx.prepare('SELECT id, name, rep_code FROM users WHERE id = ?').get(b.rep_id);
  if (!rep) return res.status(404).json({ error: 'Rep not found' });

  const WEEKDAYS = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5 };
  const findCustomer = dbx.prepare('SELECT id FROM customers WHERE code = ?');

  const unmatched = new Set();
  let matched = 0;
  const rows = [];
  for (const wk of b.weeks) {
    const weekNo = Number(wk.week_no);
    if (!weekNo) continue;
    for (const [dayName, codes] of Object.entries(wk.days || {})) {
      const weekday = WEEKDAYS[String(dayName).trim().toLowerCase()];
      if (!weekday || !Array.isArray(codes)) continue;
      for (const [i, raw] of codes.entries()) {
        const code = String(raw).trim();
        if (!code) continue;
        const cust = await findCustomer.get(code);
        if (cust) matched++; else unmatched.add(code);
        rows.push({ weekNo, weekday, customer_id: cust ? cust.id : null, code, seq: i + 1 });
      }
    }
  }
  if (rows.length === 0) return res.status(400).json({ error: 'No customer codes found in the pasted schedule' });

  const cycleWeeks = Number(b.cycle_weeks) || Math.max(...rows.map((r) => r.weekNo));
  const cycleId = await dbx.transaction(async (tx) => {
    // One active cycle per rep: retire any previous one.
    await tx.prepare('UPDATE route_cycles SET active = 0 WHERE rep_id = ? AND active = 1').run(b.rep_id);
    const info = await tx.prepare(`
      INSERT INTO route_cycles (rep_id, name, rep_code, start_date, cycle_weeks, repeat_count, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(b.rep_id, b.name || `${rep.name} call cycle`, rep.rep_code || b.rep_code || null,
      b.start_date.slice(0, 10), cycleWeeks, Number(b.repeat_count) || 1);
    const cycleId = info.lastInsertRowid;
    const insert = tx.prepare(`
      INSERT INTO route_cycle_stops (cycle_id, week_no, weekday, customer_id, customer_code, seq)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) await insert.run(cycleId, r.weekNo, r.weekday, r.customer_id, r.code, r.seq);
    return cycleId;
  });
  await logActivity(req.user.id, 'import', 'route_cycle', cycleId, { rep_id: b.rep_id, stops: rows.length });

  res.json({
    cycle_id: cycleId, rep_id: b.rep_id, cycle_weeks: cycleWeeks,
    total_stops: rows.length, matched, unmatched: [...unmatched]
  });
});

// List cycles for a rep (most recent first).
router.get('/route-cycles', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const { rep_id } = req.query;
  const where = rep_id ? 'WHERE rc.rep_id = ?' : '';
  const params = rep_id ? [rep_id] : [];
  res.json(await dbx.prepare(`
    SELECT rc.*, u.name AS rep_name,
      (SELECT COUNT(*) FROM route_cycle_stops s WHERE s.cycle_id = rc.id) AS stop_count,
      (SELECT COUNT(*) FROM route_cycle_stops s WHERE s.cycle_id = rc.id AND s.customer_id IS NULL) AS unmatched_count
    FROM route_cycles rc JOIN users u ON u.id = rc.rep_id
    ${where} ORDER BY rc.active DESC, rc.created_at DESC
  `).all(...params));
});

// --- Upcoming schedule (rep's own view, or office looking up any rep) -------
// Projects the abstract Week 1..N pattern onto real calendar dates going
// forward from today, so a rep can see what's actually coming up rather than
// the raw template. Reuses the same date math as /route-compliance, but
// forward-looking and broken out per weekday (not just a per-week total).
// Registered ABOVE /route-cycles/:id - otherwise Express would match "upcoming"
// as the :id param and this route would never be reached.
router.get('/route-cycles/upcoming', async (req, res) => {
  const { isRep } = scopeForUser(req.user);
  let repId;
  if (isRep) {
    if (req.query.rep_id && Number(req.query.rep_id) !== req.user.id) {
      return res.status(403).json({ error: 'Reps can only view their own call cycle' });
    }
    repId = req.user.id;
  } else {
    repId = req.query.rep_id;
    if (!repId) return res.status(400).json({ error: 'rep_id is required' });
  }
  const weeksAhead = Math.min(Math.max(Number(req.query.weeks) || 6, 1), 12);

  const cycle = await dbx.prepare('SELECT * FROM route_cycles WHERE rep_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1').get(repId);
  if (!cycle) return res.json({ rep_id: Number(repId), has_cycle: false });

  const stops = await dbx.prepare(`
    SELECT s.week_no, s.weekday, s.seq, s.customer_id, s.customer_code,
      c.name AS customer_name, c.city AS customer_city
    FROM route_cycle_stops s LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.cycle_id = ? AND s.customer_id IS NOT NULL
    ORDER BY s.week_no, s.weekday, s.seq
  `).all(cycle.id);
  const stopsByWeekNo = {};
  for (const s of stops) (stopsByWeekNo[s.week_no] ||= []).push(s);

  const WEEKDAY_NAME = { 1: 'monday', 2: 'tuesday', 3: 'wednesday', 4: 'thursday', 5: 'friday' };
  const WEEKDAY_OFFSET = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4 }; // days after that week's Monday
  const start = toDate(cycle.start_date);
  const today = new Date();

  const rangeStart = mondayOf(today < start ? start : today);
  const rangeEnd = iso(addDays(rangeStart, weeksAhead * 7));
  // Actual visit status (if any) for each customer on each concrete calendar
  // date in the window - the cycle stops above are just the recurring
  // template, this is what actually happened (or is planned) for that date.
  const visitRows = await dbx.prepare(`
    SELECT customer_id, planned_date, status FROM visits
    WHERE rep_id = ? AND planned_date >= ? AND planned_date < ?
  `).all(repId, iso(rangeStart), rangeEnd);
  const visitByCustomerDate = {};
  for (const v of visitRows) visitByCustomerDate[`${v.customer_id}|${v.planned_date}`] = v.status;
  const todayIso = iso(today);

  const weeks = [];
  let cursor = rangeStart;
  for (let i = 0; i < weeksAhead; i++) {
    const wSince = weeksBetween(start, cursor);
    if (wSince >= 0) {
      const weekNo = (wSince % cycle.cycle_weeks) + 1;
      const days = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [] };
      for (const s of stopsByWeekNo[weekNo] || []) {
        const dayName = WEEKDAY_NAME[s.weekday];
        if (!dayName) continue;
        const date = iso(addDays(cursor, WEEKDAY_OFFSET[s.weekday]));
        // No visit row yet: an untouched stop reads as "missed" once its date
        // has passed, otherwise it's simply upcoming - not shown as a status.
        const status = visitByCustomerDate[`${s.customer_id}|${date}`] || (date < todayIso ? 'missed' : null);
        days[dayName].push({ customer_id: s.customer_id, code: s.customer_code, name: s.customer_name, city: s.customer_city, date, status });
      }
      weeks.push({ week_start: iso(cursor), cycle_week: weekNo, days });
    }
    cursor = addDays(cursor, 7);
  }

  res.json({
    rep_id: Number(repId), has_cycle: true,
    cycle: { id: cycle.id, name: cycle.name, cycle_weeks: cycle.cycle_weeks },
    weeks
  });
});

// Full grid for one cycle (for viewing/editing).
router.get('/route-cycles/:id', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const cycle = await dbx.prepare('SELECT rc.*, u.name AS rep_name FROM route_cycles rc JOIN users u ON u.id = rc.rep_id WHERE rc.id = ?').get(req.params.id);
  if (!cycle) return res.status(404).json({ error: 'Cycle not found' });
  cycle.stops = await dbx.prepare(`
    SELECT s.*, c.name AS customer_name, c.city
    FROM route_cycle_stops s LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.cycle_id = ? ORDER BY s.week_no, s.weekday, s.seq
  `).all(cycle.id);
  res.json(cycle);
});

router.delete('/route-cycles/:id', requireRole('admin', 'manager'), async (req, res) => {
  await dbx.prepare('DELETE FROM route_cycle_stops WHERE cycle_id = ?').run(req.params.id);
  await dbx.prepare('DELETE FROM route_cycles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Compliance ---------------------------------------------------------------
// Of the customers planned in [from,to], how many were visited that same week.
router.get('/route-compliance', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const repId = req.query.rep_id;
  if (!repId) return res.status(400).json({ error: 'rep_id is required' });

  const cycle = await dbx.prepare('SELECT * FROM route_cycles WHERE rep_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1').get(repId);
  if (!cycle) return res.json({ rep_id: Number(repId), has_cycle: false });

  const today = new Date();
  const from = req.query.from ? toDate(req.query.from) : addDays(mondayOf(today), -21); // default: last 4 weeks
  const to = req.query.to ? toDate(req.query.to) : today;
  const start = toDate(cycle.start_date);

  // Planned customers per (week_no, weekday), grouped for quick lookup.
  const stops = await dbx.prepare(
    'SELECT week_no, weekday, customer_id, customer_code FROM route_cycle_stops WHERE cycle_id = ? AND customer_id IS NOT NULL'
  ).all(cycle.id);
  const plannedByWeekNo = {}; // week_no -> Map(customer_id -> code)
  for (const s of stops) {
    (plannedByWeekNo[s.week_no] ||= new Map()).set(s.customer_id, s.customer_code);
  }

  const visitsInRange = dbx.prepare(`
    SELECT DISTINCT customer_id, date(check_in_at) AS d
    FROM visits WHERE rep_id = ? AND status = 'completed'
      AND check_in_at IS NOT NULL AND date(check_in_at) BETWEEN ? AND ?
  `);

  const weeks = [];
  const missed = [];
  let totalPlanned = 0, totalVisited = 0;

  let cursor = mondayOf(from < start ? start : from);
  const lastMonday = mondayOf(to);
  while (cursor <= lastMonday) {
    const wSince = weeksBetween(start, cursor);
    if (wSince >= 0) {
      const weekNo = (wSince % cycle.cycle_weeks) + 1;
      const planned = plannedByWeekNo[weekNo];
      if (planned && planned.size) {
        const weekStart = iso(cursor);
        const weekEnd = iso(addDays(cursor, 6));
        const visitedRows = await visitsInRange.all(repId, weekStart, weekEnd);
        const visitedSet = new Set(visitedRows.map((r) => r.customer_id));
        let wVisited = 0;
        for (const [custId, code] of planned) {
          if (visitedSet.has(custId)) wVisited++;
          else missed.push({ customer_id: custId, code, week_start: weekStart });
        }
        weeks.push({
          week_start: weekStart, cycle_week: weekNo,
          planned: planned.size, visited: wVisited,
          pct: Math.round((wVisited / planned.size) * 100)
        });
        totalPlanned += planned.size;
        totalVisited += wVisited;
      }
    }
    cursor = addDays(cursor, 7);
  }

  // Attach names to the missed list.
  if (missed.length) {
    const names = await dbx.prepare(`SELECT id, name, city FROM customers WHERE id IN (${missed.map(() => '?').join(',')})`)
      .all(...missed.map((m) => m.customer_id));
    const nameMap = Object.fromEntries(names.map((n) => [n.id, n]));
    missed.forEach((m) => { m.name = nameMap[m.customer_id]?.name; m.city = nameMap[m.customer_id]?.city; });
  }

  res.json({
    rep_id: Number(repId), has_cycle: true,
    cycle: { id: cycle.id, name: cycle.name, start_date: cycle.start_date, cycle_weeks: cycle.cycle_weeks },
    from: iso(from), to: iso(to),
    planned: totalPlanned, visited: totalVisited,
    pct: totalPlanned ? Math.round((totalVisited / totalPlanned) * 100) : null,
    weeks, missed
  });
});

// --- Rep summary (manager drill-in) ------------------------------------------
router.get('/reps/:id/summary', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const id = req.params.id;
  const rep = await dbx.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.rep_code, u.sales_target, u.active
    FROM users u WHERE u.id = ?
  `).get(id);
  if (!rep) return res.status(404).json({ error: 'Rep not found' });

  const today = getTodayISO();
  const month = today.slice(0, 7);
  // Sales (MTD) is a "this month" stat, so its target should be this month's
  // budget - rolls automatically as the calendar moves into a new month.
  rep.sales_target = await repMonthTarget(rep.id, Number(month.slice(5, 7)));
  rep.sales = await dbx.prepare(`
    SELECT COALESCE(SUM(total), 0) AS mtd, COUNT(*) AS orders
    FROM orders WHERE rep_id = ? AND status != 'cancelled' AND strftime('%Y-%m', order_date) = ?
  `).get(id, month);
  rep.visits = await dbx.prepare(`
    SELECT COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed,
           COUNT(CASE WHEN status = 'in_progress' THEN 1 END) AS in_progress
    FROM visits WHERE rep_id = ? AND strftime('%Y-%m', COALESCE(check_in_at, planned_date)) = ?
  `).get(id, month);
  rep.customers_assigned = (await dbx.prepare("SELECT COUNT(*) AS n FROM customers WHERE rep_id = ? AND status = 'active'").get(id)).n;
  rep.recent_orders = await dbx.prepare(`
    SELECT o.id, o.number, o.status, o.total, o.order_date, c.name AS customer_name
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.rep_id = ? ORDER BY o.order_date DESC LIMIT 10
  `).all(id);
  rep.recent_visits = await dbx.prepare(`
    SELECT v.id, v.status, v.check_in_at, v.check_out_at, v.planned_date, c.name AS customer_name
    FROM visits v JOIN customers c ON c.id = v.customer_id
    WHERE v.rep_id = ? ORDER BY COALESCE(v.check_in_at, v.planned_date) DESC LIMIT 10
  `).all(id);
  res.json(rep);
});

// List all reps (for the team screen).
router.get('/reps', requireRole('admin', 'manager', 'office'), async (req, res) => {
  const rows = await dbx.prepare(`
    SELECT u.id, u.name, u.email, u.rep_code, u.sales_target, u.active,
      (SELECT COUNT(*) FROM customers c WHERE c.rep_id = u.id AND c.status = 'active') AS customers_assigned,
      (SELECT COUNT(*) FROM route_cycles rc WHERE rc.rep_id = u.id AND rc.active = 1) AS has_cycle
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'rep' ORDER BY u.name
  `).all();
  // Show this month's target (rep_budgets if set, else the flat fallback).
  const thisMonth = new Date().getMonth() + 1;
  const targetFor = await repTargetLookup(thisMonth);
  for (const r of rows) r.sales_target = targetFor(r, thisMonth);
  res.json(rows);
});

export default router;
