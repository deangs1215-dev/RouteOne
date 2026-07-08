// In-app scheduled SYSPRO sync. No external cron/Task Scheduler needed - a
// once-a-minute tick checks whether an auto-sync is due and runs all entities.
// Configured from the Integration page (sync_schedule + sync_daily_time).
import { getSetting, setSetting } from '../db.js';
import { runSync, SYNC_ENTITIES } from './sync.js';

let running = false;

// Run every entity in dependency order (prices reference customers + products).
async function runAll(trigger = 'schedule') {
  if (running) return; // never overlap two syncs
  running = true;
  const results = [];
  try {
    for (const entity of SYNC_ENTITIES) {
      try {
        results.push(await runSync(entity));
      } catch (e) {
        results.push({ entity, error: e.message });
      }
    }
    const summary = results
      .map((r) => (r.error ? `${r.entity}:ERR` : `${r.entity} ${r.rows_upserted}/${r.rows_read}`))
      .join(' · ');
    setSetting('last_auto_sync_at', new Date().toISOString());
    setSetting('last_auto_sync_result', summary);
    console.log(`[scheduler] ${trigger} sync complete — ${summary}`);
  } finally {
    running = false;
  }
  return results;
}

// Is an auto-sync due right now, given the schedule and the last run time?
function dueNow() {
  const schedule = getSetting('sync_schedule', 'off');
  if (schedule === 'off') return false;

  const last = getSetting('last_auto_sync_at', null);
  const minsSince = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;

  if (schedule === 'hourly') return minsSince >= 60;
  if (schedule === '4hours') return minsSince >= 240;
  if (schedule === 'daily') {
    const [h, m] = getSetting('sync_daily_time', '02:00').split(':').map(Number);
    const now = new Date();
    // Fire once when the clock reaches the target minute (guard stops re-firing).
    return now.getHours() === h && now.getMinutes() === m && minsSince >= 2;
  }
  return false;
}

export function startScheduler() {
  setInterval(() => {
    try {
      if (dueNow()) runAll('scheduled');
    } catch (e) {
      console.error('[scheduler] tick error:', e.message);
    }
  }, 60000);
  console.log('[scheduler] started — checking every minute for a due SYSPRO sync');
}

// Exposed so an admin can trigger the full auto-sync run on demand.
export function runAllNow() {
  return runAll('manual');
}
