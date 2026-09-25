// One-off: set one rep's Jan-Dec monthly budgets, found by rep code.
// Run on the server:  node C:\RouteOne\server\set-rep-budgets.cjs
// Optional branch filter if the code exists in several branches:
//   node C:\RouteOne\server\set-rep-budgets.cjs 01
// Prints the matching user(s) and the budgets before and after. Delete when done.
const path = require('path');
const D = require('better-sqlite3');

const REP_CODE = '111';
const BUDGETS = {
  1: 2443277, 2: 2584548, 3: 3008361, 4: 3290904, 5: 2867090, 6: 3008361,
  7: 3290904, 8: 2867090, 9: 3149633, 10: 3432175, 11: 3432175, 12: 3290904
};

const branch = process.argv[2] || null; // warehouse code, e.g. 01
const db = new D(process.env.DB_PATH || path.join(__dirname, 'data', 'fieldsales.db'));

const reps = db.prepare(`
  SELECT u.id, u.name, u.rep_code, w.code AS branch
  FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN warehouses w ON w.id = u.warehouse_id
  WHERE r.name = 'rep' AND u.active = 1 AND u.rep_code = ? AND (? IS NULL OR w.code = ?)
`).all(REP_CODE, branch, branch);
console.log('Matching reps:', reps);
if (reps.length !== 1) {
  console.error(`Expected exactly one active rep with code ${REP_CODE}${branch ? ` in branch ${branch}` : ''}, found ${reps.length}. Nothing changed.`);
  process.exit(1);
}
const rep = reps[0];
const show = () => db.prepare('SELECT month, budget FROM rep_budgets WHERE rep_id = ? ORDER BY month').all(rep.id);
console.log('Before:', show());

const upsert = db.prepare(`
  INSERT INTO rep_budgets (rep_id, month, budget) VALUES (?, ?, ?)
  ON CONFLICT(rep_id, month) DO UPDATE SET budget = excluded.budget, updated_at = datetime('now')
`);
db.transaction(() => {
  for (const [month, budget] of Object.entries(BUDGETS)) upsert.run(rep.id, Number(month), budget);
})();

const after = show();
console.log('After:', after);
console.log(`Jan-Sep total: ${after.filter((r) => r.month <= 9).reduce((s, r) => s + r.budget, 0)}`);
db.close();
