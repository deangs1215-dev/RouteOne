# OneRoute Review And Fix Blueprint For Claude

**Prepared:** 19 September 2026  
**Repository:** `C:\Projects\RouteOne`  
**Current branch when reviewed:** `pricing-convfactaltuom`  
**Purpose:** Continue the current top-to-bottom review, fix the confirmed defects below,
add regression coverage, and leave the system safer and easier to operate without
overwriting the substantial uncommitted work already present.

## Mandatory Working Rules

1. Read this file, `TODO.md`, `ROUTEONE_HANDOVER_2026-08-28.md`, `CLAUDE.md`,
   `DEPLOYMENT.md`, `DECISIONS.md`, and the July production-readiness audit before
   changing code.
2. Run `git status --short` before every phase. The worktree is intentionally dirty.
   Do not use `git reset`, `git checkout --`, `git restore`, `git clean`, broad
   formatting, or any command that discards or rewrites unrelated changes.
3. Treat every existing uncommitted edit as user-owned. Read the current file before
   editing and apply narrow patches around the current implementation.
4. Do not deploy, restart the RouteOne Windows service, write to the production SQLite
   database, send real email, or modify live SYSPRO objects unless Dean explicitly asks.
5. Use disposable databases for automated tests. The local `server/data/fieldsales.db`
   is approximately 1.7 GB and is not a disposable test fixture.
6. Preserve the existing architecture: React/Vite, Express, better-sqlite3, and the
   read-only SYSPRO integration. Do not redesign working features or replace the stack.
7. Do not change the deliberate 9-character password minimum unless Dean asks. Make
   all messages and controls consistent with the policy actually enforced.
8. Complete and test one phase at a time. Report exact files changed and verification
   evidence after each phase.

## Verified Baseline

Before this blueprint was written:

- `npm test` passed all 14 tests.
- The 40-representative test completed 1,280 requests with zero failures:
  p50 87 ms, p95 156 ms, p99 251 ms, maximum 262 ms.
- `npm run build` passed with Vite 8.1.5.
- The current production bundle contains a large `OrderSummary` chunk (~376 KB,
  108 KB gzip); investigate splitting PDF-related code, but do not treat this as a
  release blocker unless mobile measurements show a real regression.
- `npm audit fix` was run during review and changed only `package-lock.json`:
  Nodemailer 9.0.3 -> 9.1.1, `qs` 6.15.3 -> 6.16.0, and Nano ID 3.3.16 -> 3.3.19.
  Preserve these changes and verify them.
- A full audit still reported the React Router RSC-mode advisory because the project is
  exactly pinned to 7.18.1. OneRoute does not use RSC, SSR, server actions, or the
  vulnerable handler, but a patched 7.18.4 release is now available and should be
  tested rather than leaving the exception open.

## Phase 1: Account Recovery And Email Security

### Confirmed defects

1. `server/routes/auth.routes.js` stores reset expiry as ISO text such as
   `2026-09-19T12:34:56.000Z` but compares it directly to SQLite
   `datetime('now')`, which produces `2026-09-19 12:34:56`. Lexicographic comparison
   makes an expired same-day token appear valid. Use
   `datetime(reset_token_expires) > datetime('now')`, or store epoch seconds
   consistently. Add an exact expired-token regression test.
2. Password-reset emails are inserted into `email_log` with the raw reset token in
   `body_html`. Admin, manager, and office users can read email-log detail, so the
   reset credential is exposed at rest to roles that should never receive it.
3. `POST /users/:id/send-login-details` generates a temporary password with
   `Math.random()`, emails the password in plaintext, and replaces the user's current
   password before mail delivery is known to have succeeded.
4. That route calls `sendEmail(user.email, subject, html)`, but
   `sendEmail` accepts one draft object. The feature is therefore broken as well as
   unsafe.
5. `POST /auth/forgot-password` has no request throttle and can be abused to generate
   email volume and repeatedly invalidate earlier reset links.

### Required implementation

- Replace “send login details” with “send account setup link”. Generate a
  cryptographically random, one-time reset/setup token and email a link through the
  same secure reset flow. Never generate, store, return, log, or email a plaintext
  password.
- Do not change the user's password or invalidate sessions merely when the setup email
  is requested. Invalidate sessions only after the token is successfully used to set a
  new password.
- Keep only the SHA-256 token hash in `users.reset_token_hash`.
- Ensure reset links expire after exactly one hour and are cleared after first use.
- Add separate account-setup wording in `server/integration/email.js`.
- Add a sensitive-email option to `sendEmail`: send the real body from memory but store
  only a redacted body in `email_log`. Password reset/setup links must never be
  persisted. Block resend for redacted security emails.
- Validate the result returned by `sendEmail`. The admin setup endpoint must not claim
  delivery when the email is pending or failed. Clear the newly issued setup token if
  immediate delivery fails.
- Rate-limit forgot-password requests by both IP and normalized account identifier.
  Keep the same generic response for found, missing, and throttled accounts to avoid
  user enumeration. Bound and periodically prune the in-memory limiter map.
- Add strict single-address email validation before SMTP/Graph delivery. Reject CR/LF,
  address lists, comments, oversized values, and malformed domains. Apply the same
  normalization to saved recipients and personal contacts.
- Keep the enforced password rule at 9-128 characters, with a capital letter, a
  number, and the common-password deny list. Correct text that still says 12.
- Rename the client action and success text in `client/src/pages/Users.jsx` from
  “Send login” to “Send setup link”.

### Required tests

- An expired ISO-formatted token from earlier the same UTC day is rejected.
- A valid token works once and fails on reuse.
- Password reset increments `token_version` and invalidates prior sessions.
- Forgot-password responses are identical for known and unknown accounts.
- A password-reset/setup `email_log.body_html` contains no token and no `token=` URL.
- The admin setup route does not change `password_hash` before token use.
- A manager cannot send a setup link to an admin account.
- Invalid recipient syntax is rejected before it reaches Nodemailer or Graph.

## Phase 2: Offline Idempotency And Duplicate Orders

### Confirmed defects

`client/src/offline.js` replays every outbox item whose status is not `failed`.
That includes a recently `synced` item during its 2.5-second display window, so another
flush can submit it again. More importantly, if the server commits an order but the
network drops before the response reaches the phone, the client queues the same order
and later creates a duplicate.

### Required implementation

- Change outbox selection so `synced` items are never replayed. Pending items and stale
  `syncing` items may be retried; failed items require manual retry.
- Add a cryptographically random `client_request_id` to order and quote submissions
  before the first network attempt. The same payload object and ID must be retained when
  queued offline.
- Add nullable `client_request_id` columns to `orders` and `quotes`, plus partial unique
  indexes for non-null values, in both `server/schema.sql` and idempotent migrations in
  `server/db.js`.
- On `POST /orders` and `POST /quotes`, validate the identifier, look it up before
  creating a number or moving stock, and return the existing document to the same user
  without sending email again. Reject a collision owned by another user.
- Handle the unique-index race as a duplicate request, not as a generic 400.
- Do not use a timestamp plus `Math.random()` for a financial idempotency key. Use
  `crypto.randomUUID()` or `crypto.getRandomValues()`.

### Required tests

- Submitting the same order request ID twice creates one order, one set of lines, one
  activity event, and one stock movement.
- Submitting the same quote request ID twice creates one quote and one set of lines.
- The duplicate response returns the original number and totals.
- A request ID belonging to another user cannot be used to retrieve their document.
- A `synced` outbox item is not included in the next flush.

## Phase 3: Authorization And Input Boundaries

### Support tickets

`server/routes/support.routes.js` checks only that supplied `customer_id` and `order_id`
exist. A representative can link another representative's customer/order and expose
its name/number through ticket views.

- Use `userCanAccessCustomer` for customer context.
- Resolve the order, ensure its customer is accessible, and ensure supplied customer
  and order context agree.
- Cap subject at 160 characters, description at 5,000, and admin notes at 5,000.
- Reject unsupported status filters rather than silently returning arbitrary results.
- Add cross-representative API tests.

### Drafts

`server/routes/drafts.routes.js` scopes the draft row to its owner but accepts arbitrary
customer, visit, and template IDs. A rep can create a draft linked to another rep's
customer and recover the customer name through the draft list.

- Validate customer ownership with `userCanAccessCustomer`.
- Validate that the visit belongs to the same customer and, for reps, to the current
  rep. Validate the template exists and is active.
- Set a reasonable serialized payload limit, for example 512 KB, below the global
  12 MB JSON ceiling.
- Validate the incoming body exists before destructuring it.
- Safely parse legacy/corrupt JSON rows in reads so one bad draft cannot break the
  entire list.
- Add ownership, relationship, and payload-size tests.

### Branch recipient privacy

`GET /settings/order-email-info?warehouse_id=...` accepts any warehouse ID. A rep can
enumerate configured employee/department email addresses from other branches.

- For a rep, allow a warehouse only when at least one customer assigned to that rep
  belongs to it, or change the endpoint to accept an accessible `customer_id` and derive
  the warehouse server-side.
- Office roles may retain the broader behavior.
- Add a test proving a rep cannot enumerate an unrelated branch.

### General input checks

- Apply length caps and normalized email validation to recipient names, descriptions,
  support fields, clock-in notes, order notes, delivery instructions, and customer PO
  references.
- Avoid returning raw SQLite error messages to clients.

## Phase 4: Backup And Restore Reliability

### Confirmed defect

`restoreBackup()` closes the global SQLite handle and returns. The route then calls
`logActivity()`, which uses the closed handle and throws. The API returns an error after
the files were already replaced, and the process can remain alive with a permanently
closed database instead of exiting for restart.

### Required implementation

- Record a `restore_requested` audit event before calling `restoreBackup()`. Do not query
  or write the database after `closeDb()`.
- Validate the selected backup before the safety backup and before closing the live DB:
  required files, readable manifest, SQLite `PRAGMA quick_check = ok`, and expected core
  tables.
- If any operation fails after the live handle is closed, return a failure response if
  possible and still terminate the process so NSSM restarts it. Do not leave a live HTTP
  process with a closed DB handle.
- Preserve the existing safety backup of the current state.
- Validate schedule times as real 00:00-23:59 values and bound retention to an explicit
  operational maximum.
- Set `BACKUP_DIR` to a disposable location in integration tests.

### Required tests

- A corrupt backup is rejected before the live DB closes, and `/api/health` remains 200.
- A path outside the configured backup root is rejected.
- A valid backup passes validation.
- If full restore is tested, run it in a dedicated child process because success
  intentionally exits the server.

## Phase 5: Manager Branch Assignments And User Administration

### Confirmed defect

The current multi-branch feature saves `manager_warehouses` only in
`PUT /users/:id`. `POST /users` ignores assignments, so a newly created manager silently
loses every checked branch.

### Required implementation

- Save manager assignments during creation in the same transaction as the user row.
- Validate every warehouse ID exists, is an integer, is unique, and is bounded in count.
- Use a transaction when replacing assignments during update; do not leave an empty or
  partial set when one insert fails.
- Validate role IDs explicitly and return accurate errors. The broad create catch
  currently reports every failure as “Email already in use”.
- Validate unique-email errors on update instead of letting them become a 500.
- Confirm with Dean whether manager branch assignments are informational or are meant to
  restrict manager visibility. They are currently not used by any authorization query.
  Do not impose branch-level access control without that answer.
- Budgets endpoints should verify the target user exists and has the rep role.

### Required tests

- Creating a manager with two branches persists both.
- Updating to an empty branch set removes all assignments.
- An invalid/duplicate warehouse ID rolls back the entire change.
- A manager cannot create, modify, delete, or send setup email to an admin account.

## Phase 6: SYSPRO Sync Scalability And Correctness

### Must verify against staging/live metadata before changing

The code and project notes conflict:

- The local pricing table and comments describe approximately 13 million pricing rows.
- `providers.js` queries only `TOP (5,000,001)` for `customer_pricing` and throws when
  more than 5,000,000 rows are returned.
- `runSync()` still materializes the entire provider result in memory before writing.
- Writes are now committed in 2,000-row transactions with event-loop yields, which
  fixes the long synchronous write stall, but it does not fix fetch memory pressure.
- Pricing sync is upsert-only. A pricing row removed from the SYSPRO view remains in
  SQLite forever and can continue influencing prices.

### Required discovery

1. Query the real view row count and confirm uniqueness of
   `(customer_code, product_code)`.
2. Capture the last five pricing sync runs and their read/upsert/skip/error counts.
3. Measure Node working-set memory during the fetch and write phases.
4. Confirm whether the 13M figure is total source rows, current rows, or an old estimate.

### Recommended design

- Add an async-batch provider API for `customer_pricing`. Prefer keyset pagination on
  `(customer_code, product_code)` with a stable `ORDER BY`, or verified SQL Server
  request streaming with backpressure. Do not use large `OFFSET` pagination.
- Feed each bounded source batch directly into a prepared SQLite transaction, yield to
  the event loop, then release the batch. Never retain millions of JS objects.
- Prepare the high-volume SQL statements once rather than calling `db.prepare()` for
  every row.
- Add a `last_seen_sync_id` marker to pricing rows. Set it on every upsert. Only after a
  completely successful source read, delete rows not seen in that run, in bounded
  batches. A failed run must not delete old prices.
- Keep customer pricing manual-only until this work is verified under production-like
  load. Never run the 13M-row test against the live server during business hours.
- Enforce a configurable total-row safety ceiling above the verified real count, and
  fail clearly when exceeded.
- Keep per-entity overlap prevention and log fetch time, write time, row count, memory
  high-water mark, and stale-row deletion count.

### Required tests

- Batch iteration produces the same final table as a single small fixture fetch.
- A failed mid-run import does not delete prior prices.
- A successful run removes prices no longer present in the source.
- Duplicate or non-monotonic source keys fail safely.
- A timer/health probe receives event-loop turns during a large synthetic sync.
- Measure peak memory for at least one million synthetic rows and document it.

## Phase 7: Date/Time And Smaller Reliability Fixes

- `server/routes/branch-clock-in.routes.js` compares UTC database timestamps to a date
  generated with `toISOString()`. Around midnight in Africa/Johannesburg, “today” is
  wrong for up to two hours. Query explicit UTC boundaries for the local business day,
  or use the project's local-date helper consistently. Add a midnight-boundary test.
- Prevent double clock-out from replacing the original clock-out time unless that is a
  deliberate business rule.
- Cap and trim branch clock-in notes.
- `server/routes/monitoring.routes.js` resolves `.env` from `process.cwd()`. Resolve it
  from the application root so an NSSM working-directory change cannot make the admin
  page read/write the wrong file.
- Review `OrderSummary`'s 376 KB chunk. Keep PDFKit and other heavy generators behind a
  dynamic import and verify that the rep's initial mobile route does not download that
  chunk before it is needed.

## Phase 8: Dependencies And Final Verification

1. Preserve the already-applied lockfile upgrades for Nodemailer 9.1.1 and `qs` 6.16.0.
2. Update the exact `react-router-dom` pin from 7.18.1 to the patched 7.18.4 release,
   then test all routing. Do not use an unrelated broad `--force` upgrade.
3. Run both `npm audit --omit=dev` and full `npm audit`. Production must report zero.
   Explain any remaining development-only advisory and whether its code path exists.
4. Run `npm ls --all`, `npm test`, `npm run build`, and `node --check` across all server
   JavaScript files.
5. Re-run the 40-representative test and compare p50/p95/p99/max with the baseline.
6. Add browser smoke coverage for every admin route and the mobile representative flow
   at 390x844. Check console errors, failed API calls, blank views, and horizontal
   overflow.
7. Specifically exercise: login, forgot/reset password, admin setup link, users and
   manager branches, offline order replay, support tickets, drafts, order/quote capture,
   backups list/validation, integration settings, and logout/offline-data clearing.
8. Run `git diff --check`. Do not “fix” line endings or unrelated existing files.

## Definition Of Done

- Every confirmed defect above has either a focused fix plus regression test or a
  written, evidence-based reason it is not applicable.
- No existing uncommitted user/Claude changes are lost or reformatted wholesale.
- All automated checks pass against a disposable database.
- Production dependency audit is clean.
- No plaintext credential or reset token is stored in the database, logs, API response,
  or email history.
- Retried order/quote submissions are idempotent and do not duplicate stock movement or
  email.
- A restore either fails before closing the DB or completes and exits for NSSM restart;
  it can never leave a serving process with a closed handle.
- SYSPRO customer-pricing sync has a documented row count, bounded memory, stale-row
  handling, and measured event-loop responsiveness before automatic scheduling is
  considered.
- Produce a final report listing findings by severity, files changed, test evidence,
  load-test results, remaining operational actions, and anything not verified against
  live external systems.

## Prompt To Give Claude

> Work through `CLAUDE_REVIEW_AND_FIX_BLUEPRINT_2026-09-19.md` in
> `C:\Projects\RouteOne`. Read all mandatory context first and preserve every existing
> uncommitted change. Do not deploy or touch live RouteOne/SYSPRO data. Implement the
> confirmed fixes phase by phase with focused regression tests, reporting after each
> phase. Stop for my decision only where the blueprint explicitly says business intent
> must be confirmed, especially whether manager branch assignments should restrict
> visibility and before any live SYSPRO verification.
