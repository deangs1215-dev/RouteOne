# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates are
commit dates; "Unreleased" is everything currently sitting uncommitted in the
working tree.

## Unreleased

Not yet committed — see TODO.md's "commit the backlog" item.

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
