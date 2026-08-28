// Reconcile RouteOne's rep users against SYSPRO's SalSalesperson master.
//
// READ-ONLY. Reports drift; changes nothing.
//
//     node server/reconcile-reps.js
//
// Must run ON THE SERVER: it compares SYSPRO against the local RouteOne
// database, so from a laptop it would read the wrong one.
//
// ---------------------------------------------------------------------------
// The key is rep_code + BRANCH, never rep_code alone
// ---------------------------------------------------------------------------
// A rep code is not unique. Code 101 is Siyabonga Sigwili at branch 01 AND
// Joseph Shabangu at branch 12 - two different people. matchRep() in
// server/integration/sync.js resolves a customer's salesperson on the pair, so
// the pair is what has to reconcile.
//
// The first version of this script collapsed each code to a single branch (the
// one with most recently-invoiced customers). That masked exactly the case it
// most needed to catch: with Siyabonga recorded at branch 12, he held Joseph's
// 298 Nelspruit customers while his own branch-01 book reached nobody, and the
// report showed it as a plain name mismatch with an empty branch section.
//
// ---------------------------------------------------------------------------
// Why it doesn't auto-fix
// ---------------------------------------------------------------------------
// email is the login, so renaming a user either leaves the new person signing
// in as the old one or locks the old one out; and the user id owns the rep's
// customers, visits, orders and quotes, so whether to rename or create anew
// depends on if the territory was genuinely handed over. Per-rep judgement.
import { db } from './db.js';
import { REP_CODES, fetchReps } from './import-reps.js';

const pad = (s, n) => String(s ?? '').padEnd(n);
const key = (code, branch) => `${String(code ?? '').trim()}|${String(branch ?? '').trim()}`;

// Names differing only by case, spacing or trailing punctuation are the same
// person - "Thandile Susela." vs "Thandile Susela" is not drift worth chasing.
const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,]+$/, '');

const rows = await fetchReps();

// One entry per (code, branch) - no collapsing.
const syspro = new Map();
for (const r of rows) {
  const code = String(r.rep_code || '').trim();
  const branch = String(r.branch || '').trim();
  if (!code || !branch) continue;
  syspro.set(key(code, branch), {
    code, branch,
    name: String(r.rep_name || '').trim(),
    active_customers: r.active_customers || 0
  });
}
// Which branches each code exists at, for explaining a wrong-branch case.
const branchesForCode = new Map();
for (const s of syspro.values()) {
  if (!branchesForCode.has(s.code)) branchesForCode.set(s.code, []);
  branchesForCode.get(s.code).push(s);
}

const users = db.prepare(`
  SELECT u.id, u.name, u.email, TRIM(u.rep_code) AS rep_code, u.active, w.code AS branch
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN warehouses w ON w.id = u.warehouse_id
  WHERE r.name = 'rep' AND u.rep_code IS NOT NULL AND TRIM(u.rep_code) <> ''
`).all();
const custCount = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE rep_id = ?');

const nameMismatch = [], cosmetic = [], pairNotInSyspro = [], noBranch = [], missingInRouteOne = [];
const seen = new Set();

for (const u of users) {
  const customers = custCount.get(u.id).n;
  if (!u.branch) { noBranch.push({ ...u, customers }); continue; }
  const k = key(u.rep_code, u.branch);
  seen.add(k);
  const s = syspro.get(k);
  if (!s) {
    pairNotInSyspro.push({ ...u, customers, elsewhere: branchesForCode.get(u.rep_code) || [] });
    continue;
  }
  if (s.name && normName(s.name) !== normName(u.name)) {
    nameMismatch.push({ user: u, syspro: s, customers });
  } else if (s.name && s.name !== u.name) {
    cosmetic.push({ user: u, syspro: s });
  }
}
for (const [k, s] of syspro) {
  if (!seen.has(k) && REP_CODES.has(s.code)) missingInRouteOne.push(s);
}

console.log('\n================ REP RECONCILIATION (keyed on code + branch) ================');

console.log('\n=== WRONG PERSON: code+branch matches, name differs ===');
console.log('This rep sees, and is credited with, another person\'s book.\n');
if (!nameMismatch.length) console.log('  none');
else for (const m of nameMismatch) {
  console.log('  code ' + pad(m.user.rep_code, 5) + 'branch ' + pad(m.user.branch, 4) +
              'RouteOne: ' + pad(m.user.name, 24) + 'SYSPRO: ' + pad(m.syspro.name, 24) + m.customers + ' customers');
  console.log('      login ' + m.user.email + '  (user id ' + m.user.id + ')');
}

console.log('\n=== WRONG BRANCH / UNKNOWN PAIR: this code+branch is not in SalSalesperson ===');
console.log('matchRep keys on the pair, so this rep receives whatever book that pair');
console.log('does match - or none at all.\n');
if (!pairNotInSyspro.length) console.log('  none');
else for (const u of pairNotInSyspro) {
  console.log('  code ' + pad(u.rep_code, 5) + 'branch ' + pad(u.branch, 4) + pad(u.name, 24) + u.customers + ' customers   active=' + u.active);
  console.log('      SYSPRO has this code at: ' +
    (u.elsewhere.length ? u.elsewhere.map((e) => `${e.branch} = ${e.name}`).join(' | ') : 'no branch at all'));
}

console.log('\n=== IN SYSPRO, NO ROUTEONE USER ===');
console.log('These reps have no login.\n');
if (!missingInRouteOne.length) console.log('  none');
else for (const s of missingInRouteOne) {
  console.log('  code ' + pad(s.code, 5) + 'branch ' + pad(s.branch, 4) + pad(s.name, 24) + s.active_customers + ' active customers');
}

console.log('\n=== REP USER WITH NO BRANCH ===');
console.log('matchRep needs branch + code, so these match nothing.\n');
if (!noBranch.length) console.log('  none');
else for (const u of noBranch) console.log('  code ' + pad(u.rep_code, 5) + pad(u.name, 24) + u.customers + ' customers');

if (cosmetic.length) {
  console.log('\n=== COSMETIC ONLY: same person, spelling differs ===\n');
  for (const c of cosmetic) console.log('  code ' + pad(c.user.rep_code, 5) + '"' + c.user.name + '"  vs SYSPRO  "' + c.syspro.name + '"');
}

console.log('\n--- summary ---');
console.log('  SalSalesperson code+branch pairs : ' + syspro.size);
console.log('  codes spanning >1 branch         : ' + [...branchesForCode.values()].filter((v) => v.length > 1).length);
console.log('  RouteOne rep users               : ' + users.length);
console.log('  wrong person                     : ' + nameMismatch.length);
console.log('  wrong branch / unknown pair      : ' + pairNotInSyspro.length);
console.log('  missing in RouteOne              : ' + missingInRouteOne.length);
console.log('  rep user with no branch          : ' + noBranch.length);
console.log('  cosmetic name differences        : ' + cosmetic.length);
console.log('\nRead-only - nothing was changed.\n');
