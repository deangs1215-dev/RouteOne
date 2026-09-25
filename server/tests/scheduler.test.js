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
const { runAllNow, runRepSyncNow } = await import('../integration/scheduler.js');
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
