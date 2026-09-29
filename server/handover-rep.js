// Hand a SYSPRO rep code from a departing rep to their replacement.
//
// Run ON THE SERVER (the live database is local disk there; writing to it over
// the Z: share would be SQLite over SMB, which is not safe).
//
//     node server/handover-rep.js --code 111 --branch 01 --name "Bernice Molokwe" --email bernice@sbakels.co.za --dry
//     node server/handover-rep.js --code 111 --branch 01 --name "Bernice Molokwe" --email bernice@sbakels.co.za
//
// --dry prints the plan and writes nothing. Run it first.
//
// ---------------------------------------------------------------------------
// Why a new user rather than renaming the old one
// ---------------------------------------------------------------------------
// Renaming would be fewer steps, but it silently rewrites history: every visit,
// order and quote the departing rep recorded would show the new rep's name, and
// their login would become the new rep's login. Creating a separate user keeps
// each person's own work attributable to them.
//
// The customers move regardless, and without any manual reassignment:
// matchRep() in server/integration/sync.js resolves a customer's SYSPRO
// salesperson to a RouteOne user on branch + rep_code, and the customer sync
// re-applies that every run. So clearing the outgoing rep's code and giving it
// to the incoming one is what actually transfers the book.
//
// The outgoing rep is deactivated, not deleted - they own orders, visits and
// quotes, and a delete would either fail on the foreign keys or destroy that
// history. Their record stays readable.
//
// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
// - refuses unless exactly one user holds that code AT THAT BRANCH (--branch is
//   required; a rep code is not unique across branches)
// - refuses if the email is already in use
// - refuses if the branch has no matching warehouse
// - single transaction: either the whole handover applies, or none of it
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { dbx } from './db.js';

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};
const DRY = process.argv.includes('--dry');

const code = (arg('--code') || '').trim();
const branch = (arg('--branch') || '').trim();
const newName = (arg('--name') || '').trim();
const newEmail = (arg('--email') || '').trim().toLowerCase();

if (!code || !branch || !newName || !newEmail) {
  console.error('\nUsage: node server/handover-rep.js --code 111 --branch 01 --name "Bernice Molokwe" --email bernice@sbakels.co.za [--dry]\n');
  console.error('--branch is required: a rep code is not unique across branches.\n');
  process.exit(1);
}

// A rep code is NOT unique. Code 101 is Siyabonga Sigwili at branch 01 and
// Joseph Shabangu at branch 12 - two different people. matchRep() resolves on
// the (branch, code) pair, so the handover is scoped to that pair. An earlier
// version guarded on the code alone and would have refused to touch any
// multi-branch code, or worse, picked the wrong person's record.
const warehouse = await dbx.prepare('SELECT id, code, name FROM warehouses WHERE code = ?').get(branch);
if (!warehouse) {
  console.error(`\nNo warehouse with branch code ${branch}. Run the warehouse sync first.\n`);
  process.exit(1);
}

const holders = await dbx.prepare(`
  SELECT u.id, u.name, u.email, TRIM(u.rep_code) AS rep_code, u.active,
         u.warehouse_id, w.code AS branch, w.name AS branch_name, u.role_id, u.sales_target
  FROM users u
  LEFT JOIN warehouses w ON w.id = u.warehouse_id
  WHERE TRIM(u.rep_code) = ? AND u.warehouse_id = ?
`).all(code, warehouse.id);

if (holders.length !== 1) {
  console.error(`\nExpected exactly one user on rep code ${code} at branch ${branch}, found ${holders.length}.`);
  holders.forEach((h) => console.error(`  id ${h.id}  ${h.name}  active=${h.active}`));
  if (!holders.length) {
    const elsewhere = await dbx.prepare(`
      SELECT u.name, w.code AS branch FROM users u LEFT JOIN warehouses w ON w.id = u.warehouse_id
      WHERE TRIM(u.rep_code) = ?
    `).all(code);
    if (elsewhere.length) {
      console.error('  that code exists at: ' + elsewhere.map((e) => `${e.branch || '(no branch)'} = ${e.name}`).join(' | '));
    }
    console.error('  If the incoming rep is NEW at this branch rather than replacing someone,');
    console.error('  add them in Settings -> Users instead - there is nobody to hand over from.');
  }
  console.error('');
  process.exit(1);
}
const outgoing = holders[0];

if (await dbx.prepare('SELECT id FROM users WHERE lower(email) = ?').get(newEmail)) {
  console.error(`\nEmail ${newEmail} is already in use. Pick another.\n`);
  process.exit(1);
}

const customers = (await dbx.prepare('SELECT COUNT(*) AS n FROM customers WHERE rep_id = ?').get(outgoing.id)).n;
const owned = [];
for (const t of ['orders', 'visits', 'quotes']) {
  owned.push({ table: t, n: (await dbx.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE rep_id = ?`).get(outgoing.id)).n });
}

console.log(`\n${DRY ? '[DRY RUN] ' : ''}Handover of rep code ${code} (branch ${outgoing.branch} - ${outgoing.branch_name})\n`);
console.log(`  OUT  ${outgoing.name}  <${outgoing.email}>  (user id ${outgoing.id})`);
console.log(`         -> rep_code cleared, account deactivated`);
console.log(`         -> keeps ${owned.map((o) => `${o.n} ${o.table}`).join(', ')}`);
console.log(`  IN   ${newName}  <${newEmail}>`);
console.log(`         -> rep_code ${code}, branch ${outgoing.branch}, must change password on first sign-in`);
console.log(`\n  ${customers} customers currently on the outgoing rep move across on the next customer sync.\n`);

if (DRY) {
  console.log('Dry run - nothing was written. Re-run without --dry to apply.\n');
  process.exit(0);
}

const tempPassword = `${crypto.randomBytes(12).toString('base64url')}aA1!`;
const newId = await dbx.transaction(async (tx) => {
  // Clear the code BEFORE inserting, so the two never coexist on one code.
  await tx.prepare('UPDATE users SET rep_code = NULL, active = 0 WHERE id = ?').run(outgoing.id);
  const info = await tx.prepare(`
    INSERT INTO users (name, email, password_hash, role_id, rep_code, warehouse_id, sales_target, active, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
  `).run(newName, newEmail, bcrypt.hashSync(tempPassword, 12), outgoing.role_id, code, outgoing.warehouse_id, outgoing.sales_target || 0);
  return info.lastInsertRowid;
});

console.log('Done.\n');
console.log(`  ${newName} created as user id ${newId}`);
console.log(`  login    : ${newEmail}`);
console.log(`  password : ${tempPassword}`);
console.log(`  (one-time - they must change it at first sign-in)\n`);
console.log('NEXT: sync customers from the Integration page so the book moves across.\n');
