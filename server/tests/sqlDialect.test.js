import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteToTsql } from '../sqlDialect.js';

const cases = [
  ["SELECT date('now')", "SELECT CONVERT(VARCHAR(10), SYSUTCDATETIME(), 23)"],
  ["WHERE d >= date('now', '-30 days')", "WHERE d >= CONVERT(VARCHAR(10), DATEADD(day, -30, SYSUTCDATETIME()), 23)"],
  ["date('now', '-1 day')", "CONVERT(VARCHAR(10), DATEADD(day, -1, SYSUTCDATETIME()), 23)"],
  ["date('now', 'start of month')", "CONVERT(VARCHAR(10), DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1), 23)"],
  ["date('now', 'start of year')", "CONVERT(VARCHAR(10), DATEFROMPARTS(YEAR(SYSUTCDATETIME()), 1, 1), 23)"],
  ["date('now', 'start of month', '-11 months')",
    "CONVERT(VARCHAR(10), DATEADD(month, -11, DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1)), 23)"],
  ["date(v.planned_date) = ?", "CONVERT(VARCHAR(10), v.planned_date, 23) = ?"],
  ["updated_at = datetime('now')", "updated_at = SYSUTCDATETIME()"],
  ["created_at >= datetime('now', '-5 days')", "created_at >= DATEADD(day, -5, SYSUTCDATETIME())"],
  ["strftime('%Y-%m', order_date)", "CONVERT(VARCHAR(7), order_date, 23)"],
  ["strftime('%Y-%m', date('now'))", "CONVERT(VARCHAR(7), CONVERT(VARCHAR(10), SYSUTCDATETIME(), 23), 23)"],
  ["strftime('%Y-%m', 'now')", "CONVERT(VARCHAR(7), SYSUTCDATETIME(), 23)"],
  ["strftime('%Y-01', 'now')", "(CONVERT(VARCHAR(4), SYSUTCDATETIME(), 23) + '-01')"],
  ["SELECT * FROM t ORDER BY id DESC LIMIT 10", "SELECT TOP (10) * FROM t ORDER BY id DESC"],
  ["SELECT DISTINCT a FROM t LIMIT 5", "SELECT DISTINCT TOP (5) a FROM t"],
  ["SELECT a, (SELECT x FROM u WHERE u.a = t.a ORDER BY y LIMIT 1) AS f FROM t ORDER BY a LIMIT 20",
    "SELECT TOP (20) a, (SELECT TOP (1) x FROM u WHERE u.a = t.a ORDER BY y) AS f FROM t ORDER BY a"],
  ["WHERE id IN (SELECT id FROM l WHERE u = ? ORDER BY r DESC LIMIT 50)", "WHERE id IN (SELECT TOP (50) id FROM l WHERE u = ? ORDER BY r DESC)"],
  // things that must be left alone
  ["SELECT 'date(x) LIMIT 5', ? FROM t", "SELECT 'date(x) LIMIT 5', ? FROM t"],
  ["SELECT SYSUTCDATETIME(), update_date(x), a.date(y) FROM t", "SELECT SYSUTCDATETIME(), update_date(x), a.date(y) FROM t"],
  ["SELECT * FROM t WHERE it's_not = 1", null] // unterminated literal must throw
];

for (const [input, expected] of cases) {
  test(`sqliteToTsql: ${input.slice(0, 70)}`, () => {
    if (expected === null) assert.throws(() => sqliteToTsql(input), /unterminated/);
    else assert.equal(sqliteToTsql(input), expected);
  });
}

test('sqliteToTsql refuses forms it cannot translate faithfully', () => {
  assert.throws(() => sqliteToTsql("SELECT date('now', ?)"), /bound modifier/);
  assert.throws(() => sqliteToTsql("SELECT date('now', 'weekday 1')"), /unsupported/);
  assert.throws(() => sqliteToTsql("SELECT strftime('%W', x)"), /unsupported strftime/);
  assert.throws(() => sqliteToTsql("SELECT * FROM t LIMIT ?"), /numeric literal/);
  assert.throws(() => sqliteToTsql("SELECT a FROM t UNION SELECT b FROM u LIMIT 3"), /UNION/);
  assert.throws(() => sqliteToTsql("SELECT datetime(x)"), /datetime\('now'/);
});
