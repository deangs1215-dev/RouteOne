// Background jobs - sync scheduler, digests, backups - run on timers, so nothing
// else exercises them. These call each job directly on either backend.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeone-sched-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.BACKUP_DIR = path.join(tempDir, 'backups');
process.env.SECRET_KEY ||= 'a'.repeat(64);
process.env.NODE_ENV = 'test';
const { dbx, closeDb } = await import('../db.js');
const { resetBackend, useMssql } = await import('./backend.js');
await resetBackend(dbx);
const { setSetting, getSetting } = await import('../dbh.js');
const { sendSyncDigest } = await import('../integration/syncDigest.js');
const { sendAllRepDigests } = await import('../integration/repDigest.js');
const { runAllNow, runRepSyncNow, isEntitySyncDue, repSyncDueNow } = await import('../integration/scheduler.js');
const { runBackup, listBackups } = await import('../backup.js');
const { runSync } = await import('../integration/sync.js');

after(() => { closeDb(); fs.rmSync(tempDir, { recursive: true, force: true }); });

const insert = async (sql, ...p) => (await dbx.prepare(sql).run(...p)).lastInsertRowid;
let rep;

test('fixture: a rep with yesterday\'s order, demo provider selected', async () => {
  await setSetting('intg_source', 'demo');
  for (const entity of ['warehouses', 'customers']) await runSync(entity); // demo rows: FG branch, rep codes 140/120
  const wh = await dbx.prepare("SELECT id FROM warehouses WHERE code = 'FG'").get();
  const role = await insert("INSERT INTO roles (name) VALUES ('rep')");
  rep = await insert("INSERT INTO users (name, email, password_hash, role_id, warehouse_id, rep_code, active) VALUES ('Rita Rep', 'rita@x.co', 'x', ?, ?, '140', 1)", role, wh.id);
  const cust = (await dbx.prepare("SELECT id FROM customers WHERE code = 'GOLD001'").get()).id;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace('T', ' ');
  await insert("INSERT INTO orders (number, customer_id, rep_id, warehouse_id, status, total, order_date) VALUES ('ORD-00001', ?, ?, ?, 'submitted', 115, ?)", cust, rep, wh.id, yesterday);
});

test('sync digest emails the last 24h of sync runs to each recipient', async () => {
  await setSetting('sync_digest_emails', 'ops@example.com; boss@example.com');
  const result = await sendSyncDigest('manual');
  assert.ok(result.runs >= 2, `runs in last 24h: ${result.runs}`);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.status !== 'error'), JSON.stringify(result.results));
  assert.match(await getSetting('last_sync_digest_result'), /ops@example.com/);
  const logged = await dbx.prepare("SELECT COUNT(*) AS n FROM email_log WHERE to_addr IN ('ops@example.com', 'boss@example.com')").get();
  assert.equal(logged.n, 2);
});

test('rep digest reports yesterday\'s orders to the rep', async () => {
  const results = await sendAllRepDigests('manual');
  assert.equal(results.length, 1, JSON.stringify(results));
  assert.notEqual(results[0].status, 'error', JSON.stringify(results));
  assert.ok(!/skipped/.test(results[0].status), 'yesterday\'s order should make the digest non-empty');
  assert.equal((await dbx.prepare("SELECT COUNT(*) AS n FROM email_log WHERE to_addr = 'rita@x.co'").get()).n, 1);
  assert.match(await getSetting('last_rep_digest_result'), /Rita Rep/);
});

test('manual full sync runs every entity and records the summary', async () => {
  const results = await runAllNow();
  assert.ok(Array.isArray(results) && results.length >= 7, `entities: ${results?.length}`);
  // The demo provider only has rows for some entities; the others must fail per-entity
  // without stopping the run.
  assert.ok(results.some((r) => r.error), 'demo provider has no rows for some entities');
  assert.ok(results.some((r) => !r.error));
  assert.ok(await getSetting('last_auto_sync_result'));
  assert.ok(await getSetting('last_auto_sync_at'));
});

test('rep sync (customer -> rep matching) runs', async () => {
  const result = await runRepSyncNow();
  assert.equal(typeof result.matched, 'number');
  assert.match(await getSetting('last_rep_sync_result'), /matched/);
});

test('backup: uploads always, database file only on SQLite', async () => {
  const dir = await runBackup();
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8'));
  assert.deepEqual(meta.includes, useMssql ? ['uploads'] : ['fieldsales.db', 'uploads']);
  assert.equal(fs.existsSync(path.join(dir, 'fieldsales.db')), !useMssql);
  assert.equal(listBackups().length, 1);
  assert.ok(await getSetting('last_backup_at'));
  if (useMssql) {
    const { restoreBackup } = await import('../backup.js');
    await assert.rejects(restoreBackup(path.basename(dir)), /not available with SQL Server/);
  }
});

// --- contract_pricing: the small, frequent contract/buying-group sync + its sanity check ---
const PRICE = (customer_code, product_code, contract_price, price_code_price, extra = {}) => ({
  customer_code, product_code, contract_price, price_code_price, buying_group_price: null,
  contract_start_date: contract_price == null ? null : '2026-01-01', contract_end_date: contract_price == null ? null : '2099-12-31',
  buying_group_start_date: null, buying_group_end_date: null, ...extra
});
const CONTRACT = (customer_code, product_code, contract_price) => {
  const { price_code_price, ...row } = PRICE(customer_code, product_code, contract_price, null);
  return row;
};
const priceRow = (c, p) => dbx.prepare('SELECT contract_price, contract_end_date, price_code_price FROM syspro_customer_pricing WHERE customer_code = ? AND product_code = ?').get(c, p);

test('contract_pricing sync: writes contract columns only, adds new pairs, clears vanished contracts', async () => {
  await dbx.prepare('DELETE FROM syspro_customer_pricing').run();
  await runSync('customer_pricing', { provider: { fetch: async () => [
    PRICE('A1', 'P1', 10, 12.5), PRICE('A1', 'P2', null, 20), PRICE('B1', 'P1', 30, 31)
  ] } });

  const res = await runSync('contract_pricing', { provider: { fetch: async () => [
    CONTRACT('A1', 'P1', 11),   // contract price changed
    CONTRACT('A1', 'P2', 18),   // contract appeared on a pair that only had a price-code price
    CONTRACT('C9', 'P9', 5)     // pair the big view never had at all
  ] } });                       // B1/P1's contract is no longer returned -> must be cleared
  assert.equal(res.rows_read, 3);

  assert.deepEqual({ ...(await priceRow('A1', 'P1')) }, { contract_price: 11, contract_end_date: '2099-12-31', price_code_price: 12.5 });
  assert.equal((await priceRow('A1', 'P2')).contract_price, 18);
  assert.equal((await priceRow('A1', 'P2')).price_code_price, 20, 'price_code_price belongs to the customer_pricing sync and must be left alone');
  assert.equal((await priceRow('C9', 'P9')).contract_price, 5);
  assert.equal((await priceRow('C9', 'P9')).price_code_price, null);
  const gone = await priceRow('B1', 'P1');
  assert.equal(gone.contract_price, null, 'a contract SYSPRO stopped returning must stop being quoted');
  assert.equal(gone.contract_end_date, null);
  assert.equal(gone.price_code_price, 31, 'its price-code price survives');
});

test('contract_pricing sync refuses a mass clear (view returning almost nothing) and says so', async () => {
  await dbx.prepare('DELETE FROM syspro_customer_pricing').run();
  const many = Array.from({ length: 700 }, (_, i) => PRICE(`M${i}`, 'P1', 10 + i, 50));
  await runSync('customer_pricing', { provider: { fetch: async () => many } });
  const res = await runSync('contract_pricing', { provider: { fetch: async () => [CONTRACT('M0', 'P1', 10)] } });
  assert.ok(res.row_errors >= 1, 'a warning is recorded on the run');
  const run = await dbx.prepare("SELECT error FROM sync_runs WHERE entity = 'contract_pricing' ORDER BY id DESC").get();
  assert.match(run.error, /not clearing/);
  assert.equal((await priceRow('M5', 'P1')).contract_price, 15, 'nothing was wiped');
});

test('contract check: flags a main view that is missing contracts, and a sudden drop, once per problem', async () => {
  await dbx.prepare('DELETE FROM syspro_customer_pricing').run();
  await runSync('customer_pricing', { provider: { fetch: async () => Array.from({ length: 20 }, (_, i) => PRICE(`K${i}`, 'P1', 10, 12)) } });
  const { checkContractPricing } = await import('../integration/contractCheck.js');
  await setSetting('sync_digest_emails', 'ops@example.com');
  await dbx.prepare("DELETE FROM email_log WHERE kind = 'sync_alert'").run();
  const alerts = async () => (await dbx.prepare("SELECT COUNT(*) AS n FROM email_log WHERE kind = 'sync_alert'").get()).n;

  await setSetting('contract_check_state', '');
  await setSetting('contract_check_mainview', JSON.stringify({ at: new Date().toISOString(), contract: 20, buyingGroup: 0 }));
  assert.deepEqual(await checkContractPricing({ minLines: 5 }), [], 'main view agrees with the contract view');
  assert.match(await getSetting('contract_check_result'), /^OK/);
  assert.equal(await alerts(), 0);

  // The 2026-10-06 failure: the big view held only a fraction of the contracts.
  await setSetting('contract_check_mainview', JSON.stringify({ at: new Date().toISOString(), contract: 4, buyingGroup: 0 }));
  const w = await checkContractPricing({ minLines: 5 });
  assert.equal(w.length, 1);
  assert.match(w[0], /main pricing view returned 4 contract prices but the contract view has 20/);
  assert.match(await getSetting('contract_check_result'), /^WARNING/);
  assert.equal(await alerts(), 1);
  await checkContractPricing({ minLines: 5 });
  assert.equal(await alerts(), 1, 'the same problem is not emailed again every 15 minutes');

  // Stale main-view figures (older than 36h) are not evidence of anything.
  await setSetting('contract_check_mainview', JSON.stringify({ at: new Date(Date.now() - 48 * 3600000).toISOString(), contract: 1, buyingGroup: 0 }));
  assert.deepEqual(await checkContractPricing({ minLines: 5 }), []);

  // A collapse between two runs.
  await setSetting('contract_check_mainview', '');
  await setSetting('contract_check_state', JSON.stringify({ at: new Date().toISOString(), contract: 100, buyingGroup: 0 }));
  const drop = await checkContractPricing({ minLines: 5 });
  assert.match(drop[0], /dropped from 100 to 20/);
});

test('contract_pricing schedule: on by default every 15 minutes, 30 minutes selectable, off honoured', async () => {
  await setSetting('contract_pricing_sync_schedule', '');
  await setSetting('last_contract_pricing_sync_at', '');
  assert.equal(await isEntitySyncDue('contract_pricing'), true, 'never run -> due, even though the form saved a blank schedule');
  await setSetting('last_contract_pricing_sync_at', new Date(Date.now() - 10 * 60000).toISOString());
  assert.equal(await isEntitySyncDue('contract_pricing'), false, 'ran 10 min ago');
  await setSetting('last_contract_pricing_sync_at', new Date(Date.now() - 16 * 60000).toISOString());
  assert.equal(await isEntitySyncDue('contract_pricing'), true, 'ran 16 min ago');
  await setSetting('contract_pricing_sync_schedule', '30min');
  assert.equal(await isEntitySyncDue('contract_pricing'), false, 'every 30 min: 16 min is not enough');
  await setSetting('last_contract_pricing_sync_at', new Date(Date.now() - 31 * 60000).toISOString());
  assert.equal(await isEntitySyncDue('contract_pricing'), true);
  await setSetting('contract_pricing_sync_schedule', 'off');
  assert.equal(await isEntitySyncDue('contract_pricing'), false);
  assert.equal(await isEntitySyncDue('customer_pricing'), false, 'other entities still default to off');
  await setSetting('contract_pricing_sync_schedule', '');
});

test('customer_pricing bulk sync at scale: loads, then re-syncs unchanged', async () => {
  const N = 60000;
  const rows = Array.from({ length: N }, (_, i) => ({
    customer_code: `C${String(i % 2000).padStart(5, '0')}`, product_code: `P${String(Math.floor(i / 2000)).padStart(4, '0')}`,
    contract_price: 10 + (i % 97), buying_group_price: null, price_code_price: 12.5,
    contract_start_date: '2026-01-01', contract_end_date: '2026-12-31', buying_group_start_date: null, buying_group_end_date: null
  }));
  const provider = { fetch: async () => rows.map((r) => ({ ...r })) };
  const count = () => dbx.prepare('SELECT COUNT(*) AS n FROM syspro_customer_pricing').get();
  const existing = (await count()).n; // demo rows from the full sync above
  const first = await runSync('customer_pricing', { provider });
  assert.equal(first.rows_upserted, N);
  assert.equal((await count()).n, existing + N);
  const second = await runSync('customer_pricing', { provider });
  assert.equal(second.rows_upserted, N);
  assert.equal((await count()).n, existing + N); // re-sync adds nothing
  const sample = await dbx.prepare("SELECT contract_price FROM syspro_customer_pricing WHERE customer_code = 'C00007' AND product_code = 'P0000'").get();
  assert.equal(sample.contract_price, 10 + 7);
});

// "Twice daily at 08:00 and 17:00": driven through the real scheduler checks with the settings stored
// exactly as the Integration form saves them. Slot times are built relative to "now" so the test does
// not depend on the hour it runs; skipped within ~10 minutes of midnight, where "earlier today" breaks.
test('twice-daily schedule is honoured by the scheduler (data syncs and rep match)', async (t) => {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 15 || mins > 23 * 60 + 45) return t.skip('too close to midnight for a same-day slot test');
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const earlier = hhmm(mins - 10);   // first slot already passed
  const later = hhmm(Math.min(mins + 10, 23 * 60 + 59)); // second slot still ahead
  for (const [dueFn, schedKey, t1, t2, lastKey, arg] of [
    [isEntitySyncDue, 'customers_sync_schedule', 'customers_sync_daily_time', 'customers_sync_daily_time2', 'last_customers_sync_at', 'customers'],
    [repSyncDueNow, 'rep_sync_schedule', 'rep_sync_daily_time', 'rep_sync_daily_time2', 'last_rep_sync_at', undefined]
  ]) {
    await setSetting(schedKey, 'twice_daily');
    await setSetting(t1, earlier);
    await setSetting(t2, later);
    await setSetting(lastKey, new Date(Date.now() - 3600000).toISOString());          // last ran an hour ago
    assert.equal(await dueFn(arg), true, `${schedKey}: first slot passed since the last run -> due`);
    await setSetting(lastKey, new Date().toISOString());                                // just ran
    assert.equal(await dueFn(arg), false, `${schedKey}: already ran after that slot -> not due`);
    await setSetting(t2, earlier);                                                      // both slots in the past
    await setSetting(lastKey, new Date(Date.now() - 3600000).toISOString());
    assert.equal(await dueFn(arg), true, `${schedKey}: due`);
    await setSetting(t1, '');                                                           // blank times (untouched form fields) fall back to 08:00 / 17:00, no crash
    await setSetting(t2, '');
    assert.equal(typeof (await dueFn(arg)), 'boolean');
    await setSetting(schedKey, 'off');
    assert.equal(await dueFn(arg), false, `${schedKey}: off -> never due`);
  }
});
