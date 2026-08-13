// Sales push notifications: a manager broadcasts "push this product" to every
// rep. Shown highlighted (red/bold) at the top of the Selling tips card on
// every customer, on both mobile and desktop. Not customer-specific - see
// intelligence.routes.js for the per-customer "others buy, they don't" logic.
import { Router } from 'express';
import { db } from '../db.js';
import { requireRole } from '../auth.js';

const router = Router();

// Any authenticated user (incl. reps): the currently active pushes, oldest
// first so a rep sees them in the order they were announced.
router.get('/sales-pushes/active', (req, res) => {
  res.json(db.prepare(`
    SELECT sp.id, sp.message, sp.created_at, u.name AS created_by_name
    FROM sales_pushes sp
    LEFT JOIN users u ON u.id = sp.created_by
    WHERE sp.active = 1
    ORDER BY sp.created_at ASC
  `).all());
});

// Admin/manager only: every push, active and inactive, for the management page.
router.get('/sales-pushes', requireRole('admin', 'manager'), (req, res) => {
  res.json(db.prepare(`
    SELECT sp.id, sp.message, sp.active, sp.created_at, sp.updated_at, u.name AS created_by_name
    FROM sales_pushes sp
    LEFT JOIN users u ON u.id = sp.created_by
    ORDER BY sp.created_at DESC
  `).all());
});

router.post('/sales-pushes', requireRole('admin', 'manager'), (req, res) => {
  const message = (req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (message.length > 500) return res.status(400).json({ error: 'Message must be 500 characters or fewer' });
  const info = db.prepare('INSERT INTO sales_pushes (message, created_by) VALUES (?, ?)').run(message, req.user.id);
  const row = db.prepare('SELECT * FROM sales_pushes WHERE id = ?').get(info.lastInsertRowid);
  res.json(row);
});

router.put('/sales-pushes/:id', requireRole('admin', 'manager'), (req, res) => {
  const existing = db.prepare('SELECT * FROM sales_pushes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Push not found' });

  const message = req.body?.message !== undefined ? String(req.body.message).trim() : existing.message;
  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (message.length > 500) return res.status(400).json({ error: 'Message must be 500 characters or fewer' });
  const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;

  db.prepare("UPDATE sales_pushes SET message = ?, active = ?, updated_at = datetime('now') WHERE id = ?")
    .run(message, active, req.params.id);
  res.json(db.prepare('SELECT * FROM sales_pushes WHERE id = ?').get(req.params.id));
});

router.delete('/sales-pushes/:id', requireRole('admin', 'manager'), (req, res) => {
  const existing = db.prepare('SELECT * FROM sales_pushes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Push not found' });
  db.prepare('DELETE FROM sales_pushes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
