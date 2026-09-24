// Daily SYSPRO sync digest: emails every sync_runs row from the last 24 hours
// to the configured recipient(s). Scheduling mirrors repDigest.js (a
// once-a-minute tick, no external cron needed), but uses the 23h-floor "has
// the scheduled time passed today" check from scheduler.js rather than
// repDigest's exact-minute match - that exact-minute pattern is known to
// silently skip a whole day if the process isn't running in that one minute
// (see scheduler.js's isEntitySyncDue comment for the incident this fixed).
import { db, getSetting, setSetting } from '../db.js';
import { buildSyncDigestEmail, sendEmail } from './email.js';

function recipients() {
  return getSetting('sync_digest_emails', '')
    .split(/[,;]/)
    .map((e) => e.trim())
    .filter(Boolean);
}

export async function sendSyncDigest(trigger = 'schedule') {
  const runs = db.prepare(`
    SELECT entity, status, rows_read, rows_upserted, rows_skipped, error, started_at, finished_at
    FROM sync_runs
    WHERE started_at >= datetime('now', '-1 day')
    ORDER BY started_at DESC
  `).all();

  const to = recipients();
  const results = [];
  for (const toAddr of to) {
    try {
      const draft = buildSyncDigestEmail(runs, { toAddr });
      const sent = await sendEmail(draft);
      results.push({ to: toAddr, status: sent.status });
    } catch (e) {
      results.push({ to: toAddr, status: 'error', error: e.message });
    }
  }

  setSetting('last_sync_digest_at', new Date().toISOString());
  setSetting('last_sync_digest_result', results.length
    ? results.map((r) => `${r.to}:${r.status}`).join(' · ')
    : 'no recipients configured');
  console.log(`[sync-digest] ${trigger} run complete — ${runs.length} runs in last 24h, sent to ${results.length} recipient(s)`);
  return { runs: runs.length, results };
}

// Fires once the scheduled time has passed today, same catch-up logic as
// scheduler.js's isEntitySyncDue - a 23h floor (not 24h) leaves tick-
// granularity safety margin while still stopping a second fire on a day
// that already ran, since a successful run resets minsSince to ~0.
function dueNow() {
  if (getSetting('sync_digest_enabled', '0') !== '1') return false;
  if (!recipients().length) return false;
  const last = getSetting('last_sync_digest_at', null);
  const minsSince = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;
  const [h, m] = getSetting('sync_digest_time', '07:00').split(':').map(Number);
  const now = new Date();
  const scheduledMinutesToday = h * 60 + m;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= scheduledMinutesToday && minsSince >= 23 * 60;
}

export function startSyncDigestScheduler() {
  setInterval(() => {
    try {
      if (dueNow()) sendSyncDigest('scheduled').catch((e) => console.error('[sync-digest] send failed:', e.message));
    } catch (e) {
      console.error('[sync-digest] tick error:', e.message);
    }
  }, 60000);
  console.log('[sync-digest] started — checking every minute for the daily sync summary time');
}
