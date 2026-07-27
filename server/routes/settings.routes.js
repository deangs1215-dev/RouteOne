import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { requireRole } from '../auth.js';

const router = Router();

// Any authenticated user (incl. reps): the configured recipients plus the
// orders-department address, so the mobile capture screen can let the rep
// tick who gets a copy (nothing sends unless explicitly ticked).
router.get('/settings/order-email-info', (req, res) => {
  res.json({
    orders_email: getSetting('orders_email', ''),
    recipients: db.prepare('SELECT id, name, email FROM email_recipients ORDER BY name').all()
  });
});

// Admin/manager only: GET all configured email recipients
router.get('/email-recipients', requireRole('admin', 'manager'), (req, res) => {
  const rows = db.prepare('SELECT * FROM email_recipients ORDER BY name').all();
  res.json(rows);
});

// Admin/manager only: Create a new email recipient
router.post('/email-recipients', requireRole('admin', 'manager'), (req, res) => {
  const { name, email, description } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  try {
    const info = db.prepare(
      'INSERT INTO email_recipients (name, email, description) VALUES (?, ?, ?)'
    ).run(name, email, description || null);
    const row = db.prepare('SELECT * FROM email_recipients WHERE id = ?').get(info.lastInsertRowid);
    res.json(row);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(400).json({ error: e.message });
  }
});

// Admin/manager only: Update an email recipient
router.put('/email-recipients/:id', requireRole('admin', 'manager'), (req, res) => {
  const { name, email, description } = req.body || {};
  const existing = db.prepare('SELECT * FROM email_recipients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Recipient not found' });
  try {
    db.prepare('UPDATE email_recipients SET name = ?, email = ?, description = ? WHERE id = ?')
      .run(name || existing.name, email || existing.email, description !== undefined ? description : existing.description, req.params.id);
    const row = db.prepare('SELECT * FROM email_recipients WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(400).json({ error: e.message });
  }
});

// Admin/manager only: Delete an email recipient
router.delete('/email-recipients/:id', requireRole('admin', 'manager'), (req, res) => {
  const existing = db.prepare('SELECT * FROM email_recipients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Recipient not found' });
  db.prepare('DELETE FROM email_recipients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
