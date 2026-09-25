# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates are
commit dates; "Unreleased" is everything currently sitting uncommitted in the
working tree.

## Unreleased

Not yet committed — see TODO.md's "commit the backlog" item. Includes Documents, Tasks module phase 2/3, invoices, email/backup/settings admin, and the integration test harness.

## 2026-07-31

- `8284944` Production hardening: require SECRET_KEY unconditionally, set up NSSM Windows service, add deployment tooling
- `server/crypto.js`: `SECRET_KEY` now unconditionally required (app throws at startup if missing). No more insecure fallback key that masked encrypted-password failures.
- `server/routes/auth.routes.js`: fix password-reset links on multi-origin configs (extracts first origin from comma-separated `APP_ORIGIN`).
- `server/routes/integration.routes.js`: clarify in comments that rep ownership is SYSPRO-master (not app-managed).
- `server/import-reps.js`: export `EXCLUDE_CODES` and `fetchReps` for reuse; add `isMain` guard so file can be imported without triggering auto-import.
- New: `DEPLOYMENT.md` §8 with full NSSM walkthrough (service registration, restart, log rotation, logoff/reboot survival test). §9 documents HTTP-only test-server gotchas (COOKIE_SECURE, APP_ORIGIN exactness).
- New: `QUICK_REFERENCE.md` — day-to-day Windows RDP workflow with actual commands (deploy.bat, nssm restart, backup, diagnostics). Added verified `Set-EnvValue` PowerShell helper to replace unsafe Notepad editing.
- New: `status.ps1` — health check script for laptop (tests API, client build, login origin acceptance, database/backup freshness, .env keys including SECRET_KEY).
- New: `backup-db.ps1` — pull backups from server over Z: drive to laptop.
- New: `deploy.bat` — updated messaging to point to NSSM service restart instead of manual npm.
- New: `deploy.ps1` — PowerShell variant with same robocopy exclusions (database, backups, uploads, .env, .db files).
- New: `server/diagnose-unmatched.js` — read-only diagnostic for rep↔customer assignment gaps (buckets by NO_REP_CODE, NO_SUCH_REP, BRANCH_MISMATCH).
- New: `server/list-orphan-reps.js` — identify rep codes owning unassigned customers with no RouteOne login.
- New: `server/reset-password.js` — one-off admin utility for password reset (hidden prompts, strength validation, optional `must_change_password` flag).
- Updated `.env.example` documentation: clarified that `SECRET_KEY` is **always** required (not just `NODE_ENV=production`), and explained the consequence of a missing/changed key on stored SYSPRO/SMTP passwords.
- Memory updated: deployment topology now documents NSSM service setup, safe `.env` editing via PowerShell helper, and the architectural decision that SERVER = production-rigor (SECRET_KEY hard-fail) even for a test box holding real data.

**Why the changes:**
- Earlier session revealed that `SECRET_KEY` missing from server `.env` was silently falling back to a hardcoded key, causing SYSPRO authentication to fail with no visible startup error — a failure mode discovered days after the misconfiguration, not at deploy time. Now it's loud and immediate.
- Manual `npm start` in an RDP window dies when the session disconnects, losing the app and breaking overnight syncs/backups. NSSM Windows service survives logoff and reboot, matching production resilience expectations even for a test box with real customer data.
- Windows deployment workflow (RDP, robocopy, NSSM) was documented with Linux/SSH assumptions and PM2 — causing confusion about where to run commands and which files deploy touches. Rewritten docs (DEPLOYMENT.md, QUICK_REFERENCE.md, status.ps1) now match reality.

- Documents feature: admin/manager upload marketing PDFs; everyone (except the
  customer portal) can browse from the shared back-office menu. Reps reach it via
  their mobile app's "Main Menu" link, with a red "!" badge when something new
  has been uploaded since they last viewed it.
- Order/quote email sending changed from opt-out to opt-in: the orders-department
  copy, customer confirmation, and rep copy now only send when explicitly ticked
  on the capture screen (previously the orders-department email sent unconditionally
  with no way to see or control it).
- Per-kg pricing shown under the unit price in order/quote emails and PDFs
  (HTML body and PDF attachment/download, for orders, order confirmations, and
  quotes).
- Tasks module (Phase 2/3): mobile rep task creation, manager assignment, tasks
  surfaced inline in the Today call cycle with Done/Reschedule actions.
- Invoice-style order summary with signature capture; activity history
  (orders/quotes) made clickable through to detail views.
- Fixed churn-risk false positives: `last_order_at` now checks both app-captured
  orders and SYSPRO invoice history, not just app orders.
- SMTP delivery fixed end-to-end: port/TLS mismatch (587 STARTTLS vs implicit
  TLS), self-signed certificate handling for the internal mail server, and
  "Send As" sender-permission mismatch.
- Backend dependency/tooling additions not yet reflected in package.json history:
  `backup.js` (SQLite + uploads backup), `server/tests/` (integration test
  harness), settings/email/invoices admin routes and pages, `repDigest.js`
  scheduler, `cleanup-demo-data.js`, `import-reps.js`.
- Incorporated an external production-readiness audit (2026-07-26, see
  docs/PRODUCTION-READINESS-AUDIT-2026-07-26.md) covering auth, access control,
  price/discount trust, upload security, backups, and transport security. See
  that doc for the full findings list; TODO.md tracks what's still open.
- Root `CLAUDE.md` extended with project conventions (opt-in email model, SMTP
  cert workaround, Documents alert behavior, SYSPRO email-only integration) and
  a pointer to the audit's remaining pre-production checklist.
- Project knowledge graph built with graphify (`graphify-out/`) — 711 nodes,
  1757 edges across 52 communities, covering code + docs + brand assets.
- Naming clarified: the product is **RouteOne**, not "OneRoute" (a slip in the
  audit doc).

## 2026-07-09

- `465cc87` Surface tasks in Today call cycle + inline Done/Reschedule actions
- `77fbff7` Phase 2 & 3 Tasks module: mobile rep task creation + manager assignment
- `51b37ec` Make activity history orders/quotes clickable to view details
- `243b8fb` Add invoice-style order summary with signature capture

## 2026-07-08

- `e4feef3` Change login page to RouteOne branding
- `7ab82be` Remove RouteOne branding from login page
- `3ab2509` Use actual BAKELS logo on login page
- `179769e` Update login page with South Bakels and RouteOne logos
- `4afb6b4` Remove customer portal - not needed
- `0b335b0` Organize activity history into clear sections
- `e6fba56` Add calendar date picker to select visit dates
- `27f1fa1` Make back button red and prominent with 'Return Back' text
- `361d1b1` Show unified activity history (orders, quotes, forms)
- `700fc09` Make check-out button red for visual emphasis
- `6a9c5ee` Add visit activity summary (orders, quotes, forms, photos)
- `021ffb1` Add order/quote summary review screen before final submit
- `0265365` Enforce one open visit at a time (check out before checking in elsewhere)
- `a1b8db2` Customer visit action menu + standard field forms
- `61dfcc6` Order/quote capture: filter to what the customer buys
- `6aab161` Company letterhead + PDF documents on customer emails
- `7831125` Docs: add security section for password encryption
- `f9d6b39` Encrypt SYSPRO + SMTP passwords at rest
- `8df440c` Remove stray test log; ignore *.err
- `45a2460` Build in automatic SYSPRO sync scheduler

## 2026-07-07

- `035b1f0` RouteOne v1.0 - performance hardening for scale — the repo's first
  commit; it already contains the full Phase 1-5 build (customer/product
  master, visits, orders, offline mode, route planning, SYSPRO read-sync,
  analytics/Sales AI). See README.md for the feature breakdown per phase.
