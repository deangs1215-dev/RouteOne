// In-app scheduled SYSPRO sync. No external cron/Task Scheduler needed - a
// once-a-minute tick checks whether an auto-sync is due and runs all entities.
// Configured from the Integration page (sync_schedule + sync_daily_time).
import { dbx, getTodayISO } from '../db.js';
import { getSetting, setSetting } from '../dbh.js';
import { runSync, SYNC_ENTITIES, matchRep } from './sync.js';
import { getProvider } from './providers.js';

let running = false;

// Run entities that are due (or all if trigger is 'manual')
// A scheduled run syncs ONLY the entities whose own schedule says they are due;
// a manual run ("sync now" from the Integration page) deliberately syncs
// everything. This used to compare trigger === 'schedule' while the only
// scheduled caller passes 'scheduled' - so the comparison was never true and
// every tick re-synced all seven entities, ignoring their individual settings.
// That is what dragged the 4.3M-row customer_pricing import into every hourly
// run even when it was configured as daily. Keyed off 'manual' now so a
// mismatch in the scheduled label cannot silently resurrect it.
async function runAll(trigger = 'schedule', onlyDue = true) {
  if (running) return; // never overlap two syncs
  running = true;
  const results = [];
  try {
    const entitiesToSync = onlyDue && trigger !== 'manual' ? await getEntitiesDueNow() : SYNC_ENTITIES;
    if (entitiesToSync.length === 0) {
      running = false;
      return [];
    }

    for (const entity of entitiesToSync) {
      try {
        const result = await runSync(entity);
        results.push(result);
        await setSetting(`last_${entity}_sync_at`, new Date().toISOString());
      } catch (e) {
        results.push({ entity, error: e.message });
      }
    }

    const summary = results
      .map((r) => (r.error ? `${r.entity}:ERR` : `${r.entity} ${r.rows_upserted}/${r.rows_read}`))
      .join(' · ');
    await setSetting('last_auto_sync_at', new Date().toISOString());
    await setSetting('last_auto_sync_result', summary);
    console.log(`[scheduler] ${trigger} sync complete — ${summary}`);
  } finally {
    running = false;
  }
  return results;
}

// Check if a specific entity's sync is due
async function isEntitySyncDue(entity) {
  const schedule = await getSetting(`${entity}_sync_schedule`, 'off');
  if (schedule === 'off') return false;

  const lastKey = `last_${entity}_sync_at`;
  const last = await getSetting(lastKey, null);
  const minsSince = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;

  if (schedule === 'hourly') return minsSince >= 60;
  if (schedule === '4hours') return minsSince >= 240;
  if (schedule === 'daily') {
    const timeKey = `${entity}_sync_daily_time`;
    const [h, m] = (await getSetting(timeKey, '02:00')).split(':').map(Number);
    const now = new Date();
    // Fires once the scheduled time has passed today, not only in the exact
    // minute it lands on - an exact-minute match silently skips the whole day
    // if the process happens to not be running (restart, deploy, crash) at
    // that one minute, with no error and no catch-up. Confirmed live:
    // customer_sales (04:01 daily) went from 2026-08-31 to 2026-09-08 with
    // zero syncs this way, while hourly/4hours entities on the same server
    // kept running fine since they just check elapsed time. The 23h floor
    // (not 24h) leaves a tick-granularity safety margin while still stopping
    // it firing more than once on a day it already ran - a successful run
    // resets minsSince to ~0 immediately.
    const scheduledMinutesToday = h * 60 + m;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return nowMinutes >= scheduledMinutesToday && minsSince >= 23 * 60;
  }
  return false;
}

// Get all entities that need syncing right now
async function getEntitiesDueNow() {
  const due = [];
  for (const entity of SYNC_ENTITIES) {
    if (await isEntitySyncDue(entity)) due.push(entity);
  }
  return due;
}

// Is an auto-sync due right now, given the schedule and the last run time?
async function dueNow() {
  return (await getEntitiesDueNow()).length > 0;
}

// Rep sync: match customers to their sales reps based on warehouse + rep code.
async function runRepSync(trigger = 'schedule') {
  const rows = await (await getProvider()).fetch('customers');
  let matched = 0, alreadyAssigned = 0, noMatch = 0, notFound = 0;
  for (const row of rows) {
    const customer = await dbx.prepare('SELECT id, rep_id FROM customers WHERE code = ?').get(row.code);
    if (!customer) { notFound++; continue; }
    if (customer.rep_id) { alreadyAssigned++; continue; }
    const repId = await matchRep(row.warehouse_code, row.rep_code);
    if (repId) {
      await dbx.prepare('UPDATE customers SET rep_id = ? WHERE id = ?').run(repId, customer.id);
      matched++;
    } else {
      noMatch++;
    }
  }
  const summary = `${matched} matched, ${alreadyAssigned} already assigned, ${noMatch} no match, ${notFound} not found`;
  await setSetting('last_rep_sync_at', new Date().toISOString());
  await setSetting('last_rep_sync_result', summary);
  console.log(`[scheduler] ${trigger} rep sync complete — ${summary}`);
  return { matched, alreadyAssigned, noMatch, notFound };
}

// Is a rep sync due right now, given the schedule and the last run time?
async function repSyncDueNow() {
  const schedule = await getSetting('rep_sync_schedule', 'off');
  if (schedule === 'off') return false;

  const last = await getSetting('last_rep_sync_at', null);
  const minsSince = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;

  if (schedule === 'daily') {
    const [h, m] = (await getSetting('rep_sync_daily_time', '03:00')).split(':').map(Number);
    const now = new Date();
    // Same catch-up fix as isEntitySyncDue above - fire once the scheduled
    // time has passed today (23h floor, not an exact-minute match), so a
    // restart/deploy landing on that one minute doesn't silently skip the
    // whole day.
    const scheduledMinutesToday = h * 60 + m;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return nowMinutes >= scheduledMinutesToday && minsSince >= 23 * 60;
  }
  return false;
}

export function startScheduler() {
  setInterval(async () => {
    try {
      // Both are async: a synchronous try/catch never sees their rejections, so
      // each needs its own .catch(). A SYSPRO connectivity blip inside
      // runRepSync's fetch would otherwise surface as an unhandled rejection,
      // which Node treats as fatal - taking the whole API down with it.
      if (await dueNow()) runAll('scheduled').catch((e) => console.error('[scheduler] sync failed:', e.message));
      if (await repSyncDueNow()) runRepSync('scheduled').catch((e) => console.error('[scheduler] rep sync failed:', e.message));
    } catch (e) {
      console.error('[scheduler] tick error:', e.message);
    }
  }, 60000);
  console.log('[scheduler] started — checking every minute for due syncs (data sync + rep sync)');
}

// Exposed so an admin can trigger the full auto-sync run on demand.
export function runAllNow() {
  return runAll('manual');
}

// Exposed so an admin can trigger rep sync on demand.
export function runRepSyncNow() {
  return runRepSync('manual');
}
