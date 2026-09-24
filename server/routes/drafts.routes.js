// In-progress order/quote/form captures a rep saved instead of submitting.
// Personal to the rep who saved it - always scoped to req.user.id, never
// exposed to other reps or office roles.
import { Router } from 'express';
import { dbx } from '../db.js';

const router = Router();
const KINDS = ['order', 'quote', 'form', 'visit'];

router.get('/drafts', async (req, res) => {
  const rows = await dbx.prepare(`
    SELECT d.id, d.kind, d.customer_id, d.template_id, d.visit_id, d.label, d.data, d.updated_at, d.created_at,
      c.name AS customer_name, t.name AS template_name
    FROM drafts d
    LEFT JOIN customers c ON c.id = d.customer_id
    LEFT JOIN form_templates t ON t.id = d.template_id
    WHERE d.rep_id = ?
    ORDER BY d.updated_at DESC
  `).all(req.user.id);
  res.json(rows.map((r) => ({ ...r, data: JSON.parse(r.data) })));
});

router.get('/drafts/:id', async (req, res) => {
  const row = await dbx.prepare('SELECT * FROM drafts WHERE id = ? AND rep_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Draft not found' });
  res.json({ ...row, data: JSON.parse(row.data) });
});

router.post('/drafts', async (req, res) => {
  const { kind, customer_id, template_id, visit_id, label, data } = req.body;
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid draft kind' });
  const result = await dbx.prepare(`
    INSERT INTO drafts (rep_id, kind, customer_id, template_id, visit_id, label, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(req.user.id, kind, customer_id || null, template_id || null, visit_id || null, label || null, JSON.stringify(data || {}));
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/drafts/:id', async (req, res) => {
  const existing = await dbx.prepare('SELECT id FROM drafts WHERE id = ? AND rep_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Draft not found' });
  const { label, data } = req.body;
  await dbx.prepare(`UPDATE drafts SET label = COALESCE(?, label), data = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(label || null, JSON.stringify(data || {}), req.params.id);
  res.json({ ok: true });
});

router.delete('/drafts/:id', async (req, res) => {
  const result = await dbx.prepare('DELETE FROM drafts WHERE id = ? AND rep_id = ?').run(req.params.id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Draft not found' });
  res.json({ ok: true });
});

export default router;
