import { Router } from 'express';
import { dbx } from '../db.js';
import { isUniqueViolation } from '../dbx.js';
import { requireRole } from '../auth.js';

const router = Router();

// Any authenticated user (incl. reps): the configured order recipients for
// one branch, so the mobile capture screen can let the rep tick who gets a
// copy (nothing sends unless explicitly ticked) - scoped to the customer's
// own warehouse, plus any recipient set up as "every branch" (warehouse_id
// IS NULL). With no warehouse_id given (customer has no branch assigned),
// only the every-branch recipients apply.
router.get('/settings/order-email-info', async (req, res) => {
  const warehouseId = req.query.warehouse_id ? Number(req.query.warehouse_id) : null;
  const recipients = warehouseId
    ? await dbx.prepare("SELECT id, name, email FROM email_recipients WHERE category = 'orders' AND (warehouse_id = ? OR warehouse_id IS NULL) ORDER BY name").all(warehouseId)
    : await dbx.prepare("SELECT id, name, email FROM email_recipients WHERE category = 'orders' AND warehouse_id IS NULL ORDER BY name").all();
  res.json({ recipients });
});

// A rep's own "add another email address" list for order/quote send - self
// service (no requireRole), but every query is scoped to req.user.id so a rep
// can only ever see or use their own saved contacts, never another rep's.
// This is deliberately separate from email_recipients (admin/manager-managed,
// branch-wide) - see the schema.sql comment on rep_email_contacts.
router.get('/my-email-contacts', async (req, res) => {
  res.json(await dbx.prepare('SELECT id, name, email FROM rep_email_contacts WHERE user_id = ? ORDER BY name').all(req.user.id));
});

router.post('/my-email-contacts', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That email address doesn\'t look right' });
  try {
    const info = await dbx.prepare('INSERT INTO rep_email_contacts (user_id, name, email) VALUES (?, ?, ?)').run(req.user.id, name, email);
    res.json(await dbx.prepare('SELECT id, name, email FROM rep_email_contacts WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(400).json({ error: 'You already have a contact with that email address' });
    res.status(400).json({ error: e.message });
  }
});

router.delete('/my-email-contacts/:id', async (req, res) => {
  // The user_id in the WHERE, not just the id, is what stops a rep deleting
  // someone else's saved contact by guessing an id.
  const info = await dbx.prepare('DELETE FROM rep_email_contacts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Contact not found' });
  res.json({ ok: true });
});

// Admin/manager only: GET configured email recipients, optionally filtered by
// ?category=orders|technical and/or ?warehouse_id= (the Email Settings page
// fetches everything and groups by branch client-side, so both default to
// returning the full list).
router.get('/email-recipients', requireRole('admin', 'manager'), async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.category) { where.push('r.category = ?'); params.push(req.query.category); }
  if (req.query.warehouse_id) { where.push('r.warehouse_id = ?'); params.push(Number(req.query.warehouse_id)); }
  const rows = await dbx.prepare(`
    SELECT r.*, w.code AS warehouse_code, w.name AS warehouse_name
    FROM email_recipients r
    LEFT JOIN warehouses w ON w.id = r.warehouse_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN w.name IS NULL THEN 1 ELSE 0 END, w.name, r.name
  `).all(...params);
  res.json(rows);
});

const VALID_CATEGORIES = ['orders', 'technical'];

// Admin/manager only: Create a new email recipient
router.post('/email-recipients', requireRole('admin', 'manager'), async (req, res) => {
  const { name, email, description, category, warehouse_id } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }
  if (warehouse_id != null && !(await dbx.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(warehouse_id))) {
    return res.status(400).json({ error: 'Unknown warehouse' });
  }
  try {
    // Emails are always stored lower-case - SBakels.co.za vs sbakels.co.za is
    // the same mailbox to every mail server, but was two different rows here
    // (email is UNIQUE, case-sensitively, so "Leon@X" and "leon@X" could both
    // exist) and inconsistent casing on screen. Normalise once, at the write,
    // rather than trusting every caller to type it consistently.
    const info = await dbx.prepare(
      'INSERT INTO email_recipients (name, email, description, category, warehouse_id) VALUES (?, ?, ?, ?, ?)'
    ).run(name, String(email).trim().toLowerCase(), description || null, category || 'orders', warehouse_id || null);
    const row = await dbx.prepare('SELECT * FROM email_recipients WHERE id = ?').get(info.lastInsertRowid);
    res.json(row);
  } catch (e) {
    if (isUniqueViolation(e)) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(400).json({ error: e.message });
  }
});

// Admin/manager only: Update an email recipient
router.put('/email-recipients/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { name, email, description, category, warehouse_id } = req.body || {};
  const existing = await dbx.prepare('SELECT * FROM email_recipients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Recipient not found' });
  if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }
  if (warehouse_id != null && !(await dbx.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(warehouse_id))) {
    return res.status(400).json({ error: 'Unknown warehouse' });
  }
  try {
    await dbx.prepare('UPDATE email_recipients SET name = ?, email = ?, description = ?, category = ?, warehouse_id = ? WHERE id = ?')
      .run(
        name || existing.name,
        email ? String(email).trim().toLowerCase() : existing.email,
        description !== undefined ? description : existing.description,
        category || existing.category,
        warehouse_id !== undefined ? (warehouse_id || null) : existing.warehouse_id,
        req.params.id
      );
    const row = await dbx.prepare('SELECT * FROM email_recipients WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (e) {
    if (isUniqueViolation(e)) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(400).json({ error: e.message });
  }
});

// Admin/manager only: Delete an email recipient
router.delete('/email-recipients/:id', requireRole('admin', 'manager'), async (req, res) => {
  const existing = await dbx.prepare('SELECT * FROM email_recipients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Recipient not found' });
  await dbx.prepare('DELETE FROM email_recipients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
