import { Router } from 'express';
import { db, logActivity, saveDataUrl, deleteUploadedFile, distanceM, repMonthTarget, getTodayISO } from '../db.js';
import { scopeForUser, userCanAccessCustomer } from '../auth.js';
import { customerIntel, buildActions } from './intelligence.routes.js';

const router = Router();

router.get('/visits', (req, res) => {
  const { date, rep_id, customer_id, status } = req.query;
  const scope = scopeForUser(req.user);
  const where = [];
  const params = [];
  if (scope.isRep) { where.push('v.rep_id = ?'); params.push(req.user.id); }
  else if (rep_id) { where.push('v.rep_id = ?'); params.push(rep_id); }
  if (date) { where.push("date(COALESCE(v.check_in_at, v.planned_date)) = date(?)"); params.push(date); }
  if (customer_id) { where.push('v.customer_id = ?'); params.push(customer_id); }
  if (status) { where.push('v.status = ?'); params.push(status); }
  const rows = db.prepare(`
    SELECT v.*, c.name AS customer_name, c.city AS customer_city, u.name AS rep_name,
      (SELECT COUNT(*) FROM orders o WHERE o.visit_id = v.id) AS order_count,
      CASE WHEN v.status = 'planned' AND date(v.planned_date) < date('now')
        THEN 'missed' ELSE v.status END AS status
    FROM visits v
    JOIN customers c ON c.id = v.customer_id
    JOIN users u ON u.id = v.rep_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(v.check_in_at, v.planned_date) DESC
    LIMIT 200
  `).all(...params);
  res.json(rows);
});

// Plan a visit (managers can plan for any rep; reps plan their own).
router.post('/visits', (req, res) => {
  const b = req.body || {};
  const scope = scopeForUser(req.user);
  if (!b.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(b.customer_id)) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  if (!userCanAccessCustomer(req.user, b.customer_id)) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  const repId = scope.isRep ? req.user.id : (b.rep_id || req.user.id);
  const info = db.prepare(`
    INSERT INTO visits (customer_id, rep_id, planned_date, purpose, status, notes)
    VALUES (?, ?, ?, ?, 'planned', ?)
  `).run(b.customer_id, repId, b.planned_date || getTodayISO(), b.purpose || 'sales call', b.notes || null);
  logActivity(req.user.id, 'plan', 'visit', info.lastInsertRowid);
  res.json(db.prepare('SELECT * FROM visits WHERE id = ?').get(info.lastInsertRowid));
});

// The rep's currently open (checked-in) visit, if any - one at a time.
router.get('/visits/open', (req, res) => {
  const v = db.prepare(`
    SELECT v.id, v.customer_id, v.check_in_at, c.name AS customer_name
    FROM visits v JOIN customers c ON c.id = v.customer_id
    WHERE v.rep_id = ? AND v.status = 'in_progress'
    ORDER BY v.check_in_at DESC LIMIT 1
  `).get(req.user.id);
  res.json(v || null);
});

// Check in on site - starts an unplanned visit if no id supplied.
router.post('/visits/check-in', (req, res) => {
  const b = req.body || {};
  // One open visit at a time: a rep must check out before checking in elsewhere.
  const open = db.prepare(`
    SELECT v.id, c.name AS customer_name FROM visits v
    JOIN customers c ON c.id = v.customer_id
    WHERE v.rep_id = ? AND v.status = 'in_progress' LIMIT 1
  `).get(req.user.id);
  if (open && open.id !== Number(b.visit_id)) {
    return res.status(409).json({
      error: `You're still checked in at ${open.customer_name}. Check out there before starting a new visit.`,
      open_visit_id: open.id,
      open_customer_name: open.customer_name
    });
  }
  let visitId = b.visit_id;
  if (!visitId) {
    if (!b.customer_id) return res.status(400).json({ error: 'Customer is required' });
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(b.customer_id)) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    if (!userCanAccessCustomer(req.user, b.customer_id)) {
      return res.status(403).json({ error: 'Not your customer' });
    }
    visitId = db.prepare(`
      INSERT INTO visits (customer_id, rep_id, planned_date, purpose, status)
      VALUES (?, ?, date('now'), ?, 'planned')
    `).run(b.customer_id, req.user.id, b.purpose || 'sales call').lastInsertRowid;
  }
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (scopeForUser(req.user).isRep && visit.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your visit' });
  }
  if (visit.check_in_at) return res.status(400).json({ error: 'Already checked in' });
  // onsite: GPS is checked against the customer's SYSPRO pin. onsite_manual /
  // offsite: the rep is knowingly at a different address, so that comparison
  // doesn't apply - the rep-entered address is stored instead.
  const checkInType = ['onsite', 'onsite_manual', 'offsite'].includes(b.check_in_type) ? b.check_in_type : 'onsite';
  const customer = db.prepare('SELECT lat, lng FROM customers WHERE id = ?').get(visit.customer_id);
  const dist = checkInType === 'onsite' ? distanceM(b.lat, b.lng, customer?.lat, customer?.lng) : null;
  db.prepare(`
    UPDATE visits SET status = 'in_progress', check_in_at = datetime('now'),
      check_in_lat = ?, check_in_lng = ?, check_in_distance_m = ?,
      check_in_type = ?, check_in_address = ?
    WHERE id = ?
  `).run(b.lat || null, b.lng || null, dist, checkInType, b.check_in_address || null, visitId);
  logActivity(req.user.id, 'check_in', 'visit', visitId, { check_in_type: checkInType, ...(dist != null ? { distance_m: dist } : {}) });
  res.json(db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId));
});

router.post('/visits/:id/check-out', (req, res) => {
  const b = req.body || {};
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (scopeForUser(req.user).isRep && visit.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your visit' });
  }
  if (!visit.check_in_at) return res.status(400).json({ error: 'Not checked in yet' });
  db.prepare(`
    UPDATE visits SET status = 'completed', check_out_at = datetime('now'), check_out_lat = ?, check_out_lng = ?,
      notes = COALESCE(?, notes), outcome = COALESCE(?, outcome)
    WHERE id = ?
  `).run(b.lat || null, b.lng || null, b.notes || null, b.outcome || null, req.params.id);
  logActivity(req.user.id, 'check_out', 'visit', req.params.id, { outcome: b.outcome });
  res.json(db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id));
});

// A visit that happened entirely offline: the app couldn't check in against the
// server, so once signal returns it logs the whole completed visit in one call.
router.post('/visits/log-offline', (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) return res.status(400).json({ error: 'Customer is required' });
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(b.customer_id)) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  if (!userCanAccessCustomer(req.user, b.customer_id)) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  const checkInType = ['onsite', 'onsite_manual', 'offsite'].includes(b.check_in_type) ? b.check_in_type : 'onsite';
  const info = db.prepare(`
    INSERT INTO visits (customer_id, rep_id, planned_date, purpose, status, check_in_at, check_in_lat, check_in_lng,
      check_in_type, check_in_address, check_out_at, check_out_lat, check_out_lng, notes, outcome)
    VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.customer_id, req.user.id, (b.check_in_at || '').slice(0, 10) || getTodayISO(),
    b.purpose || 'sales call', b.check_in_at || null, b.check_in_lat || null, b.check_in_lng || null,
    checkInType, b.check_in_address || null,
    b.check_out_at || null, b.check_out_lat || null, b.check_out_lng || null,
    b.notes || null, b.outcome || null
  );
  logActivity(req.user.id, 'log_offline', 'visit', info.lastInsertRowid);
  res.json(db.prepare('SELECT * FROM visits WHERE id = ?').get(info.lastInsertRowid));
});

// Attach a photo to a visit (base64 data URL from the mobile camera/gallery).
// The client compresses before upload; we cap at 10 photos per visit.
const MAX_PHOTOS_PER_VISIT = 10;
router.post('/visits/:id/photos', (req, res) => {
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(req.params.id);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (scopeForUser(req.user).isRep && visit.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your visit' });
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM visit_photos WHERE visit_id = ?').get(visit.id).n;
  if (count >= MAX_PHOTOS_PER_VISIT) {
    return res.status(400).json({ error: `Maximum ${MAX_PHOTOS_PER_VISIT} photos per visit reached` });
  }
  const path = saveDataUrl(req.body?.data_url, `visit-${visit.id}`);
  if (!path) return res.status(400).json({ error: 'Invalid image data' });
  const info = db.prepare('INSERT INTO visit_photos (visit_id, path, caption) VALUES (?, ?, ?)')
    .run(visit.id, path, req.body?.caption || null);
  logActivity(req.user.id, 'photo', 'visit', visit.id);
  res.json(db.prepare('SELECT * FROM visit_photos WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/visits/:id/photos', (req, res) => {
  if (scopeForUser(req.user).isRep) {
    const visit = db.prepare('SELECT rep_id FROM visits WHERE id = ?').get(req.params.id);
    if (!visit || visit.rep_id !== req.user.id) return res.status(403).json({ error: 'Not your visit' });
  }
  res.json(db.prepare('SELECT * FROM visit_photos WHERE visit_id = ? ORDER BY created_at').all(req.params.id));
});

// Delete a photo from a visit.
router.delete('/visits/:id/photos/:photoId', (req, res) => {
  const photo = db.prepare('SELECT * FROM visit_photos WHERE id = ? AND visit_id = ?').get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  const visit = db.prepare('SELECT rep_id FROM visits WHERE id = ?').get(photo.visit_id);
  if (scopeForUser(req.user).isRep && visit.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your visit' });
  }
  db.prepare('DELETE FROM visit_photos WHERE id = ?').run(photo.id);
  deleteUploadedFile(photo.path);
  logActivity(req.user.id, 'photo_delete', 'visit', photo.visit_id);
  res.json({ ok: true });
});

// Visit summary: orders, quotes, forms, and photos created during this visit
router.get('/visits/:id/summary', (req, res) => {
  const visitId = req.params.id;
  const visit = db.prepare(`
    SELECT v.*, c.name AS customer_name, u.name AS rep_name
    FROM visits v
    JOIN customers c ON c.id = v.customer_id
    JOIN users u ON u.id = v.rep_id
    WHERE v.id = ?
  `).get(visitId);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  if (scopeForUser(req.user).isRep && visit.rep_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your visit' });
  }

  const orders = db.prepare(`
    SELECT id, number, total, status, order_date FROM orders WHERE visit_id = ? ORDER BY order_date DESC
  `).all(visitId);

  const quotes = db.prepare(`
    SELECT id, number, total, status, quote_date FROM quotes WHERE visit_id = ? ORDER BY quote_date DESC
  `).all(visitId);

  const forms = db.prepare(`
    SELECT t.id, t.name AS template_name, COUNT(s.id) AS count
    FROM form_submissions s
    JOIN form_templates t ON t.id = s.template_id
    WHERE s.visit_id = ?
    GROUP BY t.id, t.name
  `).all(visitId);

  const photos = db.prepare(`
    SELECT COUNT(*) AS count FROM visit_photos WHERE visit_id = ?
  `).get(visitId);

  res.json({
    visit,
    orders,
    quotes,
    forms,
    photo_count: photos.count || 0
  });
});

// Core of the rep home screen: today's route (with per-customer open/overdue
// task counts and Sales AI alerts) plus quick stats. Exported so the daily
// digest email can reuse it directly without an HTTP round-trip.
export function buildDaySummary(repId, date) {
  const visits = db.prepare(`
    SELECT v.*, c.name AS customer_name, c.code AS customer_code, c.address, c.city, c.lat AS customer_lat, c.lng AS customer_lng,
      (SELECT COUNT(*) FROM orders o WHERE o.visit_id = v.id) AS order_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.customer_id = c.id AND t.assigned_to = ? AND t.status = 'open') AS open_task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.customer_id = c.id AND t.assigned_to = ? AND t.status = 'open' AND t.follow_up_date < date('now')) AS overdue_task_count,
      (SELECT t.task_type FROM tasks t WHERE t.customer_id = c.id AND t.assigned_to = ? AND t.status = 'open' ORDER BY t.follow_up_date ASC, t.id ASC LIMIT 1) AS next_task_type,
      (SELECT t.follow_up_date FROM tasks t WHERE t.customer_id = c.id AND t.assigned_to = ? AND t.status = 'open' ORDER BY t.follow_up_date ASC, t.id ASC LIMIT 1) AS next_task_date
    FROM visits v JOIN customers c ON c.id = v.customer_id
    WHERE v.rep_id = ? AND date(COALESCE(v.check_in_at, v.planned_date)) = date(?)
    ORDER BY v.status = 'completed', v.route_order IS NULL, v.route_order, v.id
  `).all(repId, repId, repId, repId, repId, date);

  // Sales AI alerts per visited customer - same engine as the Sales AI page,
  // surfaced on the day's route like the task indicators are.
  if (visits.length) {
    const alertsByCustomer = {};
    for (const a of buildActions(customerIntel(repId), { repId })) {
      (alertsByCustomer[a.customer_id] ||= []).push(a);
    }
    for (const v of visits) {
      const alerts = alertsByCustomer[v.customer_id] || [];
      v.ai_alert_count = alerts.length;
      v.top_ai_alert = alerts[0] ? { type: alerts[0].type, action: alerts[0].action } : null;
    }
  }

  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM visits WHERE rep_id = ? AND date(check_in_at) = date(?) AND status = 'completed') AS visits_done,
      (SELECT COUNT(*) FROM orders WHERE rep_id = ? AND date(order_date) = date(?) AND status != 'cancelled') AS orders_today,
      (SELECT COALESCE(SUM(total), 0) FROM orders WHERE rep_id = ? AND date(order_date) = date(?) AND status != 'cancelled') AS sales_today,
      (SELECT COALESCE(SUM(total), 0) FROM orders WHERE rep_id = ? AND order_date >= date('now', 'start of month') AND status != 'cancelled') AS sales_mtd
  `).get(repId, date, repId, date, repId, date, repId);
  // Target rolls automatically with the viewed date's month - a rep_budgets
  // figure for that month if set, otherwise the flat sales_target fallback.
  stats.target = repMonthTarget(repId, Number(date.slice(5, 7)));
  return { visits, stats };
}

// Rep home screen: today's route plus quick stats (or a selected date).
router.get('/my-day', (req, res) => {
  const repId = req.user.id;
  // Parameterised, never interpolated: the date comes straight from the query string.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : getTodayISO();
  res.json(buildDaySummary(repId, date));
});

export default router;
