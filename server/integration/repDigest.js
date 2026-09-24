// Daily rep email digest: yesterday's orders + today's planned customers with
// their open tasks and Sales AI alerts. Reuses the same day-summary query as
// the mobile "My day" screen, so the email always matches what's in the app.
// Scheduling mirrors scheduler.js (SYSPRO sync) - a once-a-minute tick, no
// external cron needed.
import { db, getSetting, setSetting, getTodayISO } from '../db.js';
import { buildDaySummary } from '../routes/visits.routes.js';
import { buildRepDigestEmail, sendEmail } from './email.js';

async function sendDigestFor(rep) {
  const today = getTodayISO();
  const daySummary = await buildDaySummary(rep.id, today);
  const yesterdayOrders = db.prepare(`
    SELECT o.number, o.total, c.name AS customer_name
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.rep_id = ? AND date(o.order_date) = date('now', '-1 day') AND o.status != 'cancelled'
    ORDER BY o.order_date
  `).all(rep.id);

  // Nothing to report - skip so reps aren't emailed an empty digest.
  if (yesterdayOrders.length === 0 && daySummary.visits.length === 0) return null;

  const draft = buildRepDigestEmail(rep, { yesterdayOrders, today: daySummary });
  return sendEmail(draft);
}

export async function sendAllRepDigests(trigger = 'schedule') {
  const reps = db.prepare(`
    SELECT u.id, u.name, u.email FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'rep' AND u.active = 1 AND u.email IS NOT NULL AND u.email != ''
  `).all();

  const results = [];
  for (const rep of reps) {
    try {
      const sent = await sendDigestFor(rep);
      results.push({ rep: rep.name, status: sent ? sent.status : 'skipped (nothing to report)' });
    } catch (e) {
      results.push({ rep: rep.name, status: 'error', error: e.message });
    }
  }
  setSetting('last_rep_digest_at', new Date().toISOString());
  setSetting('last_rep_digest_result', results.map((r) => `${r.rep}:${r.status}`).join(' · '));
  console.log(`[rep-digest] ${trigger} run complete — ${results.length} reps processed`);
  return results;
}

// Fires once when the clock reaches the configured send time (default 07:00).
function dueNow() {
  if (getSetting('rep_digest_enabled', '0') !== '1') return false;
  const last = getSetting('last_rep_digest_at', null);
  const minsSince = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;
  const [h, m] = getSetting('rep_digest_time', '07:00').split(':').map(Number);
  const now = new Date();
  return now.getHours() === h && now.getMinutes() === m && minsSince >= 2;
}

export function startRepDigestScheduler() {
  setInterval(() => {
    try {
      if (dueNow()) sendAllRepDigests('scheduled');
    } catch (e) {
      console.error('[rep-digest] tick error:', e.message);
    }
  }, 60000);
  console.log('[rep-digest] started — checking every minute for the daily digest time');
}
