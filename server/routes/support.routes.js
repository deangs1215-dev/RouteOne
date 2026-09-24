// Support tickets (Help Desk): any staff user logs an issue, admin only
// triages and resolves. See support_tickets in schema.sql.
import { Router } from 'express';
import { dbx } from '../db.js';
import { logActivity } from '../dbh.js';
import { requireRole, scopeForUser } from '../auth.js';
import { buildSupportTicketEmail, sendEmail } from '../integration/email.js';

const router = Router();

const CATEGORIES = ['system_issue', 'product_question', 'pricing', 'order_problem', 'customer_issue', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'resolved'];

// --- Create ticket --- any authenticated staff user (rep, manager, admin, office)
router.post('/support-tickets', async (req, res) => {
  const b = req.body || {};
  if (!b.subject || !b.subject.trim()) return res.status(400).json({ error: 'Subject is required' });
  if (!b.description || !b.description.trim()) return res.status(400).json({ error: 'Description is required' });
  const category = CATEGORIES.includes(b.category) ? b.category : 'other';
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';

  if (b.customer_id && !await dbx.prepare('SELECT 1 FROM customers WHERE id = ?').get(b.customer_id)) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  if (b.order_id && !await dbx.prepare('SELECT 1 FROM orders WHERE id = ?').get(b.order_id)) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const info = await dbx.prepare(`
    INSERT INTO support_tickets (created_by, subject, description, category, priority, customer_id, order_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(req.user.id, b.subject.trim(), b.description.trim(), category, priority, b.customer_id || null, b.order_id || null);

  await logActivity(req.user.id, 'create', 'support_ticket', info.lastInsertRowid, { subject: b.subject.trim(), category, priority });

  res.json({ id: info.lastInsertRowid });
});

// --- List tickets ---
// Admin sees every ticket (optionally filtered by status); everyone else sees
// only their own. Query: status=open|in_progress|resolved|all
router.get('/support-tickets', async (req, res) => {
  const scope = scopeForUser(req.user);
  const canSeeAll = req.user.role === 'admin';
  const status = req.query.status || 'open';

  const where = [];
  const params = [];
  if (!canSeeAll) { where.push('t.created_by = ?'); params.push(req.user.id); }
  if (status !== 'all') { where.push('t.status = ?'); params.push(status); }

  const rows = await dbx.prepare(`
    SELECT t.*, u.name AS created_by_name, c.name AS customer_name, o.number AS order_number, r.name AS resolved_by_name
    FROM support_tickets t
    JOIN users u ON u.id = t.created_by
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN users r ON r.id = t.resolved_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN t.status = 'resolved' THEN 1 ELSE 0 END ASC, t.created_at DESC
  `).all(...params);
  res.json(rows);
});

// --- Ticket detail ---
router.get('/support-tickets/:id', async (req, res) => {
  const row = await dbx.prepare(`
    SELECT t.*, u.name AS created_by_name, c.name AS customer_name, o.number AS order_number, r.name AS resolved_by_name
    FROM support_tickets t
    JOIN users u ON u.id = t.created_by
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN users r ON r.id = t.resolved_by
    WHERE t.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found' });
  if (req.user.role !== 'admin' && row.created_by !== req.user.id) {
    return res.status(403).json({ error: 'Not your ticket' });
  }
  res.json(row);
});

// --- Update ticket status/notes --- admin only (they triage and resolve)
router.put('/support-tickets/:id', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const ticket = await dbx.prepare('SELECT * FROM support_tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (b.status && !STATUSES.includes(b.status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  const newStatus = b.status || ticket.status;
  // Reopening a resolved ticket (status moved away from 'resolved') clears
  // who/when it was resolved; leaving status untouched keeps those as-is.
  const statusChanged = newStatus !== ticket.status;
  const resolvedBy = newStatus === 'resolved' ? req.user.id : (statusChanged ? null : ticket.resolved_by);
  const resolvedAt = newStatus === 'resolved' ? new Date().toISOString() : (statusChanged ? null : ticket.resolved_at);

  await dbx.prepare(`
    UPDATE support_tickets SET
      status = ?,
      admin_notes = COALESCE(?, admin_notes),
      resolved_by = ?,
      resolved_at = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(newStatus, b.admin_notes ?? null, resolvedBy, resolvedAt, ticket.id);

  await logActivity(req.user.id, 'update', 'support_ticket', ticket.id, { status: newStatus });

  // Notify the rep who logged it, best-effort, whenever the status actually changed.
  if (b.status && b.status !== ticket.status) {
    sendEmail(await buildSupportTicketEmail(ticket.id)).catch((e) => console.error('Support ticket notification email failed:', e.message));
  }

  res.json({ ok: true });
});

export default router;
