# OneRoute Production Readiness Audit

**Audit date:** 26 July 2026  
**System:** OneRoute / RouteOne field sales platform  
**Scope:** React client, Express API, SQLite data layer, authentication, authorization,
uploads, offline behavior, orders, quotes, stock, invoicing, visits, tasks, forms,
customer pricing, email, SYSPRO synchronization, backup, build pipeline, dependencies,
desktop workflows, mobile workflows, and concurrent representative traffic.

## Executive Result

The audit found several critical and high-risk issues that would have prevented a safe
production release. The confirmed application defects have been fixed and covered by
regression tests.

The current codebase passes:

- 10 end-to-end API and data-integrity tests.
- A 40-representative concurrent workload with 1,280 requests and zero failures.
- A Vite 8 production build.
- Server-side JavaScript syntax checks.
- Desktop administration and mobile representative browser smoke tests.
- A production server dependency audit with zero known vulnerabilities.

**Release status: conditionally ready.** The application changes are ready for staged
deployment. The deployment controls and live integration checks in the final section
must be completed before public production use.

## Risk Summary

| Severity | Found | Fixed | Remaining application defects |
| --- | ---: | ---: | ---: |
| Critical | 4 | 4 | 0 |
| High | 7 | 7 | 0 |
| Medium / low | 10 | 10 | 0 |

The counts group related occurrences under one root cause. For example, authorization
failures across several endpoints are reported as one critical access-control finding.

## Critical Findings And Fixes

### 1. Weak passwords across active accounts

**Finding:** All 43 active accounts matched known weak/default password patterns.
Authentication tokens were also stored in browser local storage, where injected script
could read them.

**Fix:**

- Existing active users are forced through a password-change gate.
- New and reset passwords require 12 to 128 characters and reject common defaults.
- Login hashing work is asynchronous and uses a dummy hash for unknown accounts.
- Import and demo utilities now generate unique random one-time passwords.
- Sessions use an `HttpOnly`, `SameSite=Strict` cookie, with `Secure` enabled in
  production.
- Logout invalidates the browser session and clears local offline data.
- Login rate limiting now tracks both source IP and account identifier.

### 2. Cross-representative access to customer data

**Finding:** A representative could supply another representative's customer, visit,
quote, invoice, task, form, or pricing identifier to several API endpoints.

**Fix:**

- Added centralized customer-access checks.
- Enforced ownership when reading or writing customer-linked orders, quotes, visits,
  invoices, tasks, form submissions, routes, GPS planning data, and customer pricing.
- Representatives can no longer use a supplied `rep_id` to widen invoice results.
- Quote status updates and quote-to-order conversion now enforce ownership.
- Regression tests attempt cross-representative reads and writes and confirm rejection.

### 3. Client-controlled prices and discounts

**Finding:** Order and quote requests trusted prices and discounts supplied by the
browser. A representative could alter the request and create an order below the valid
customer price.

**Fix:**

- Representative prices are calculated again on the server.
- Representative-entered discounts are ignored.
- Office-entered prices and discounts are validated as finite, nonnegative values with
  bounded discounts.
- Product status, quantities, customer ownership, visit ownership, and maximum line
  counts are validated.
- SYSPRO price selection now follows contract, buying group, price code, customer
  pricing, pricing rules, and list-price precedence.

### 4. Public access to uploaded business documents

**Finding:** The `/uploads` directory was publicly served before authentication, which
could expose PDFs and visit photos.

**Fix:**

- Files are now served only through an authenticated, authorized route.
- Office users can access authorized records; representatives can access shared
  documents and their own linked visit/form files.
- Filenames are normalized and validated.
- Responses use `no-store`.
- Deleted document and visit records remove the corresponding file.

## High Findings And Fixes

### 5. Stock was deducted for draft orders

**Finding:** Saving a draft reduced stock immediately, cancellation did not restore it,
and warehouse stock could disagree with total product stock.

**Fix:**

- Drafts do not reserve stock.
- The draft-to-submitted transition reserves stock once.
- Cancellation restores stock once.
- Quote conversion reserves stock using the customer's warehouse.
- Total and warehouse stock are changed together inside the order workflow.
- Regression coverage verifies draft, submit, and cancel transitions.

### 6. Service worker cached authenticated API data

**Finding:** The service worker could place authenticated API responses in the browser's
shared Cache API.

**Fix:**

- API responses are never service-worker cached.
- The cache version was advanced to invalidate the old cache.
- Logout removes OneRoute offline data and session markers.

### 7. Unsafe upload validation

**Finding:** Uploads trusted a declared MIME type and base64 text. There was no reliable
size limit or file-signature validation.

**Fix:**

- Strict base64 validation and decoded-size limits were added.
- PNG, JPEG, WebP, and PDF magic bytes are verified.
- Documents are restricted to valid PDFs with an 8 MB limit.
- Files use cryptographically random names and exclusive creation.

### 8. Weak protection for stored integration secrets

**Finding:** Integration secrets used unauthenticated AES-CBC encryption and could fall
back to a predictable production secret.

**Fix:**

- New secrets use AES-256-GCM authenticated encryption.
- Existing CBC records remain readable for migration compatibility.
- Production startup fails when `SECRET_KEY` is missing.

### 9. Insecure SQL Server and SMTP transport defaults

**Finding:** SYSPRO SQL encryption was disabled, the SQL certificate was always trusted,
and SMTP certificate verification was disabled.

**Fix:**

- SYSPRO SQL encryption defaults on.
- SQL certificate trust defaults off.
- SMTP certificate verification defaults on.
- Explicit administrator settings are available for a controlled internal certificate
  exception.

### 10. Unbounded SYSPRO view synchronization

**Finding:** Large source views could load millions of rows into process memory and
overlapping syncs could run for the same entity.

**Fix:**

- SYSPRO view names are restricted to valid one- or two-part SQL identifiers and are
  bracket quoted.
- Entity-specific safety ceilings use `TOP (limit + 1)` and fail clearly if exceeded.
- A same-entity in-process lock prevents scheduled and manual sync overlap.
- Port and TLS settings are validated.

### 11. Missing usable online backup

**Finding:** No application-managed online backup covered both the SQLite database and
uploaded files.

**Fix:**

- Added SQLite's online backup operation.
- The uploads directory is captured in the same timestamped backup set.
- Backup creation uses a temporary directory followed by atomic rename.
- Retention cleanup is bounded to direct children of the configured backup root.
- The scheduler checks hourly, and a manual `npm run backup` command is available.
- An integration test opens and validates the resulting database backup.

## Medium And Low Findings And Fixes

- Stored email HTML used direct `dangerouslySetInnerHTML`; previews now use a sandboxed
  iframe.
- Cross-origin requests had permissive development assumptions; production now requires
  `APP_ORIGIN`, uses an origin allow-list, and blocks cross-site mutations.
- Security response headers were incomplete; CSP, HSTS in production, frame denial,
  MIME sniffing prevention, referrer policy, permissions policy, CORP, and API
  `no-store` headers were added.
- JSON request size is capped at 12 MB.
- Date, GPS, quantity, line-count, customer, representative, product, and relationship
  validation were tightened.
- Express and the frontend build toolchain were upgraded to patched current releases.
- A production build syntax error in the routes screen was corrected.
- Demo data and demo invoice seeders now refuse to run in production mode.
- Application startup was separated from the exported Express app so tests can run
  against isolated temporary databases without starting schedulers.
- A health endpoint and scheduler-disable option were added for deployment and tests.

## Verification Evidence

### Automated integration tests

All 10 tests passed:

1. Health, security headers, authentication cookie, and cross-site blocking.
2. Cross-representative customer access rejection.
3. Server-side price and discount enforcement.
4. Quote ownership, status mutation, and conversion authorization.
5. Draft, submit, cancellation, and stock integrity.
6. Required password change and logout lifecycle.
7. Upload signatures, authorization, and file deletion.
8. Online database and upload backup.
9. Production refusal for demo data and demo invoice seed utilities.
10. Forty concurrent representatives performing mixed read/write traffic.

### Concurrent workload

| Measure | Result |
| --- | ---: |
| Concurrent representatives | 40 |
| Total requests | 1,280 |
| Failures | 0 |
| Login phase | 5,090 ms |
| Median response | 138 ms |
| 95th percentile | 253 ms |
| 99th percentile | 324 ms |
| Maximum response | 437 ms |

This is a local single-Node-process application test. It proves the current application
and SQLite write path can handle the requested workload under local conditions. It does
not include production WAN latency, reverse-proxy limits, antivirus overhead, or live
SQL Server latency.

### Browser coverage

The audit loaded 20 administration routes, including dashboard, customers, products,
orders, invoices, quotes, forms, documents, visits, routes, tasks, KPIs, analytics,
AI, map, team, settings, email, integration, and users.

Representative mobile checks covered today, customers, orders, tasks, stock, and
customer detail at a 390 by 844 viewport. No page exceptions, failed application API
calls, blank pages, or horizontal overflow were observed. The password-change screen
was also exercised.

### Build and dependency checks

- `npm test`: passed.
- `npm run build`: passed with Vite 8.1.5.
- Server `node --check`: passed for all JavaScript files.
- `npm ls --all`: valid dependency tree; missing entries shown by npm are optional
  platform or optional compiler packages.
- `npm audit --omit=dev`: zero vulnerabilities.
- Full `npm audit`: two high entries represent one upstream React Router 7.18.1 advisory
  for React Server Components action handling. OneRoute does not use React Server
  Components, server actions, SSR, or the affected handler. There is no upstream patched
  release available on the audit date; downgrading reintroduces multiple applicable
  browser-routing advisories. Keep this dependency monitored.

## Required Before Production

1. Set `NODE_ENV=production`, a unique high-entropy `SECRET_KEY`, the exact HTTPS
   `APP_ORIGIN`, and the correct proxy trust setting.
2. Terminate TLS at a maintained reverse proxy and confirm cookies arrive with the
   `Secure` flag.
3. Put `BACKUP_DIR` on a protected volume separate from the application disk. Run a
   full restore drill and document the recovery time.
4. Confirm all 43 existing users complete the forced password change before broad
   access is enabled.
5. Use a least-privileged, read-only SYSPRO SQL account. Prefer a CA-trusted SQL
   certificate; enable internal certificate trust only when the certificate has been
   independently verified.
6. Have the DBA confirm the configured SYSPRO views, indexes, row counts, pricing
   precedence, and units of measure in staging.
7. Test live SYSPRO synchronization and Microsoft 365/SMTP sending in staging. The
   audit deliberately did not execute writes or send mail against live external
   systems.
8. Run the same 40-user scenario through the production HTTPS endpoint from outside the
   server network to include proxy, WAN, SQL Server, backup, monitoring, and endpoint
   protection overhead.
9. Run only one OneRoute Node process against this SQLite database. Do not use multiple
   application replicas sharing the same SQLite file. Reassess the database platform
   before materially increasing write concurrency or adding horizontal replicas.
10. Configure log collection, uptime checks against `/api/health`, disk-space alerts,
    backup-failure alerts, and an incident owner.

## Release Recommendation

Proceed to a controlled staging deployment and administrator acceptance test. Promote
to production only after the ten operational items above are signed off. No known
unfixed application defect from this audit blocks staging.
