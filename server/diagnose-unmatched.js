import 'dotenv/config'; // must run first - loads SECRET_KEY so the saved SYSPRO password decrypts
// Read-only diagnostic: explains why customers are left unassigned by
// "Match reps" on the Integration page.
//
// matchRep() requires BOTH the rep code and the branch to agree, but a rep has
// a single home warehouse - so an unmatched customer is one of:
//
//   NO_REP_CODE     the SYSPRO row has no rep_code or no warehouse_code
//   NO_SUCH_REP     no active rep user carries that rep_code (house accounts and
//                   export desks are deliberately excluded by import-reps.js, so
//                   these are expected)
//   BRANCH_MISMATCH a rep with that code exists, but their home branch differs
//                   from the customer's branch - these are the recoverable ones
//
// Writes nothing. Usage:  node server/diagnose-unmatched.js

import { dbx } from './db.js';
import { getProvider } from './integration/providers.js';

const rows = await (await getProvider()).fetch('customers');
console.log(`Fetched ${rows.length} customer rows from the configured source.\n`);

const findCustomer = dbx.prepare('SELECT id, rep_id FROM customers WHERE code = ?');
const repsByCode = await dbx.prepare(`
  SELECT u.rep_code, w.code AS branch
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN warehouses w ON w.id = u.warehouse_id
  WHERE r.name = 'rep' AND u.active = 1
`).all();

const homeBranch = new Map();
for (const rep of repsByCode) {
  if (!homeBranch.has(rep.rep_code)) homeBranch.set(rep.rep_code, []);
  homeBranch.get(rep.rep_code).push(rep.branch);
}

const buckets = { NO_REP_CODE: 0, NO_SUCH_REP: 0, BRANCH_MISMATCH: 0 };
const noSuchRep = new Map();     // rep_code -> customer count
const branchMismatch = new Map(); // "repcode: customerBranch -> repBranch" -> count
let notInDb = 0, alreadyAssigned = 0;

for (const row of rows) {
  const customer = await findCustomer.get(row.code);
  if (!customer) { notInDb++; continue; }
  if (customer.rep_id) { alreadyAssigned++; continue; }

  const repCode = String(row.rep_code || '').trim();
  const branch = String(row.warehouse_code || '').trim();

  if (!repCode || !branch) {
    buckets.NO_REP_CODE++;
    continue;
  }

  const repBranches = homeBranch.get(repCode);
  if (!repBranches) {
    buckets.NO_SUCH_REP++;
    noSuchRep.set(repCode, (noSuchRep.get(repCode) || 0) + 1);
    continue;
  }

  buckets.BRANCH_MISMATCH++;
  const key = `${repCode}: customer in ${branch}, rep home ${repBranches.join('/') || '(none)'}`;
  branchMismatch.set(key, (branchMismatch.get(key) || 0) + 1);
}

console.log(`Already assigned: ${alreadyAssigned}`);
console.log(`In SYSPRO but not in the local customers table: ${notInDb}\n`);

console.log('Unassigned, by reason:');
console.table(buckets);

if (noSuchRep.size) {
  console.log('\nNO_SUCH_REP - rep codes with no active user (expected for house/export codes):');
  console.table([...noSuchRep.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([rep_code, customers]) => ({ rep_code, customers })));
}

if (branchMismatch.size) {
  console.log('\nBRANCH_MISMATCH - rep exists but works a different home branch:');
  console.table([...branchMismatch.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([detail, customers]) => ({ detail, customers })));
}

process.exit(0);
