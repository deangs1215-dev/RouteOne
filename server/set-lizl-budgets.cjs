// One-off: set Lizl's Jan-Dec monthly budgets. Run on the server:
//   node C:\RouteOne\server\set-lizl-budgets.cjs
// Prints her budgets before and after. Delete this file when done.
const path = require('path');
const D = require('better-sqlite3');

const BUDGETS = {
  1: 2052133, 2: 2170891, 3: 2527165, 4: 2764680, 5: 2408407, 6: 2527165,
  7: 2764680, 8: 2408407, 9: 2645923, 10: 2883438, 11: 2883438, 12: 2764680
};

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'fieldsales.db');
const db = new D(dbPath);

const reps = db.prepare("SELECT id, name FROM users WHERE name = ? AND active = 1").all('Lizl');
if (reps.length !== 1) {
  console.error(`Expected exactly one active user named Lizl, found ${reps.length}. Nothing changed.`);
  process.exit(1);
}
const rep = reps[0];
const show = () => db.prepare('SELECT month, budget FROM rep_budgets WHERE rep_id = ? ORDER BY month').all(rep.id);

console.log(`Lizl = user id ${rep.id}`);
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
const ytd = after.filter((r) => r.month <= 9).reduce((s, r) => s + r.budget, 0);
console.log(`Jan-Sep total: ${ytd} (expected 22269451)`);
db.close();
