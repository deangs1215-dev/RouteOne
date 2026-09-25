// One-time cleanup: lower-case every existing email_recipients.email.
//
// Run ON THE SERVER (writes to the live database; see handover-rep.js for why
// the Z: share is never used for a write).
//
//     node server/lowercase-email-recipients.js --dry
//     node server/lowercase-email-recipients.js
//
// Going forward, settings.routes.js's create/update endpoints now lower-case
// on the way in, so this is a one-time pass over rows that predate that fix
// (Charmaine Le Vey plus the 8 Johannesburg recipients added directly by
// script, all of which had SBakels.co.za mixed-case in the domain).
//
// Idempotent: an already-lowercase email is simply skipped.
import { dbx } from './db.js';

const DRY = process.argv.includes('--dry');

const rows = await dbx.prepare('SELECT id, name, email FROM email_recipients').all();
const changed = rows.filter((r) => r.email !== r.email.toLowerCase());

console.log(`\n${DRY ? '[DRY RUN] ' : ''}${changed.length} of ${rows.length} email_recipients need lower-casing\n`);
for (const r of changed) console.log(`  ${r.name.padEnd(20)} ${r.email}  ->  ${r.email.toLowerCase()}`);

if (!changed.length) {
  console.log('\nNothing to do.\n');
  process.exit(0);
}
if (DRY) {
  console.log('\nDry run - nothing was written. Re-run without --dry to apply.\n');
  process.exit(0);
}

await dbx.transaction(async (tx) => {
  const update = tx.prepare('UPDATE email_recipients SET email = ? WHERE id = ?');
  for (const r of changed) await update.run(r.email.toLowerCase(), r.id);
});

console.log('\nDone.\n');
