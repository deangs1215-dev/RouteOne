import 'dotenv/config'; // must run first - loads SECRET_KEY so the saved SYSPRO password decrypts
// Read-only report: rep codes that own customers but have no RouteOne login and
// were never deliberately excluded by import-reps.js.
//
// These are the customers that will stay unassigned forever - the sync only
// auto-assigns customers it can match, and "Match reps" can't place them either.
// Each code gets a verdict based on whether it appears in vw_FS_Reps:
//
//   IN VIEW      the rep exists in vw_FS_Reps but has no account - re-running
//                import-reps.js would create one (it skips codes that already
//                have a user, so it is safe to re-run)
//   NOT IN VIEW  SYSPRO customers reference this code but the reps view does not
//                list it - either a closed/former rep, or the DBA view filters
//                them out. Needs a decision: add to the view, add to
//                EXCLUDE_CODES, or assign those customers by hand.
//
// Writes nothing. Usage:  node server/list-orphan-reps.js

import { db } from './db.js';
import { getProvider } from './integration/providers.js';
import { EXCLUDE_CODES, fetchReps } from './import-reps.js';

const customers = await getProvider().fetch('customers');

let repRows = [];
try {
  repRows = await fetchReps();
} catch (e) {
  console.warn(`Could not read vw_FS_Reps (${e.message}) - continuing without the IN VIEW column.\n`);
}
const viewByCode = new Map();
for (const r of repRows) {
  const code = String(r.rep_code || '').trim();
  if (code && !viewByCode.has(code)) viewByCode.set(code, String(r.rep_name || '').trim());
}

const usersByCode = new Set(db.prepare(`
  SELECT u.rep_code FROM users u
  JOIN roles r ON r.id = u.role_id
  WHERE r.name = 'rep' AND u.active = 1 AND u.rep_code IS NOT NULL
`).all().map((u) => u.rep_code));

const findCustomer = db.prepare('SELECT id, rep_id, status FROM customers WHERE code = ?');

// RouteOne only models active / on_hold / closed, and 'closed' is set by hand in
// the app - it never arrives from SYSPRO. So if the view carries its own
// discontinued/inactive flag, it is being dropped on the floor. Show what the
// view actually returns so that can be checked.
if (customers.length) {
  console.log('Columns available on the SYSPRO customers view:');
  console.log(`  ${Object.keys(customers[0]).join(', ')}\n`);
}

// rep_code -> { customers, branches:Set, examples:[], status:{} }
const orphans = new Map();
const statusTotals = {};

for (const row of customers) {
  const local = findCustomer.get(row.code);
  if (!local || local.rep_id) continue;              // only currently-unassigned

  const repCode = String(row.rep_code || '').trim();
  const branch = String(row.warehouse_code || '').trim();
  if (!repCode) continue;
  if (usersByCode.has(repCode)) continue;            // has a user - branch mismatch, not an orphan
  if (EXCLUDE_CODES.has(repCode)) continue;          // deliberately excluded - expected

  if (!orphans.has(repCode)) {
    orphans.set(repCode, { customers: 0, branches: new Set(), examples: [], status: {} });
  }
  const entry = orphans.get(repCode);
  entry.customers++;
  if (branch) entry.branches.add(branch);
  if (entry.examples.length < 3) entry.examples.push(`${row.code} ${row.name || ''}`.trim());

  const status = local.status || 'unknown';
  entry.status[status] = (entry.status[status] || 0) + 1;
  statusTotals[status] = (statusTotals[status] || 0) + 1;
}

const rows = [...orphans.entries()]
  .sort((a, b) => b[1].customers - a[1].customers)
  .map(([rep_code, e]) => ({
    rep_code,
    customers: e.customers,
    active: e.status.active || 0,
    on_hold: e.status.on_hold || 0,
    closed: e.status.closed || 0,
    branches: [...e.branches].sort().join(', '),
    in_vw_FS_Reps: viewByCode.has(rep_code) ? `yes - ${viewByCode.get(rep_code)}` : 'NO',
    example_customers: e.examples.join(' | ')
  }));

const total = rows.reduce((sum, r) => sum + r.customers, 0);

console.log(`\n${rows.length} rep code(s) own ${total} unassigned customer(s) but have no login`);
console.log(`and are not in EXCLUDE_CODES.\n`);
console.table(rows);

console.log('\nThose same customers by status:');
console.table(statusTotals);
const live = (statusTotals.active || 0);
console.log(`\n${live} of the ${total} are 'active' - only those actually need a rep.`);
console.log(`'on_hold' comes from the view's on_hold flag; 'closed' is only ever set by hand in the app.\n`);

const inView = rows.filter((r) => r.in_vw_FS_Reps !== 'NO');
if (inView.length) {
  console.log(`\n${inView.length} of these ARE in vw_FS_Reps - re-running import-reps.js would`);
  console.log(`create their accounts (${inView.reduce((s, r) => s + r.customers, 0)} customers would become assignable):`);
  console.log(`  ${inView.map((r) => r.rep_code).join(', ')}\n`);
}

process.exit(0);
