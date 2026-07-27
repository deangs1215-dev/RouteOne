# TODO

Working list of outstanding items. Keep this short — move anything done to
CHANGELOG.md instead of leaving it checked off here.

## Urgent / housekeeping

- [ ] **Commit the backlog of uncommitted work.** `git status` currently shows ~105
      changed files and ~30 new/untracked files (Documents feature, Tasks module,
      invoices, settings/email admin pages, backup.js, tests, the production audit
      fixes, this session's graphify build, etc.) sitting uncommitted. Break into
      logical commits before it gets any bigger or harder to review.
- [ ] Decide what to do with the two files graphify couldn't read (office-format
      conversion isn't installed): `Master Blueprint Claud info.docx` and
      `RouteOne_Engineering_Library_Volume_1_Product_Constitution_v1.docx`. Either
      run `pip install "graphifyy[office]"` and re-index them, or confirm they're
      stale and can be ignored.

## Before production (from the 2026-07-26 audit)

See [docs/PRODUCTION-READINESS-AUDIT-2026-07-26.md](docs/PRODUCTION-READINESS-AUDIT-2026-07-26.md)
for full detail — application-level fixes are done, these are the deployment-side
items still open:

- [ ] Set `NODE_ENV=production`, a unique high-entropy `SECRET_KEY`, the exact
      HTTPS `APP_ORIGIN`, and the correct proxy-trust setting.
- [ ] Terminate TLS at a maintained reverse proxy; confirm cookies arrive with
      the `Secure` flag.
- [ ] Put `BACKUP_DIR` on a protected volume separate from the app disk. Run a
      full restore drill and document the recovery time.
- [ ] Confirm all 43 existing users complete the forced password change before
      broad access is enabled.
- [ ] Use a least-privileged, read-only SYSPRO SQL account. Prefer a CA-trusted
      SQL certificate; only enable internal-cert trust once independently verified.
- [ ] DBA sign-off on the configured SYSPRO views, indexes, row counts, pricing
      precedence, and units of measure in staging.
- [ ] Test live SYSPRO sync and Microsoft 365/SMTP sending in staging (the audit
      deliberately didn't exercise live external systems).
- [ ] Re-run the 40-rep concurrent-load scenario through the real production
      HTTPS endpoint from outside the server network (proxy/WAN/SQL/backup/AV
      overhead wasn't in the local test).
- [ ] Confirm only one RouteOne Node process runs against the SQLite database
      — no multiple replicas sharing the same file.
- [ ] Set up log collection, `/api/health` uptime checks, disk-space alerts,
      backup-failure alerts, and an incident owner.

## Feature follow-ups

- [ ] **Documents push notifications.** Current alert is in-app only (red "!"
      badge on the rep's Main Menu link, refreshed on page load). A true
      phone-buzzes-even-when-closed notification needs separate infrastructure
      (service worker + Web Push + VAPID keys) — not started, scope it as its
      own piece of work if it becomes a priority.
- [ ] **Audit order emails sent during the `email_auto_send` outage.** That
      setting was found disabled (not '1') for an unknown period, meaning
      order-department/customer/extra-recipient emails silently never sent.
      Worth checking whether any real (non-test) orders from that window need a
      manual resend to the orders department.
- [ ] **Marketing manager permissions.** Documents upload currently reuses the
      existing admin/manager roles rather than a dedicated "marketing manager"
      role. Revisit if the marketing manager should NOT have access to the rest
      of the admin area (orders, customers, settings, etc).
