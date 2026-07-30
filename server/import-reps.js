import 'dotenv/config'; // must run first - loads SECRET_KEY so the saved SYSPRO password decrypts
// One-off importer: creates `rep` user accounts from SYSPRO's vw_FS_Reps view.
//
// - Pulls reps live through the app's existing SYSPRO connection (same settings
//   the sync uses), so no CSV/paste is needed.
// - One account per distinct rep_code (a rep is one person). If a rep_code spans
//   several branches, their home branch is set to the one with the most
//   recently-invoiced customers; cross-branch customers are reconciled later via
//   the Integration page's "Match reps".
// - Email:    <firstname>@sbakels.co.za, falling back to <firstname>.<rep_code>
//             @sbakels.co.za on a clash (per the agreed rule).
// - Password: a unique random one-time password, printed once after import.
// - Re-runnable: any rep_code that already has a user is skipped, so running it
//   again only adds newcomers.
//
// Usage:  node server/import-reps.js          (create the accounts)
//         node server/import-reps.js --dry     (preview only, writes nothing)
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';
import { db } from './db.js';
import { sysproConfig } from './integration/providers.js';

const EMAIL_DOMAIN = 'sbakels.co.za';
const DRY_RUN = process.argv.includes('--dry');

// Rep codes that aren't real field reps - house accounts (H/ACC), non-commission
// / non-active buckets, legals/IBT/misc, and export/inter-company desks. These
// are skipped so we don't create logins for "LEGALS", "BOTSWANA", etc.
// (MAX and G&P were confirmed as real reps and are intentionally NOT here.)
export const EXCLUDE_CODES = new Set([
  '00',  // SBO IBT
  '08', '10', '35', '37', '39', '49', '75', '76',           // H/ACC house accounts
  '55', '77', '107', '109',                                  // non-comm / non-active buckets
  '78', '68', '81', '40',                                    // LEGALS, EXPORT MISC, MEL, Namibia Purchases
  '47', '50', '52', '54', '56', '57', '58', '62', '65', '67', '80', '86', '117' // export desks
]);

// First name -> email-safe slug. Falls back to rep<code> when there's no usable name.
function firstNameSlug(name, repCode) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const slug = first.toLowerCase().replace(/[^a-z0-9]/g, '');
  return slug || `rep${String(repCode).toLowerCase()}`;
}

export async function fetchReps() {
  const sql = (await import('mssql')).default;
  const cfg = sysproConfig();
  if (!cfg.host || !cfg.database || !cfg.user) {
    throw new Error('SYSPRO connection is not configured (Settings -> Integration).');
  }
  const pool = await sql.connect({
    server: cfg.host, port: cfg.port, database: cfg.database,
    user: cfg.user, password: cfg.password,
    options: { encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate },
    pool: { max: 2 }, connectionTimeout: 10000, requestTimeout: 60000
  });
  try {
    const r = await pool.request().query(
      'SELECT rep_code, rep_name, branch, active_customers FROM vw_FS_Reps'
    );
    return r.recordset;
  } finally {
    await pool.close();
  }
}

function run(reps) {
  const repRole = db.prepare("SELECT id FROM roles WHERE name = 'rep'").get();
  if (!repRole) throw new Error("No 'rep' role found - is the database seeded?");

  // Collapse to one entry per rep_code, keeping the branch with the most
  // recently-invoiced customers as their home branch.
  const byRep = new Map();
  for (const row of reps) {
    const code = String(row.rep_code || '').trim();
    if (!code) continue;
    if (EXCLUDE_CODES.has(code)) continue;
    const existing = byRep.get(code);
    if (!existing || (row.active_customers || 0) > (existing.active_customers || 0)) {
      byRep.set(code, {
        rep_code: code,
        rep_name: (row.rep_name || '').trim(),
        branch: (row.branch || '').trim(),
        active_customers: row.active_customers || 0
      });
    }
    // Preserve a name if the primary-branch row happened to be missing one.
    if (existing && !byRep.get(code).rep_name && row.rep_name) {
      byRep.get(code).rep_name = String(row.rep_name).trim();
    }
  }

  const findWarehouse = db.prepare('SELECT id FROM warehouses WHERE code = ?');
  const existsByRepCode = db.prepare('SELECT id FROM users WHERE rep_code = ?');
  const existsByEmail = db.prepare('SELECT id FROM users WHERE email = ?');
  const insertUser = db.prepare(`
    INSERT INTO users (name, email, password_hash, role_id, rep_code, warehouse_id, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);

  const created = [];
  const skipped = [];

  const tx = db.transaction(() => {
    for (const rep of byRep.values()) {
      if (existsByRepCode.get(rep.rep_code)) {
        skipped.push({ ...rep, reason: 'rep_code already has a user' });
        continue;
      }

      // Email: firstname@domain, else firstname.repcode@domain on a clash.
      const slug = firstNameSlug(rep.rep_name, rep.rep_code);
      let email = `${slug}@${EMAIL_DOMAIN}`;
      if (existsByEmail.get(email)) {
        email = `${slug}.${rep.rep_code.toLowerCase()}@${EMAIL_DOMAIN}`;
      }
      if (existsByEmail.get(email)) {
        skipped.push({ ...rep, reason: `email ${email} already taken` });
        continue;
      }

      const warehouse = rep.branch ? findWarehouse.get(rep.branch) : null;
      const name = rep.rep_name || `Rep ${rep.rep_code}`;

      const temporaryPassword = `${crypto.randomBytes(12).toString('base64url')}aA1!`;
      if (!DRY_RUN) {
        insertUser.run(name, email, bcrypt.hashSync(temporaryPassword, 12), repRole.id, rep.rep_code, warehouse?.id ?? null);
      }
      created.push({
        name, email, rep_code: rep.rep_code, branch: rep.branch,
        temporary_password: temporaryPassword,
        warehouse_matched: warehouse ? 'yes' : 'NO (branch not in warehouses)',
        active_customers: rep.active_customers
      });
    }
  });
  tx();

  return { created, skipped };
}

// Only run the import when this file is executed directly - other scripts import
// EXCLUDE_CODES and fetchReps from here for diagnostics (same guard as index.js).
const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) (async () => {
  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Importing reps from SYSPRO vw_FS_Reps...\n`);
  const reps = await fetchReps();
  console.log(`Fetched ${reps.length} rep/branch rows from SYSPRO.`);
  const { created, skipped } = run(reps);

  console.log(`\n${DRY_RUN ? 'Would create' : 'Created'} ${created.length} rep account(s):`);
  console.table(created);

  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    console.table(skipped.map((s) => ({ rep_code: s.rep_code, name: s.rep_name, reason: s.reason })));
  }

  const noWarehouse = created.filter((c) => c.warehouse_matched.startsWith('NO'));
  if (noWarehouse.length) {
    console.log(`\n⚠ ${noWarehouse.length} rep(s) have a branch with no matching warehouse - run the warehouse sync first, or set their branch in Users afterwards.`);
  }

  console.log(`\n${DRY_RUN ? 'Dry run complete - nothing was written.' : '✅ Import complete.'}\n`);
  process.exit(0);
})().catch((e) => {
  console.error('Import failed:', e.message);
  process.exit(1);
});
