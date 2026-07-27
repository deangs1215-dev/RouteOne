// Marketing documents (PDFs) - admin/manager upload, everyone (except the
// customer portal, blocked globally by customerGuard) can browse/download.
// Unread tracking is a single per-user "last viewed" timestamp rather than
// per-document read state - simple, and enough to drive a "new" badge.
import { Router } from 'express';
import { db, saveDataUrl, deleteUploadedFile, logActivity } from '../db.js';
import { requireRole } from '../auth.js';

const router = Router();

router.get('/documents', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, u.name AS uploaded_by_name
    FROM documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
    ORDER BY d.created_at DESC
  `).all();
  res.json(rows);
});

router.get('/documents/unread-count', (req, res) => {
  const since = req.user.documents_last_viewed_at || '1970-01-01';
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM documents WHERE created_at > ?').get(since);
  res.json({ count: c });
});

router.post('/documents/mark-viewed', (req, res) => {
  db.prepare("UPDATE users SET documents_last_viewed_at = datetime('now') WHERE id = ?").run(req.user.id);
  res.json({ ok: true });
});

router.post('/documents', requireRole('admin', 'manager'), (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'Title is required' });
  if (!b.file) return res.status(400).json({ error: 'A PDF file is required' });
  const filePath = saveDataUrl(b.file, 'document', {
    allowedTypes: ['application/pdf'],
    maxBytes: 8 * 1024 * 1024
  });
  if (!filePath) return res.status(400).json({ error: 'Could not read the uploaded file' });
  const info = db.prepare('INSERT INTO documents (title, description, file_path, uploaded_by) VALUES (?, ?, ?, ?)')
    .run(b.title, b.description || null, filePath, req.user.id);
  logActivity(req.user.id, 'create', 'document', info.lastInsertRowid, { title: b.title });
  res.json({ id: info.lastInsertRowid });
});

router.delete('/documents/:id', requireRole('admin', 'manager'), (req, res) => {
  const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  deleteUploadedFile(existing.file_path);
  logActivity(req.user.id, 'delete', 'document', req.params.id, { title: existing.title });
  res.json({ ok: true });
});

export default router;
