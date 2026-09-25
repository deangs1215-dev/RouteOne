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
// Usage:  node server/import-reps.js               (create the accounts)
//         node server/import-reps.js --dry         (preview only, writes nothing)
//         node server/import-reps.js --only 81     (limit to specific rep codes)
//         node server/import-reps.js --only 81,25  (comma-separated, no spaces)
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';
import { dbx } from './db.js';
import { sysproConfig } from './integration/providers.js';

const EMAIL_DOMAIN = 'sbakels.co.za';
const DRY_RUN = process.argv.includes('--dry');

// --only limits the run to specific rep codes. vw_FS_Reps exposes every
// salesperson record, most of which are countries, export desks and house
// accounts rather than people, so onboarding one rep should not mean adding
// dozens of codes to EXCLUDE_CODES first. Accepts "--only 81" or "--only=81",
// comma-separated for several.
function parseOnlyCodes() {
  const argv = process.argv;
  const flagIndex = argv.indexOf('--only');
  let raw = flagIndex !== -1 ? argv[flagIndex + 1] : null;
  if (!raw) {
    const inline = argv.find((a) => a.startsWith('--only='));
    if (inline) raw = inline.slice('--only='.length);
  }
  if (!raw || raw.startsWith('--')) return null;
  const codes = raw.split(',').map((c) => c.trim()).filter(Boolean);
  return codes.length ? new Set(codes) : null;
}
const ONLY_CODES = parseOnlyCodes();

// The real field reps, by SYSPRO salesperson code. This is an ALLOW list, not a
// block list, and that direction is deliberate.
//
// vw_FS_Reps returns every salesperson record - countries, export desks, house
// accounts, write-off buckets, driver codes. Roughly 85 of them. The old block
// list had to enumerate all of that, and anything it missed silently became a
// real login: a dry run on 2026-08-13 wanted to create accounts for "ANGOLA",
// "LEGALS WRITE-OFF" and "SHOPRITE CT", among others. An allow list fails the
// safe way instead - an unknown code produces no account at all.
//
// Source: the business's live-rep report (2026-08-13), which excludes the
// export/country reps. Cross-checked against RouteOne: 41 codes already had
// users, and 4 did not (48, 81, 94, 123). Of those, 48 "Valerie" is a former
// employee and is deliberately left out, so 3 accounts remain to be created.
//
// WHEN A REP JOINS OR LEAVES, EDIT THIS LIST. A new SYSPRO code will not get a
// login until it is added here - that is intended. Use --only to onboard one
// person without touching everyone else.
export const REP_CODES = new Set([
  '06',   // Milton K
  '07',   // Sergio
  '09',   // Leonard Shabangu
  '101',  // Joseph Shabangu / Siyabonga Sigwili - two people share this code
  '102',  // Barry Selby
  '104',  // Lizzy
  '110',  // Mathew Tyapa
  '111',  // Nasief Isaac / Bernice Molokwe - two people share this code
  '113',  // David Mamokabe
  '114',  // Thandile Susela
  '12',   // Themba
  '120',  // Ashil Singh
  '121',  // Jonathan
  '122',  // Ruben De Waal
  '123',  // Vallerie Klue
  '126',  // John Booi
  '131',  // Jeremy Calitz
  '133',  // Duncan Sadie
  '134',  // Wilhelmien Nel
  '15',   // Lebogang
  '16',   // Lizl
  '17',   // Xolani
  '18',   // Dawie
  '21',   // Trevor
  '22',   // Terence
  '24',   // Ash
  '26',   // Jomo
  '27',   // Tefo
  '28',   // Charles
  '29',   // Siyanda
  '31',   // Marco
  '32',   // Sandile
  '33',   // Phillip M
  '34',   // Quintin
  '36',   // Nolo
  '42',   // Graham
  '59',   // Bernadette
  '81',   // James - was wrongly filed as the "MEL" bucket until 2026-08-13
  '87',   // MAX
  '90',   // Raymond
  '93',   // Ronicah
  '94',   // Bongani
  '97',   // Nathan Cupido
  'G&P'   // GROBBIE & PIETER
]);

// First name -> email-safe slug. Falls back to rep<code> when there's no usable name.
function firstNameSlug(name, repCode) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const slug = first.toLowerCase().replace(/[^a-z0-9]/g, '');
  return slug || `rep${String(repCode).toLowerCase()}`;
}

export async function fetchReps() {
  const sql = (await import('mssql')).default;
  const cfg = await sysproConfig();
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

// Exported alongside EXCLUDE_CODES/fetchReps so the collapse, exclusion and
// --only filtering can be exercised against synthetic rows without a live
// SYSPRO connection.
export async function run(reps) {
  const repRole = await dbx.prepare("SELECT id FROM roles WHERE name = 'rep'").get();
  if (!repRole) throw new Error("No 'rep' role found - is the database seeded?");

  // Collapse to one entry per rep_code, keeping the branch with the most
  // recently-invoiced customers as their home branch.
  const byRep = new Map();
  for (const row of reps) {
    const code = String(row.rep_code || '').trim();
    if (!code) continue;
    if (!REP_CODES.has(code)) continue;
    if (ONLY_CODES && !ONLY_CODES.has(code)) continue;
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

  const created = [];
  const skipped = [];

  await dbx.transaction(async (tx) => {
    const findWarehouse = tx.prepare('SELECT id FROM warehouses WHERE code = ?');
    const existsByRepCode = tx.prepare('SELECT id FROM users WHERE rep_code = ?');
    const existsByEmail = tx.prepare('SELECT id FROM users WHERE email = ?');
    const insertUser = tx.prepare(`
      INSERT INTO users (name, email, password_hash, role_id, rep_code, warehouse_id, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    for (const rep of byRep.values()) {
      if (await existsByRepCode.get(rep.rep_code)) {
        skipped.push({ ...rep, reason: 'rep_code already has a user' });
        continue;
      }

      // Email: firstname@domain, else firstname.repcode@domain on a clash.
      const slug = firstNameSlug(rep.rep_name, rep.rep_code);
      let email = `${slug}@${EMAIL_DOMAIN}`;
      if (await existsByEmail.get(email)) {
        email = `${slug}.${rep.rep_code.toLowerCase()}@${EMAIL_DOMAIN}`;
      }
      if (await existsByEmail.get(email)) {
        skipped.push({ ...rep, reason: `email ${email} already taken` });
        continue;
      }

      const warehouse = rep.branch ? await findWarehouse.get(rep.branch) : null;
      const name = rep.rep_name || `Rep ${rep.rep_code}`;

      const temporaryPassword = `${crypto.randomBytes(12).toString('base64url')}aA1!`;
      if (!DRY_RUN) {
        await insertUser.run(name, email, bcrypt.hashSync(temporaryPassword, 12), repRole.id, rep.rep_code, warehouse?.id ?? null);
      }
      created.push({
        name, email, rep_code: rep.rep_code, branch: rep.branch,
        temporary_password: temporaryPassword,
        warehouse_matched: warehouse ? 'yes' : 'NO (branch not in warehouses)',
        active_customers: rep.active_customers
      });
    }
  });

  return { created, skipped };
}

// Only run the import when this file is executed directly - other scripts import
// EXCLUDE_CODES and fetchReps from here for diagnostics (same guard as index.js).
const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) (async () => {
  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Importing reps from SYSPRO vw_FS_Reps...`);
  console.log(ONLY_CODES ? `Limited to rep code(s): ${[...ONLY_CODES].join(', ')}\n` : '');
  const reps = await fetchReps();
  console.log(`Fetched ${reps.length} rep/branch rows from SYSPRO.`);
  const { created, skipped } = await run(reps);

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
