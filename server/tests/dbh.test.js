import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routeone-dbh-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
const { dbx, closeDb } = await import('../db.js');
const { resetBackend } = await import('./backend.js');
await resetBackend(dbx);
const h = await import('../dbh.js');

after(() => { closeDb(); fs.rmSync(tempDir, { recursive: true, force: true }); });

test('setSetting upserts and getSetting reads it back', async () => {
  assert.equal(await h.getSetting('t_missing', 'fb'), 'fb');
  await h.setSetting('t_k', 1);
  await h.setSetting('t_k', 2);
  assert.equal(await h.getSetting('t_k'), '2');
  assert.equal((await dbx.prepare('SELECT COUNT(*) AS n FROM settings WHERE [key] = ?').get('t_k')).n, 1);
});

test('nextNumber is sequential and gives concurrent callers distinct numbers', async () => {
  assert.equal(await h.nextNumber('TST'), 'TST-00001');
  assert.equal(await h.nextNumber('TST'), 'TST-00002');
  const many = await Promise.all(Array.from({ length: 20 }, () => h.nextNumber('TST')));
  assert.equal(new Set(many).size, 20);
  assert.equal(await h.getSetting('counter_TST'), '22');
});

test('helpers join a caller transaction and roll back with it', async () => {
  await assert.rejects(dbx.transaction(async (tx) => {
    await h.nextNumber('TX', tx);
    await h.logActivity(null, 'test', 'thing', 1, { a: 1 }, tx);
    throw new Error('boom');
  }), /boom/);
  assert.equal(await h.getSetting('counter_TX'), null);
  assert.equal((await dbx.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'test'").get()).n, 0);
});

test('repMonthTarget prefers the monthly budget over the flat target', async () => {
  const role = { id: (await dbx.prepare("INSERT INTO roles (name) VALUES ('t_role')").run()).lastInsertRowid };
  const u = await dbx.prepare("INSERT INTO users (name, email, password_hash, role_id, sales_target) VALUES ('T','t@x.co','x',?,500)").run(role.id);
  assert.equal(await h.repMonthTarget(u.lastInsertRowid, 3), 500);
  await dbx.prepare('INSERT INTO rep_budgets (rep_id, month, budget) VALUES (?, 3, 900)').run(u.lastInsertRowid);
  assert.equal(await h.repMonthTarget(u.lastInsertRowid, 3), 900);
});
