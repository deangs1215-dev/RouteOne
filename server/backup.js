import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { db, closeDb, DB_PATH, UPLOAD_DIR, getSetting, setSetting } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupRoot = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, 'backups'));
let running = false;

function backupStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// DB setting wins (editable from the Backups admin page); env var is the
// pre-audit default for deployments that haven't touched the setting yet.
function retentionDays() {
  const fromSetting = Number(getSetting('backup_retention_days', ''));
  if (Number.isFinite(fromSetting) && fromSetting >= 1) return Math.floor(fromSetting);
  const fromEnv = Number(process.env.BACKUP_RETENTION_DAYS || 14);
  return Number.isFinite(fromEnv) && fromEnv >= 1 ? Math.floor(fromEnv) : 14;
}

function assertBackupChild(targetPath) {
  const resolved = path.resolve(targetPath);
  if (path.dirname(resolved) !== backupRoot) {
    throw new Error('Backup path escaped the configured backup directory');
  }
  return resolved;
}

function pruneOldBackups() {
  const cutoff = Date.now() - retentionDays() * 86400000;
  for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('routeone-') || entry.name.endsWith('.tmp')) continue;
    const fullPath = assertBackupChild(path.join(backupRoot, entry.name));
    if (fs.statSync(fullPath).mtimeMs < cutoff) fs.rmSync(fullPath, { recursive: true, force: true });
  }
}

// Recursive directory size in bytes - only used for the admin listing, so a
// plain synchronous walk is fine (backups are a handful of directories, not
// thousands).
function dirSize(dirPath) {
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

export async function runBackup() {
  if (running) throw new Error('A backup is already running');
  running = true;
  fs.mkdirSync(backupRoot, { recursive: true });
  const stamp = backupStamp();
  const finalDir = assertBackupChild(path.join(backupRoot, `routeone-${stamp}`));
  const tempDir = assertBackupChild(`${finalDir}.tmp`);
  try {
    fs.mkdirSync(tempDir, { recursive: false });
    await db.backup(path.join(tempDir, 'fieldsales.db'));
    fs.cpSync(UPLOAD_DIR, path.join(tempDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'backup.json'), JSON.stringify({
      created_at: new Date().toISOString(),
      includes: ['fieldsales.db', 'uploads'],
      retention_days: retentionDays()
    }, null, 2));
    fs.renameSync(tempDir, finalDir);
    setSetting('last_backup_at', new Date().toISOString());
    setSetting('last_backup_path', finalDir);
    pruneOldBackups();
    return finalDir;
  } catch (error) {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  } finally {
    running = false;
  }
}

// Admin-facing list, newest first.
export function listBackups() {
  fs.mkdirSync(backupRoot, { recursive: true });
  const rows = [];
  for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('routeone-') || entry.name.endsWith('.tmp')) continue;
    const fullPath = path.join(backupRoot, entry.name);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(fullPath, 'backup.json'), 'utf8')); } catch { /* older/partial backup - still listable */ }
    rows.push({
      name: entry.name,
      created_at: meta.created_at || fs.statSync(fullPath).mtime.toISOString(),
      size_bytes: dirSize(fullPath)
    });
  }
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Restores a snapshot over the live database and uploads folder. This can only
// be done with the DB file closed (SQLite holds it open continuously, and
// Windows won't let another write replace an open file) - so this function
// takes a safety backup of the CURRENT state first, closes the db, replaces
// the files, then intentionally ends the process. The caller (routes/backups)
// must respond to the HTTP request before the process exits, and the admin
// must restart the server afterward for the restored data to take effect.
export async function restoreBackup(name) {
  if (running) throw new Error('A backup or restore is already running');
  if (typeof name !== 'string' || !/^routeone-[\w-]+$/.test(name)) {
    throw new Error('Invalid backup name');
  }
  const sourceDir = assertBackupChild(path.join(backupRoot, name));
  if (!fs.existsSync(sourceDir) || !fs.existsSync(path.join(sourceDir, 'backup.json'))) {
    throw new Error('Backup not found');
  }
  const sourceDbPath = path.join(sourceDir, 'fieldsales.db');
  const sourceUploadsPath = path.join(sourceDir, 'uploads');
  if (!fs.existsSync(sourceDbPath)) throw new Error('Backup is missing its database file');

  // Safety net: snapshot the current (pre-restore) state so an accidental
  // restore is itself recoverable. This runs BEFORE the restore claims the
  // `running` lock, because runBackup() takes that same lock itself - claiming
  // it first made every restore fail on "A backup is already running".
  await runBackup();

  running = true;
  try {
    closeDb();
    // WAL/SHM sidecar files must go too, or the restored .db reopens against
    // stale write-ahead data left over from the live database.
    for (const suffix of ['', '-wal', '-shm']) {
      const liveFile = `${DB_PATH}${suffix}`;
      if (fs.existsSync(liveFile)) fs.rmSync(liveFile, { force: true });
    }
    fs.copyFileSync(sourceDbPath, DB_PATH);

    if (fs.existsSync(sourceUploadsPath)) {
      fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
      fs.cpSync(sourceUploadsPath, UPLOAD_DIR, { recursive: true });
    }
  } finally {
    running = false;
  }
}

// Fires once per day at the configured time (default 02:00), mirroring the
// rep-digest scheduler's pattern. Disabled by default is NOT the case here -
// backups default ON, matching the pre-audit always-on behaviour; the admin
// can turn them off from the Backups page if truly not wanted.
function dueNow() {
  if (getSetting('backup_enabled', '1') !== '1') return false;
  const last = getSetting('last_backup_at', '');
  const minsSince = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;
  const [h, m] = getSetting('backup_time', '02:00').split(':').map(Number);
  const now = new Date();
  return now.getHours() === h && now.getMinutes() === m && minsSince >= 2;
}

async function runIfDue() {
  if (!dueNow()) return;
  try {
    const destination = await runBackup();
    console.log(`[backup] scheduled backup completed: ${destination}`);
  } catch (error) {
    console.error('[backup] scheduled backup failed:', error.message);
  }
}

export function startBackupScheduler() {
  // Catch-up for a server that was down through its scheduled time, or has
  // never backed up at all - same "well overdue" safety net the old always-on
  // ">23h" check gave us, just gated by the enabled flag now.
  const last = getSetting('last_backup_at', '');
  const hoursSince = last ? (Date.now() - new Date(last).getTime()) / 3600000 : Infinity;
  if (getSetting('backup_enabled', '1') === '1' && hoursSince >= 25) {
    runBackup()
      .then((destination) => console.log(`[backup] catch-up backup completed: ${destination}`))
      .catch((error) => console.error('[backup] catch-up backup failed:', error.message));
  }
  const timer = setInterval(runIfDue, 60 * 1000);
  timer.unref?.();
}

const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runBackup()
    .then((destination) => console.log(`Backup completed: ${destination}`))
    .catch((error) => {
      console.error(`Backup failed: ${error.message}`);
      process.exitCode = 1;
    });
}
