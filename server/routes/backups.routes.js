// Database + uploads backup management (admin only). Restore is destructive
// and requires a manual server restart afterward - see restoreBackup() in
// ../backup.js for why (SQLite keeps the file open for the life of the process).
import { Router } from 'express';
import { getSetting, setSetting, logActivity } from '../db.js';
import { requireRole } from '../auth.js';
import { runBackup, restoreBackup, listBackups } from '../backup.js';

const router = Router();

router.get('/backups', requireRole('admin'), (req, res) => {
  res.json({
    backups: listBackups(),
    schedule: {
      enabled: getSetting('backup_enabled', '1'),
      time: getSetting('backup_time', '02:00'),
      retention_days: getSetting('backup_retention_days', '14')
    },
    last_backup_at: getSetting('last_backup_at', ''),
    last_backup_path: getSetting('last_backup_path', '')
  });
});

router.put('/backups/schedule', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (b.enabled !== undefined) setSetting('backup_enabled', b.enabled === '1' || b.enabled === true ? '1' : '0');
  if (b.time !== undefined && /^\d{2}:\d{2}$/.test(b.time)) setSetting('backup_time', b.time);
  if (b.retention_days !== undefined) {
    const days = Number(b.retention_days);
    if (Number.isFinite(days) && days >= 1) setSetting('backup_retention_days', String(Math.floor(days)));
  }
  logActivity(req.user.id, 'update', 'backup_schedule', null);
  res.json({ ok: true });
});

router.post('/backups/run', requireRole('admin'), async (req, res) => {
  try {
    const destination = await runBackup();
    logActivity(req.user.id, 'create', 'backup', null, { path: destination });
    res.json({ ok: true, path: destination });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/backups/:name/restore', requireRole('admin'), async (req, res) => {
  try {
    await restoreBackup(req.params.name);
    logActivity(req.user.id, 'restore', 'backup', null, { name: req.params.name });
    res.json({
      ok: true,
      message: 'Restore complete. The server must restart before the restored data is loaded - it will exit now; restart it to come back online.'
    });
    // Let the response above actually reach the client before the process
    // that just closed its own database handle goes away.
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
