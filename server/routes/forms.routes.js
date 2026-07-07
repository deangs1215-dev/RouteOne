import { Router } from 'express';
import { db, logActivity, saveDataUrl } from '../db.js';
import { requireRole } from '../auth.js';

const router = Router();

router.get('/form-templates', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM form_submissions s WHERE s.template_id = t.id) AS submission_count
    FROM form_templates t ORDER BY t.name
  `).all();
  res.json(rows.map((t) => ({ ...t, fields: JSON.parse(t.fields) })));
});

router.post('/form-templates', requireRole('admin', 'manager'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Form name is required' });
  if (!Array.isArray(b.fields) || b.fields.length === 0) return res.status(400).json({ error: 'At least one field is required' });
  const info = db.prepare('INSERT INTO form_templates (name, description, fields, active) VALUES (?, ?, ?, ?)')
    .run(b.name, b.description || null, JSON.stringify(b.fields), b.active === 0 ? 0 : 1);
  logActivity(req.user.id, 'create', 'form_template', info.lastInsertRowid, { name: b.name });
  res.json({ id: info.lastInsertRowid });
});

router.put('/form-templates/:id', requireRole('admin', 'manager'), (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Form not found' });
  db.prepare('UPDATE form_templates SET name = ?, description = ?, fields = ?, active = ? WHERE id = ?')
    .run(
      b.name ?? existing.name, b.description ?? existing.description,
      b.fields ? JSON.stringify(b.fields) : existing.fields,
      b.active ?? existing.active, req.params.id
    );
  res.json({ ok: true });
});

router.get('/form-submissions', (req, res) => {
  const { template_id, customer_id, visit_id } = req.query;
  const where = [];
  const params = [];
  if (template_id) { where.push('s.template_id = ?'); params.push(template_id); }
  if (customer_id) { where.push('s.customer_id = ?'); params.push(customer_id); }
  if (visit_id) { where.push('s.visit_id = ?'); params.push(visit_id); }
  const rows = db.prepare(`
    SELECT s.*, t.name AS template_name, t.fields AS template_fields,
      c.name AS customer_name, u.name AS user_name
    FROM form_submissions s
    JOIN form_templates t ON t.id = s.template_id
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.created_at DESC LIMIT 200
  `).all(...params);
  res.json(rows.map((s) => ({ ...s, data: JSON.parse(s.data), template_fields: JSON.parse(s.template_fields) })));
});

// Submit a filled form. Photo-type answers arrive as base64 data URLs and are
// stored as files; the submission keeps the upload path.
router.post('/form-submissions', (req, res) => {
  const b = req.body || {};
  const template = db.prepare('SELECT * FROM form_templates WHERE id = ? AND active = 1').get(b.template_id);
  if (!template) return res.status(404).json({ error: 'Form template not found' });
  const fields = JSON.parse(template.fields);

  const data = {};
  for (const field of fields) {
    let value = (b.data || {})[field.key];
    if (field.required && (value === undefined || value === null || value === '')) {
      return res.status(400).json({ error: `"${field.label}" is required` });
    }
    if (field.type === 'photo' && typeof value === 'string' && value.startsWith('data:')) {
      value = saveDataUrl(value, `form-${template.id}`);
    }
    if (value !== undefined) data[field.key] = value;
  }

  const info = db.prepare(`
    INSERT INTO form_submissions (template_id, visit_id, customer_id, user_id, data)
    VALUES (?, ?, ?, ?, ?)
  `).run(b.template_id, b.visit_id || null, b.customer_id || null, req.user.id, JSON.stringify(data));
  logActivity(req.user.id, 'submit', 'form', info.lastInsertRowid, { template: template.name });
  res.json({ id: info.lastInsertRowid });
});

export default router;
