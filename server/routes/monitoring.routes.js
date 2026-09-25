// Admin-facing snapshot of the ops health that used to require RDP + PowerShell
// to see: disk space, DB size, backup status, and a tail of the scheduled
// monitor scripts' logs (server/monitor-*.ps1, run from Windows Task Scheduler
// - see MONITORING_SETUP.md). Alert recipients live in .env (not the settings
// table) because the standalone PS scripts can't decrypt DB-stored secrets, so
// this route reads/writes that file directly, mirroring the Set-EnvValue
// helper used everywhere else in this project.
import { Router } from 'express';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireRole } from '../auth.js';
import { DB_PATH, dbx } from '../db.js';
import { listBackups } from '../backup.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');
const ENV_PATH = path.resolve(process.cwd(), '.env');

function tailLog(name, lines = 8) {
  try {
    const text = fs.readFileSync(path.join(LOG_DIR, name), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return []; // not run yet, or task not deployed on this box
  }
}

function getDiskSpace(targetPath) {
  return new Promise((resolve) => {
    const driveLetter = path.parse(path.resolve(targetPath)).root.replace(/[\\/:]/g, '');
    if (!/^[A-Za-z]$/.test(driveLetter)) return resolve(null);
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-PSDrive -Name ${driveLetter} | Select-Object Used,Free | ConvertTo-Json`
    ], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const parsed = JSON.parse(stdout);
        resolve({ usedBytes: parsed.Used, freeBytes: parsed.Free });
      } catch {
        resolve(null);
      }
    });
  });
}

function readAlertRecipients() {
  try {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
    const line = lines.find((l) => l.startsWith('ALERT_RECIPIENTS='));
    return line ? line.slice('ALERT_RECIPIENTS='.length).trim() : '';
  } catch {
    return '';
  }
}

function writeAlertRecipients(value) {
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => l.startsWith('ALERT_RECIPIENTS='));
  const newLine = `ALERT_RECIPIENTS=${value}`;
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  fs.writeFileSync(ENV_PATH, lines.filter((l, i) => l !== '' || i === lines.length - 1).join('\r\n'));
}

router.get('/monitoring/status', requireRole('admin'), async (req, res) => {
  const disk = await getDiskSpace(DB_PATH);
  let dbSizeBytes = null;
  try {
    if (dbx.dialect === 'mssql') {
      // Data files only (type 0); size is counted in 8 KB pages.
      dbSizeBytes = Number((await dbx.prepare('SELECT SUM(CAST(size AS BIGINT)) * 8192 AS bytes FROM sys.database_files WHERE type = 0').get())?.bytes) || null;
    } else {
      dbSizeBytes = fs.statSync(DB_PATH).size;
    }
  } catch { /* db not found - unexpected but don't crash the page */ }

  const backups = listBackups();
  const latest = backups[0] || null;

  res.json({
    database: { sizeBytes: dbSizeBytes },
    disk: disk ? {
      freeBytes: disk.freeBytes,
      usedBytes: disk.usedBytes,
      totalBytes: disk.freeBytes + disk.usedBytes
    } : null,
    backups: {
      count: backups.length,
      latest: latest ? { name: latest.name, createdAt: latest.created_at, sizeBytes: latest.size_bytes } : null
    },
    alertRecipients: readAlertRecipients(),
    logs: {
      health: tailLog('health-monitor.log'),
      disk: tailLog('disk-monitor.log'),
      backup: tailLog('backup-monitor.log')
    }
  });
});

router.put('/monitoring/alert-recipients', requireRole('admin'), (req, res) => {
  const value = String(req.body?.value ?? '').trim();
  if (value && !value.split(',').every((e) => /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(e.trim()))) {
    return res.status(400).json({ error: 'One or more email addresses look invalid' });
  }
  try {
    writeAlertRecipients(value);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: `Could not write .env: ${e.message}` });
  }
});

export default router;
