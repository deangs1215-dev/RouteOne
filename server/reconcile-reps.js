// Reconcile RouteOne's rep users against SYSPRO's SalSalesperson master.
//
// READ-ONLY. Reports drift; changes nothing. Run it, read the output, then
// decide what to do per rep - see "Why this doesn't auto-fix" below.
//
//     node server/reconcile-reps.js
//
// ---------------------------------------------------------------------------
// Why this exists (2026-08-27)
// ---------------------------------------------------------------------------
// SYSPRO salesperson 111 at branch 01 is Bernice Molokwe. RouteOne had Nasief
// Isaac on that code, so her 149 customers and ~R3m of monthly sales were being
// attributed to him - in her customer list, her KPIs and her invoices.
//
// The cause is that import-reps.js only ever INSERTS. It skips any rep_code
// that already has a user ("rep_code already has a user"), so it onboards new
// reps but never notices when an existing code changes hands. It is also
// hand-run, so nothing catches the drift in between.
//
// rep_code + branch is the key that matters: matchRep() in
// server/integration/sync.js resolves a customer's SYSPRO salesperson to a
// RouteOne user on that pair, and the customer sync re-applies it every run.
// So whoever holds the pair in RouteOne receives that rep's whole book.
//
// ---------------------------------------------------------------------------
// Why this doesn't auto-fix
// ---------------------------------------------------------------------------
// 1. email is the login. Renaming a user without changing it leaves the new
//    person signing in as the old one; changing it locks the old person out.
//    Neither is safe to do unattended.
// 2. The user id owns history. 149 customers, plus visits, orders, quotes and
//    notes, hang off that row. Renaming keeps all of it attached to the new
//    rep, which is right for a territory handover and wrong if the previous
//    rep still works here under another code.
// Both are per-rep judgement calls, so this reports and stops.
import { db } from './db.js';
// import-reps.js guards its own CLI entry point with an isMain check, so
// importing it here has no side effects. EXCLUDE_CODES is not exported; the
// REP_CODES allow-list already encodes which codes are real field reps.
import { REP_CODES, fetchReps } from './import-reps.js';

const pad = (s, n) => String(s ?? '').padEnd(n);

// Same collapse rule as import-reps.js: one entry per code, home branch being
// the one with the most recently-invoiced customers.
function collapse(rows) {
  const byRep = new Map();
  for (const row of rows) {
    const code = String(row.rep_code || '').trim();
    if (!code) continue;
    const existing = byRep.get(code);
    if (!existing || (row.active_customers || 0) > (existing.active_customers || 0)) {
      byRep.set(code, {
        rep_code: code,
        rep_name: (row.rep_name || '').trim(),
        branch: (row.branch || '').trim(),
        active_customers: row.active_customers || 0,
        branches: existing ? existing.branches : []
      });
    }
    byRep.get(code).branches.push({ branch: (row.branch || '').trim(), active: row.active_customers || 0 });
  }
  return byRep;
}

const rows = await fetchReps();
const syspro = collapse(rows);

const users = db.prepare(`
  SELECT u.id, u.name, u.email, TRIM(u.rep_code) AS rep_code, u.active, w.code AS branch
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN warehouses w ON w.id = u.warehouse_id
  WHERE r.name = 'rep' AND u.rep_code IS NOT NULL AND TRIM(u.rep_code) <> ''
`).all();
const byCode = new Map(users.map((u) => [u.rep_code, u]));
const custCount = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE rep_id = ?');

const nameMismatch = [], branchMismatch = [], missingInRouteOne = [], notInSyspro = [];

for (const [code, s] of syspro) {
  const u = byCode.get(code);
  if (!u) {
    // Only flag codes RouteOne would actually onboard - EXCLUDE_CODES filters
    // house accounts, export desks and other non-people.
    if (REP_CODES.has(code)) missingInRouteOne.push({ code, ...s });
    continue;
  }
  const norm = (x) => String(x || '').trim().toLowerCase();
  if (s.rep_name && norm(s.rep_name) !== norm(u.name)) {
    nameMismatch.push({ code, routeone: u, syspro: s, customers: custCount.get(u.id).n });
  }
  if (s.branch && norm(s.branch) !== norm(u.branch)) {
    branchMismatch.push({ code, routeone: u, syspro: s, customers: custCount.get(u.id).n });
  }
}
for (const u of users) {
  if (!syspro.has(u.rep_code)) notInSyspro.push({ ...u, customers: custCount.get(u.id).n });
}

console.log('\n=== NAME MISMATCH - RouteOne disagrees with SalSalesperson ===');
console.log('These reps see, and are credited with, another person\'s book.\n');
if (!nameMismatch.length) console.log('  none');
else {
  console.log('  ' + pad('code', 6) + pad('branch', 8) + pad('RouteOne has', 26) + pad('SYSPRO says', 26) + 'customers');
  for (const m of nameMismatch) {
    console.log('  ' + pad(m.code, 6) + pad(m.routeone.branch, 8) + pad(m.routeone.name, 26) + pad(m.syspro.rep_name, 26) + m.customers);
    console.log('      login: ' + m.routeone.email + '   (user id ' + m.routeone.id + ')');
  }
}

console.log('\n=== BRANCH MISMATCH ===');
console.log('matchRep() keys on branch + code, so a wrong branch means SYSPRO sales');
console.log('for that code never reach this rep at all.\n');
if (!branchMismatch.length) console.log('  none');
else for (const m of branchMismatch) {
  console.log('  ' + pad(m.code, 6) + pad(m.routeone.name, 26) + 'RouteOne ' + pad(m.routeone.branch || '(none)', 8) + ' vs SYSPRO ' + pad(m.syspro.branch, 8) + m.customers + ' customers');
  console.log('      SYSPRO branches for this code: ' + m.syspro.branches.map((b) => b.branch + '(' + b.active + ')').join(', '));
}

console.log('\n=== IN SYSPRO, NO ROUTEONE USER ===');
console.log('Would be created by import-reps.js.\n');
if (!missingInRouteOne.length) console.log('  none');
else for (const m of missingInRouteOne) console.log('  ' + pad(m.code, 6) + pad(m.branch, 8) + pad(m.rep_name, 26) + m.active_customers + ' active customers');

console.log('\n=== IN ROUTEONE, NOT IN SalSalesperson ===');
console.log('A code that no longer exists in SYSPRO gets no sales and no customers.\n');
if (!notInSyspro.length) console.log('  none');
else for (const u of notInSyspro) console.log('  ' + pad(u.rep_code, 6) + pad(u.branch || '(none)', 8) + pad(u.name, 26) + u.customers + ' customers   active=' + u.active);

console.log('\n--- summary ---');
console.log('  SalSalesperson codes read : ' + syspro.size);
console.log('  RouteOne rep users        : ' + users.length);
console.log('  name mismatches           : ' + nameMismatch.length);
console.log('  branch mismatches         : ' + branchMismatch.length);
console.log('  missing in RouteOne       : ' + missingInRouteOne.length);
console.log('  stale in RouteOne         : ' + notInSyspro.length);
console.log('\nRead-only - nothing was changed.\n');
