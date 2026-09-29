// One-time setup: configure the Johannesburg branch's "orders" email
// recipients, per the list the user gave directly (2026-08-28).
//
// Run ON THE SERVER (writes to the live database; the Z: share is a network
// filesystem and SQLite explicitly warns against writing to a SQLite file
// over one - see handover-rep.js for the same rule applied there).
//
//     node server/seed-jhb-order-recipients.js --dry
//     node server/seed-jhb-order-recipients.js
//
// --dry prints the plan and writes nothing. Run it first.
//
// ---------------------------------------------------------------------------
// What this does
// ---------------------------------------------------------------------------
// The branch-scoped order-recipient feature (email_recipients.warehouse_id,
// the "Orders Email" card in Settings -> Email Settings, and
// GET /settings/order-email-info which the order/quote send screens use)
// already existed in the codebase before this script - this is a DATA change,
// not a feature build. Production only had 2 recipients configured at all
// (Charmaine Le Vey - orders, "every branch"; a technical test contact), so
// the Johannesburg list the user actually wants was simply never entered.
//
//   1. Charmaine Le Vey is moved from "every branch" (warehouse_id NULL) to
//      Johannesburg specifically, per the user's explicit answer ("No she
//      must be part of johannesburg only") - she previously would have shown
//      up on every branch's list, not just Johannesburg's.
//   2. The other 7 named people + the shared "Orders" inbox are added fresh,
//      all category 'orders', all scoped to Johannesburg.
//
// Idempotent / safe to re-run: an email that already exists in the table is
// left untouched and reported, not duplicated (email_recipients.email is
// UNIQUE, so a duplicate INSERT would fail anyway - this just makes re-runs
// clean instead of erroring out).
import { dbx } from './db.js';

const DRY = process.argv.includes('--dry');
const JHB_BRANCH_CODE = '01'; // JOHANNESBURG DESPATCH - looked up by code, not a hardcoded id,
                               // since warehouse ids are not guaranteed identical across environments

const jhb = await dbx.prepare('SELECT id, code, name FROM warehouses WHERE code = ?').get(JHB_BRANCH_CODE);
if (!jhb) {
  console.error(`\nNo warehouse with branch code ${JHB_BRANCH_CODE} found. Run the warehouse sync first.\n`);
  process.exit(1);
}

const CHARMAINE_EMAIL = 'charmaine.levey@sbakels.co.za';

const NEW_RECIPIENTS = [
  { name: 'Leon Stanger',        email: 'leon.stanger@sbakels.co.za' },
  { name: 'Phindile Mphahlele',  email: 'phindile.mphahlele@sbakels.co.za' },
  { name: 'Nathi Tshabalala',    email: 'nkosinathi.tshabalala@sbakels.co.za' },
  { name: 'Mapule Kgomokae',     email: 'mapule.kgomokae@sbakels.co.za' },
  { name: 'Lee Bobert',          email: 'lee.bobert@sbakels.co.za' },
  { name: 'Dawid Fourie',        email: 'dawid.fourie@sbakels.co.za' },
  { name: 'Petrus Delport',      email: 'pc.delport@sbakels.co.za' },
  { name: 'Orders',              email: 'orders@sbakels.co.za' },
];

console.log(`\n${DRY ? '[DRY RUN] ' : ''}Configuring Johannesburg (branch ${jhb.code} - ${jhb.name}) order-email recipients\n`);

const charmaine = await dbx.prepare('SELECT id, name, email, warehouse_id FROM email_recipients WHERE lower(email) = lower(?)').get(CHARMAINE_EMAIL);
if (charmaine) {
  if (charmaine.warehouse_id === jhb.id) {
    console.log(`  Charmaine Le Vey is already scoped to Johannesburg - nothing to change.`);
  } else {
    console.log(`  Charmaine Le Vey: every branch -> Johannesburg only`);
  }
} else {
  console.log(`  Charmaine Le Vey (${CHARMAINE_EMAIL}) not found in email_recipients - skipping that part, nothing to move.`);
}

const toInsert = [];
for (const r of NEW_RECIPIENTS) {
  const existing = await dbx.prepare('SELECT id, name, warehouse_id FROM email_recipients WHERE lower(email) = lower(?)').get(r.email);
  if (existing) {
    console.log(`  SKIP   ${r.name.padEnd(20)} ${r.email}  (already exists as "${existing.name}", id ${existing.id})`);
  } else {
    console.log(`  ADD    ${r.name.padEnd(20)} ${r.email}`);
    toInsert.push(r);
  }
}

console.log(`\n  ${toInsert.length} of ${NEW_RECIPIENTS.length} recipients will be added; ${NEW_RECIPIENTS.length - toInsert.length} already present.\n`);

if (DRY) {
  console.log('Dry run - nothing was written. Re-run without --dry to apply.\n');
  process.exit(0);
}

await dbx.transaction(async (tx) => {
  if (charmaine && charmaine.warehouse_id !== jhb.id) {
    await tx.prepare('UPDATE email_recipients SET warehouse_id = ? WHERE id = ?').run(jhb.id, charmaine.id);
  }
  const insert = tx.prepare(
    'INSERT INTO email_recipients (name, email, description, category, warehouse_id) VALUES (?, ?, NULL, ?, ?)'
  );
  for (const r of toInsert) await insert.run(r.name, r.email, 'orders', jhb.id);
});

console.log('Done.\n');
console.log('Check Settings -> Email Settings -> Orders Email to confirm the Johannesburg group.\n');
