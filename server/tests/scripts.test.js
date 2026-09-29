// The one-off admin/seed scripts are what you reach for in an emergency (reset a
// password, hand a rep over), and they are not exercised by the API tests - so a
// migration mistake in one would only show up at the worst moment. This runs each
// against a throwaway database and checks its effect.
//
// SQLite by default. On SQL Server (DB_BACKEND=mssql) it destroys the target's
// data, so it only runs against a database named RouteOne_Test:
//   DB_BACKEND=mssql DB_NAME=RouteOne_Test node --env-file=server/.env --test server/tests/scripts.test.js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const useMssql = (process.env.DB_BACKEND || '').toLowerCase() === 'mssql';
const guard = useMssql && process.env.DB_NAME !== 'RouteOne_Test' ? 'refusing to run destructive script tests on any database but RouteOne_Test' : false;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeone-scripts-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.SECRET_KEY ||= 'a'.repeat(64);
process.env.NODE_ENV = 'test';
process.env.DISABLE_SCHEDULERS = '1';
const { dbx, closeDb } = guard ? { dbx: null, closeDb() {} } : await import('../db.js');

after(() => { closeDb(); fs.rmSync(tempDir, { recursive: true, force: true }); });

function node(script, args = [], { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: projectRoot, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}
const ok = (r, label) => assert.equal(r.code, 0, `${label} exited ${r.code}\n${r.out.slice(-600)}\n${r.err.slice(-600)}`);
const S = { skip: guard };

before(async () => { if (!guard) ok(await node('server/seed.js'), 'seed'); });

test('seed loaded data', S, async () => {
  assert.ok((await dbx.prepare('SELECT COUNT(*) AS n FROM customers').get()).n > 0);
});

test('read-only diagnostics run', S, async () => {
  // The scratch database may carry SYSPRO settings migrated from a real backup
  // (encrypted with another SECRET_KEY); clear them so the outcome is deterministic.
  await dbx.prepare("DELETE FROM settings WHERE [key] LIKE 'syspro_%'").run();
  await dbx.prepare("UPDATE settings SET [value] = 'demo' WHERE [key] = 'intg_source'").run();
  // These read the live SYSPRO views, so with no SYSPRO configured they must fail
  // cleanly with that message - which also proves the async config path ran.
  for (const script of ['reconcile-reps', 'diagnose-unmatched', 'list-orphan-reps']) {
    const r = await node(`server/${script}.js`);
    assert.ok(r.code === 0 || /SYSPRO connection is not configured/.test(r.out + r.err), `${script}: exit ${r.code}\n${r.err.slice(-400)}`);
  }
});

test('lowercase-email-recipients: dry run changes nothing, real run lowercases', S, async () => {
  await dbx.prepare("INSERT INTO email_recipients (name, email, category) VALUES ('Mixed', 'MiXed.Case@Example.com', 'orders')").run();
  ok(await node('server/lowercase-email-recipients.js', ['--dry']), 'dry');
  assert.equal((await dbx.prepare("SELECT email FROM email_recipients WHERE name = 'Mixed'").get()).email, 'MiXed.Case@Example.com');
  ok(await node('server/lowercase-email-recipients.js'), 'real');
  assert.equal((await dbx.prepare("SELECT email FROM email_recipients WHERE name = 'Mixed'").get()).email, 'mixed.case@example.com');
});

test('seed-jhb-order-recipients: adds the Johannesburg recipients once', S, async () => {
  await dbx.prepare("INSERT INTO warehouses (code, name) VALUES ('01', 'JOHANNESBURG DESPATCH')").run();
  ok(await node('server/seed-jhb-order-recipients.js', ['--dry']), 'dry');
  const before = (await dbx.prepare('SELECT COUNT(*) AS n FROM email_recipients').get()).n;
  ok(await node('server/seed-jhb-order-recipients.js'), 'real');
  const after = (await dbx.prepare('SELECT COUNT(*) AS n FROM email_recipients').get()).n;
  assert.equal(after - before, 8);
  ok(await node('server/seed-jhb-order-recipients.js'), 'rerun'); // idempotent
  assert.equal((await dbx.prepare('SELECT COUNT(*) AS n FROM email_recipients').get()).n, after);
});

test('handover-rep: dry run writes nothing, real run swaps the account', S, async () => {
  const wh = await dbx.prepare("SELECT id FROM warehouses WHERE code = '01'").get();
  const rep = await dbx.prepare("SELECT id FROM users WHERE email = 'rep@demo.co.za'").get();
  await dbx.prepare("UPDATE users SET rep_code = '111', warehouse_id = ? WHERE id = ?").run(wh.id, rep.id);
  const args = ['--code', '111', '--branch', '01', '--name', 'New Rep', '--email', 'new.rep@example.com'];
  ok(await node('server/handover-rep.js', [...args, '--dry']), 'dry');
  assert.equal(await dbx.prepare("SELECT id FROM users WHERE email = 'new.rep@example.com'").get(), undefined);
  const r = await node('server/handover-rep.js', args);
  ok(r, 'real');
  assert.match(r.out, /password\s*:/);
  const out = await dbx.prepare('SELECT active, rep_code FROM users WHERE id = ?').get(rep.id);
  assert.equal(out.active, 0);
  assert.equal(out.rep_code, null);
  const incoming = await dbx.prepare("SELECT rep_code, active, must_change_password FROM users WHERE email = 'new.rep@example.com'").get();
  assert.deepEqual({ ...incoming }, { rep_code: '111', active: 1, must_change_password: 1 });
});

test('import-reps run(): creates accounts inside one transaction, skips existing', S, async () => {
  const { run } = await import('../import-reps.js');
  const wh = await dbx.prepare("SELECT code FROM warehouses ORDER BY id LIMIT 1").get();
  const rows = [{ rep_code: '06', rep_name: 'Milton Test', branch: wh.code, active_customers: 3 }];
  const first = await run(rows);
  assert.equal(first.created.length, 1, JSON.stringify(first));
  const user = await dbx.prepare("SELECT rep_code, active FROM users WHERE rep_code = '06'").get();
  assert.deepEqual({ ...user }, { rep_code: '06', active: 1 });
  const second = await run(rows);
  assert.equal(second.created.length, 0);
  assert.equal(second.skipped[0].reason, 'rep_code already has a user');
});

// The password prompt needs a real terminal (hidden input), so the new-password
// step cannot be scripted. What can be checked is the part before it: argument
// handling and the async user lookup, for a missing and for an existing account.
test('reset-password finds the account (or reports it missing) before prompting', S, async () => {
  const missing = await node('server/reset-password.js', ['nobody@example.com']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /No user with email nobody@example.com/);
  const found = await node('server/reset-password.js', ['admin@demo.co.za']);
  assert.match(found.out, /Resetting password for:\s+\S.*<admin@demo.co.za>\s+role=admin/);
  assert.equal((await node('server/reset-password.js')).code, 1); // usage
});

test('seed-invoices rebuilds demo invoices', S, async () => {
  ok(await node('server/seed-invoices.js'), 'seed-invoices');
  assert.ok((await dbx.prepare('SELECT COUNT(*) AS n FROM invoices').get()).n > 0);
});

test('cleanup-demo-data empties demo data and recreates the admin', S, async () => {
  const r = await node('server/cleanup-demo-data.js');
  ok(r, 'cleanup');
  assert.equal((await dbx.prepare('SELECT COUNT(*) AS n FROM customers').get()).n, 0);
  assert.equal((await dbx.prepare('SELECT COUNT(*) AS n FROM orders').get()).n, 0);
  const users = await dbx.prepare('SELECT email FROM users').all();
  assert.deepEqual(users.map((u) => u.email), ['admin@routeone.local']);
  assert.equal((await dbx.prepare('SELECT COUNT(*) AS n FROM roles').get()).n, 5);
  assert.match(r.out, /Temporary password/);
});
