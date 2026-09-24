import { Router } from 'express';
import { dbx, saveDataUrl } from '../db.js';
import { logActivity } from '../dbh.js';
import { requireRole, scopeForUser, userCanAccessCustomerAsync } from '../auth.js';
import { buildFormEmail, sendEmail } from '../integration/email.js';

const router = Router();

router.get('/form-templates', async (req, res) => {
  const rows = await dbx.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM form_submissions s WHERE s.template_id = t.id) AS submission_count
    FROM form_templates t ORDER BY t.name
  `).all();
  res.json(rows.map((t) => ({ ...t, fields: JSON.parse(t.fields) })));
});

router.post('/form-templates', requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Form name is required' });
  if (!Array.isArray(b.fields) || b.fields.length === 0) return res.status(400).json({ error: 'At least one field is required' });
  const info = await dbx.prepare('INSERT INTO form_templates (name, description, fields, category, notify_email, active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.name, b.description || null, JSON.stringify(b.fields), b.category === 'technical' ? 'technical' : 'general', b.notify_email || null, b.active === 0 ? 0 : 1);
  await logActivity(req.user.id, 'create', 'form_template', info.lastInsertRowid, { name: b.name });
  res.json({ id: info.lastInsertRowid });
});

router.put('/form-templates/:id', requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body || {};
  const existing = await dbx.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Form not found' });
  await dbx.prepare('UPDATE form_templates SET name = ?, description = ?, fields = ?, category = ?, notify_email = ?, active = ? WHERE id = ?')
    .run(
      b.name ?? existing.name, b.description ?? existing.description,
      b.fields ? JSON.stringify(b.fields) : existing.fields,
      b.category ? (b.category === 'technical' ? 'technical' : 'general') : existing.category,
      b.notify_email !== undefined ? (b.notify_email || null) : existing.notify_email,
      b.active ?? existing.active, req.params.id
    );
  res.json({ ok: true });
});

router.delete('/form-templates/:id', requireRole('admin', 'manager'), async (req, res) => {
  const existing = await dbx.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Form not found' });
  const { c: submissionCount } = await dbx.prepare('SELECT COUNT(*) AS c FROM form_submissions WHERE template_id = ?').get(req.params.id);
  if (submissionCount > 0) {
    return res.status(400).json({ error: `Cannot delete — ${submissionCount} submission(s) exist for this form. Deactivate it instead.` });
  }
  await dbx.prepare('DELETE FROM form_templates WHERE id = ?').run(req.params.id);
  await logActivity(req.user.id, 'delete', 'form_template', req.params.id, { name: existing.name });
  res.json({ ok: true });
});

router.get('/form-submissions', async (req, res) => {
  const { template_id, customer_id, visit_id } = req.query;
  const where = [];
  const params = [];
  if (scopeForUser(req.user).isRep) { where.push('s.user_id = ?'); params.push(req.user.id); }
  if (template_id) { where.push('s.template_id = ?'); params.push(template_id); }
  if (customer_id) { where.push('s.customer_id = ?'); params.push(customer_id); }
  if (visit_id) { where.push('s.visit_id = ?'); params.push(visit_id); }
  const rows = await dbx.prepare(`
    SELECT s.*, t.name AS template_name, t.fields AS template_fields,
      c.name AS customer_name, u.name AS user_name, u.name AS rep_name
    FROM form_submissions s
    JOIN form_templates t ON t.id = s.template_id
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.created_at DESC LIMIT 200
  `).all(...params);
  res.json(rows.map((s) => ({ ...s, data: JSON.parse(s.data), template_fields: JSON.parse(s.template_fields) })));
});

router.get('/form-submissions/:id', async (req, res) => {
  const row = await dbx.prepare(`
    SELECT s.*, t.name AS template_name, t.fields AS template_fields,
      c.name AS customer_name, u.name AS rep_name
    FROM form_submissions s
    JOIN form_templates t ON t.id = s.template_id
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Form submission not found' });
  if (scopeForUser(req.user).isRep && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your submission' });
  }
  res.json({ ...row, data: JSON.parse(row.data), template_fields: JSON.parse(row.template_fields) });
});

// Submit a filled form. Photo-type answers arrive as base64 data URLs and are
// stored as files; the submission keeps the upload path.
router.post('/form-submissions', async (req, res) => {
  const b = req.body || {};
  const template = await dbx.prepare('SELECT * FROM form_templates WHERE id = ? AND active = 1').get(b.template_id);
  if (!template) return res.status(404).json({ error: 'Form template not found' });
  if (b.customer_id && !await dbx.prepare('SELECT 1 FROM customers WHERE id = ?').get(b.customer_id)) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  if (b.customer_id && !await userCanAccessCustomerAsync(req.user, b.customer_id)) {
    return res.status(403).json({ error: 'Not your customer' });
  }
  if (b.visit_id) {
    const visit = await dbx.prepare('SELECT customer_id, rep_id FROM visits WHERE id = ?').get(b.visit_id);
    if (!visit ||
        (b.customer_id && visit.customer_id !== Number(b.customer_id)) ||
        (scopeForUser(req.user).isRep && visit.rep_id !== req.user.id)) {
      return res.status(400).json({ error: 'Visit does not match this submission' });
    }
  }
  const fields = JSON.parse(template.fields);

  const data = {};
  for (const field of fields) {
    if (field.type === 'heading') continue; // section divider, carries no data
    let value = (b.data || {})[field.key];
    if (field.required && (value === undefined || value === null || value === '')) {
      return res.status(400).json({ error: `"${field.label}" is required` });
    }
    // Photos and signatures arrive as base64 data URLs; store them as files.
    if ((field.type === 'photo' || field.type === 'signature') && typeof value === 'string' && value.startsWith('data:')) {
      value = saveDataUrl(value, `form-${template.id}`);
    }
    if (value !== undefined) data[field.key] = value;
  }

  if (!req.user.email) {
    return res.status(400).json({ error: 'Your account does not have an email address configured. Please contact an administrator.' });
  }

  const info = await dbx.prepare(`
    INSERT INTO form_submissions (template_id, visit_id, customer_id, user_id, data)
    VALUES (?, ?, ?, ?, ?)
  `).run(b.template_id, b.visit_id || null, b.customer_id || null, req.user.id, JSON.stringify(data));
  await logActivity(req.user.id, 'submit', 'form', info.lastInsertRowid, { template: template.name });
  // Send form notification to the rep who submitted it. Best-effort, never blocks the submission response.
  sendEmail(await buildFormEmail(info.lastInsertRowid, req.user.email)).catch((e) => console.error('Form notification email failed:', e.message));
  res.json({ id: info.lastInsertRowid });
});

export default router;
