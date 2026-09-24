import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSqliteDbx, toNamedParams } from '../dbx.js';

test('toNamedParams rewrites ? and skips string literals', () => {
  assert.deepEqual(toNamedParams("SELECT * FROM t WHERE a = ? AND b = '?' AND c = ?"), {
    sql: "SELECT * FROM t WHERE a = @p0 AND b = '?' AND c = @p1",
    count: 2
  });
  assert.equal(toNamedParams("SELECT 'it''s ?', ?").sql, "SELECT 'it''s ?', @p0");
});

test('sqlite dbx: get/all/run and lastInsertRowid', async () => {
  const dbx = createSqliteDbx(new Database(':memory:'));
  await dbx.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
  const r = await dbx.prepare('INSERT INTO t (v) VALUES (?)').run('a');
  assert.equal(Number(r.lastInsertRowid), 1);
  assert.equal(r.changes, 1);
  assert.deepEqual(await dbx.prepare('SELECT v FROM t WHERE id = ?').get(1), { v: 'a' });
  assert.equal(await dbx.prepare('SELECT v FROM t WHERE id = ?').get(99), undefined);
  assert.equal((await dbx.prepare('SELECT v FROM t').all()).length, 1);
});

test('sqlite dbx: transaction commits, rolls back on throw, and serializes', async () => {
  const dbx = createSqliteDbx(new Database(':memory:'));
  await dbx.exec('CREATE TABLE t (v INTEGER)');
  await dbx.transaction(async (tx) => { await tx.prepare('INSERT INTO t VALUES (?)').run(1); });
  await assert.rejects(dbx.transaction(async (tx) => {
    await tx.prepare('INSERT INTO t VALUES (?)').run(2);
    throw new Error('boom');
  }), /boom/);
  // Two overlapping transactions must not interleave BEGINs.
  await Promise.all([1, 2, 3].map((n) => dbx.transaction(async (tx) => {
    await new Promise((r) => setTimeout(r, 5));
    await tx.prepare('INSERT INTO t VALUES (?)').run(10 + n);
  })));
  const rows = await dbx.prepare('SELECT v FROM t ORDER BY v').all();
  assert.deepEqual(rows.map((r) => r.v), [1, 11, 12, 13]);
});

test('toNamedParams ignores ? and quotes inside comments', () => {
  const r = toNamedParams("SELECT a -- what's this? \n FROM t /* still ? 'open */ WHERE x = ? AND y = ?");
  assert.equal(r.count, 2);
  assert.equal(r.sql, "SELECT a -- what's this? \n FROM t /* still ? 'open */ WHERE x = @p0 AND y = @p1");
});
