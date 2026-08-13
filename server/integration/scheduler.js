// In-app scheduled SYSPRO sync. No external cron/Task Scheduler needed - a
// once-a-minute tick checks whether an auto-sync is due and runs all entities.
// Configured from the Integration page (sync_schedule + sync_daily_time).
import { getSetting, setSetting, db, getTodayISO } from '../db.js';
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
    const entitiesToSync = onlyDue && trigger !== 'manual' ? getEntitiesDueNow() : SYNC_ENTITIES;
    if (entitiesToSync.length === 0) {
      running = false;
      return [];
    }

    for (const entity of entitiesToSync) {
      try {
        const result = await runSync(entity);
        results.push(result);
        setSetting(`last_${entity}_sync_at`, new Date().toISOString());
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

// Check if a specific entity's sync is due
function isEntitySyncDue(entity) {
  const schedule = getSetting(`${entity}_sync_schedule`, 'off');
  if (schedule === 'off') return false;

  const lastKey = `last_${entity}_sync_at`;
  const last = getSetting(lastKey, null);
  const minsSince = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;

  if (schedule === 'hourly') return minsSince >= 60;
  if (schedule === '4hours') return minsSince >= 240;
  if (schedule === 'daily') {
    const timeKey = `${entity}_sync_daily_time`;
    const [h, m] = getSetting(timeKey, '02:00').split(':').map(Number);
    const now = new Date();
    return now.getHours() === h && now.getMinutes() === m && minsSince >= 2;
  }
  return false;
}

// Get all entities that need syncing right now
function getEntitiesDueNow() {
  return SYNC_ENTITIES.filter(entity => isEntitySyncDue(entity));
}

// Is an auto-sync due right now, given the schedule and the last run time?
function dueNow() {
  return getEntitiesDueNow().length > 0;
}

// Rep sync: match customers to their sales reps based on warehouse + rep code.
async function runRepSync(trigger = 'schedule') {
  const rows = await getProvider().fetch('customers');
  let matched = 0, alreadyAssigned = 0, noMatch = 0, notFound = 0;
  for (const row of rows) {
    const customer = db.prepare('SELECT id, rep_id FROM customers WHERE code = ?').get(row.code);
    if (!customer) { notFound++; continue; }
    if (customer.rep_id) { alreadyAssigned++; continue; }
    const repId = matchRep(row.warehouse_code, row.rep_code);
    if (repId) {
      db.prepare('UPDATE customers SET rep_id = ? WHERE id = ?').run(repId, customer.id);
      matched++;
    } else {
      noMatch++;
    }
  }
  const summary = `${matched} matched, ${alreadyAssigned} already assigned, ${noMatch} no match, ${notFound} not found`;
  setSetting('last_rep_sync_at', new Date().toISOString());
  setSetting('last_rep_sync_result', summary);
  console.log(`[scheduler] ${trigger} rep sync complete — ${summary}`);
  return { matched, alreadyAssigned, noMatch, notFound };
}

// Is a rep sync due right now, given the schedule and the last run time?
function repSyncDueNow() {
  const schedule = getSetting('rep_sync_schedule', 'off');
  if (schedule === 'off') return false;

  const last = getSetting('last_rep_sync_at', null);
  const minsSince = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;

  if (schedule === 'daily') {
    const [h, m] = getSetting('rep_sync_daily_time', '03:00').split(':').map(Number);
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
      if (repSyncDueNow()) runRepSync('scheduled');
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
