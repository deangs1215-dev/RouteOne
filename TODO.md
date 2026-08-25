# TODO

Working list of outstanding items. Keep this short — move anything done to
CHANGELOG.md instead of leaving it checked off here.

## Urgent / housekeeping

- [x] **Commit the backlog of uncommitted work.** Commit `8284944` landed the
      production hardening changes (SECRET_KEY hard-fail, NSSM setup, diagnostic
      scripts, rewritten deployment docs). Remaining unreleased work (Documents,
      Tasks, invoices, email/backup/settings admin) is still uncommitted — this
      should be the next batch.
- [x] **Login freeze on production, fixed 2026-08-12.** Login appeared to work
      then bounced/froze back to the login screen. Root cause: `NODE_ENV=production`
      defaults session cookies to `Secure`, which browsers silently drop over plain
      HTTP — so the login response succeeded but the cookie never actually stored,
      and every subsequent API call 401'd and redirected back to `/login`. Fixed by
      setting `COOKIE_SECURE=0` in the server's `.env` (documented escape hatch
      already built into `server/auth.js`) and restarting the service. **This is a
      stopgap** — see the HTTPS post go-live cleanup item below to revert it properly.
- [ ] **`customer_pricing` sync — do not put on an automatic schedule.** Row limit
      raised to 5M (actual SYSPRO view is ~13M rows, syncs fine as a one-off — took
      the whole event loop with it for the duration). The upsert runs inside a single
      `better-sqlite3` transaction, which is synchronous and blocks the entire Node
      process — no requests (including login) are served while it runs. Keep this
      entity's sync schedule set to "Off (manual only)" in Integration settings until
      it's re-architected to not block the event loop (e.g. batched transactions with
      a yield between batches, or moved off the main thread).
- [ ] Decide what to do with the two files graphify couldn't read (office-format
      conversion isn't installed): `Master Blueprint Claud info.docx` and
      `RouteOne_Engineering_Library_Volume_1_Product_Constitution_v1.docx`. Either
      run `pip install "graphifyy[office]"` and re-index them, or confirm they're
      stale and can be ignored.

## Before production (from the 2026-07-26 audit)

See [docs/PRODUCTION-READINESS-AUDIT-2026-07-26.md](docs/PRODUCTION-READINESS-AUDIT-2026-07-26.md)
for full detail — application-level fixes are done, these are the deployment-side
items still open:

- [x] **Set `SECRET_KEY` unconditionally required.** Commit `8284944`: `server/crypto.js`
      now throws at startup if `SECRET_KEY` is missing, on all machines, not just
      `NODE_ENV=production`. No more silent fallback key (which masked encrypted-password
      failures until it was too late).
- [x] **Install as Windows service (NSSM).** Test server now runs as NSSM service,
      survives RDP logoff and reboot, auto-restarts on crash. See DEPLOYMENT.md §8.
      Tested and verified: service is `SERVICE_RUNNING` after RDP disconnect.
- [ ] Set `NODE_ENV=production`, hostname-based `APP_ORIGIN`, and correct
      proxy-trust setting (`TRUST_PROXY=1`). Currently unset for HTTP-only test;
      will be set when TLS lands.
- [ ] **HTTPS on the production server (in progress, 2026-08-12).** Decision made:
      no reverse proxy — Node runs HTTPS directly, using an internal cert issued by
      SAFOS for `routeone-test.sbakels.net`. Both HTTP (4200) and HTTPS (4443) run
      simultaneously; dev stays HTTP-only. Status:
      - [x] Certificate placed on both laptop (`C:\Projects\RouteOne\RouteOne APP - Cert.crt`)
            and server (`C:\RouteOne\RouteOne APP - Cert.crt`).
      - [ ] **Blocked on the private key** from IT for that certificate — nothing else
            can proceed until it arrives.
      - [ ] Once the key arrives: add an `https.createServer()` listener alongside the
            existing `app.listen()` in `server/index.js` (port 4443), loading the cert +
            key from `C:\RouteOne\`.
      - [ ] Deploy and confirm `https://routeone-test.sbakels.net:4443` serves the app.
- [ ] **Post go-live cleanup once HTTPS is confirmed working:**
      - [ ] Remove the temporary `COOKIE_SECURE=0` line from the server's `.env` (added
            2026-08-12 as a stopgap — see below) so session cookies go back to `Secure`.
      - [ ] Set `NODE_ENV=production` (see item above) now that Secure cookies will work.
      - [ ] Re-test login end-to-end over HTTPS to confirm cookies persist correctly.
      - [ ] Re-test GPS pickup (check-in location, "Optimise Routes" starting point,
            live map). Browsers block `navigator.geolocation` on plain HTTP for any host
            other than `localhost` — this is almost certainly the cause of the rep-reported
            "can't pick up my location" issue, and should resolve once HTTPS is live.
- [ ] Put `BACKUP_DIR` on a protected volume separate from the app disk. Currently
      at `C:\RouteOne\server\backups` (1.15 GB database, ~6 GB backups at 14-day
      retention = growing problem). Run a full restore drill and document recovery time.
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
      — no multiple replicas sharing the same file. (NSSM service ensures this.)
- [x] **Monitoring & alerting setup documented, 2026-08-12.** See [MONITORING_SETUP.md](MONITORING_SETUP.md) for:
      - Health check every 5 minutes with auto-restart on 3 failures
      - Disk space alerts (warn at 50GB, critical at 20GB free)
      - Daily backup verification (alert if age > 48h or file missing)
      - Email alerts via M365/SMTP (to be configured in `.env`)
      - Log rotation and centralized view (Windows Event Viewer optional)
      - Incident escalation procedure (primary/secondary/manager handoff)
      - All tools built-in to Windows or freely available (no paid infrastructure)

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
