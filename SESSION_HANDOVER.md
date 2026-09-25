# Session Handover — 2026-08-13

Most recent session at the top. Earlier handovers are kept below as history —
they still hold the definitive deployment/`.env`/diagnostics reference.

---

## Session Summary (2026-08-13 — continued)

Morning: call-cycle import redesign, call-cycle viewer, sync batching fix.
Afternoon: found and fixed two more bugs (scheduler gate, vw_FS_Reps), set up rep onboarding.

### 1. Call-cycle bulk import — redesigned ✅ deployed and tested

- `client/src/components/CycleImportModal.jsx` — rep selector and start date are
  now fields at the top of the modal; the paste box takes only the Week 1–8
  account-number grid. Parsing is live (no separate Preview step).
- The parser handles the real sheet format: `Week N` and the `Monday…Friday`
  header on *separate* lines, ragged columns, and the stray formula-bar text
  Excel puts on the first line.
- `server/routes/cycles.routes.js` — `rep_code` is now taken from the selected
  rep's own record rather than a manual field.

### 2. Call-cycle viewer — new ✅ deployed and tested

- `GET /api/route-cycles/upcoming` — projects the abstract Week 1–8 pattern onto
  real calendar dates, 6 weeks ahead. Reuses the date math from
  `/route-compliance`. Reps are locked to their own cycle server-side.
  **Registered above `/route-cycles/:id`** — Express would otherwise match
  "upcoming" as the `:id` param.
- `client/src/components/CallCycleModal.jsx` — "Call cycle" button on Visits.
- `client/src/mobile/MyCycle.jsx` — "My call cycle" card on the mobile home
  screen, wired into both light and dark Today screens.
- "Import call cycle" is now hidden from reps (they only ever got a 403).

### 3. Hourly app freeze — diagnosed and fixed ✅ committed

**Symptom:** app hung on "loading" for users; `health check failed 3 times`
alerts every hour. The alerts were *true positives*.

**Root cause:** the SYSPRO sync re-imported all ~4.3M `customer_pricing` rows
every hour inside a single synchronous SQLite transaction. `better-sqlite3` runs
on the main thread, so the whole Node process froze for ~20 min/hour — no HTTP,
no health endpoint. Evidence: failures clustered at :30–:48 past every hour,
`service.log` showed identical `customer_pricing 4301675/4301675` each run, and
the DB file mtime matched the exact moment health checks recovered.

**Fix** (`server/integration/sync.js`):
- Writes now go in 2,000-row batches, yielding to the event loop between each.
- `rep_sales` (and anything else in `CLEAR_BEFORE_SYNC`) deliberately stays in
  one atomic transaction — it wipes its table first, so a batched run would let
  a reader see half-summed totals.
- New `[sync]` log line splits **fetch time vs write time** per entity.
- Batch size overridable via `SYNC_BATCH_SIZE` env — no redeploy needed to tune.

Measured on the real code path, 300k rows: event-loop turns went from **2 → 148**,
worst stall 312ms, all rows persisted, no duplicates on re-sync. Batch size was
chosen from a measured sweep (see the comment above `BATCH_SIZE`) — small
batches cost very little throughput because per-row upsert work dominates.

### 4. Scheduler gate logic — fixed ✅ committed

**Symptom:** `customer_pricing` sync was running at :30 past every hour despite
being set to daily 02:00. The setting *appeared* to work in the UI.

**Root cause:** `server/integration/scheduler.js` had a trigger string
comparison `trigger === 'schedule'`, but the scheduler calls `runAll()` with
`'scheduled'` (past tense). So every tick matched as a manual run and synced
*all* entities regardless of their per-entity schedule settings.

**Fix:** Changed to `trigger !== 'manual'` to correctly gate scheduled-only
entities. Verified: scheduled runs now respect per-entity settings, manual runs
still sync everything, and excludes (like `CLEAR_BEFORE_SYNC`) still work.

### 5. Rep onboarding — whitelist implemented ✅ committed

**Problem:** `vw_FS_Reps` returned 85 rows (every salesperson record: countries,
export desks, house accounts, write-off buckets). The old `EXCLUDE_CODES` block
list had 31 entries, so `import-reps.js` would silently create 54 junk accounts
for "LEGALS WRITE-OFF", "SHOPRITE CT", "BAKELS INDIA", etc.

**Discovery:** codes 101 and 111 each carry two real people (Joseph Shabangu /
Siyabonga Sigwili, Nasief Isaac / Bernice Molokwe), but the view's old
`MAX(Name)` alphabetical tie-breaker picked the wrong person for each. RouteOne
had one account per code under the wrong name.

**vw_FS_Reps fix** (`docs/sql/vw_FS_Reps.sql`):
- Old view was driven `FROM vw_FS_Customers` and required customers invoiced in
  the last 35 days. New rep with no customers never appeared.
- New view is driven `FROM SalSalesperson` (the actual master list), matches
  customers on **code + branch** (both are required for uniqueness), and keeps
  the 35-day filter in the `LEFT JOIN` so it still governs what gets counted
  without dropping the rep's row. New reps appear with `active_customers = 0`.
- Fixes the name collision by joining on branch: each person's record now gets
  their actual name, not an alphabetical accident.

**Rep whitelist** (`server/import-reps.js`):
- Replaced `EXCLUDE_CODES` (block list, 31 entries) with `REP_CODES` (allow list,
  44 entries). Built from the business's live-rep report (2026-08-13), verified
  against RouteOne's 41 existing users.
- An unknown code now produces **no account** (safe failure) rather than
  silently becoming a login (dangerous).
- Added `--only <codes>` flag for targeted onboarding (e.g. `--only 81` to
  create just James) without curating all 44 first.
- `server/list-orphan-reps.js` updated to match.

**Result:** 3 reps created — James (code 81, 593 customers), Bongani (code 94,
101 customers), Vallerie Klue (code 123, 0 customers). All at warehouse 01, all
`active = 1`, all flagged `must_change_password` for first login.

### 6. Correction: the database is SQLite, not SQL Server

`CLAUDE.md` states Microsoft SQL Server. That is **wrong** for RouteOne's own
data, which lives in SQLite (`better-sqlite3`) at `server/data/fieldsales.db`,
now 1.19 GB. `mssql` is only the read connection *into* SYSPRO. This matters for
backups, disk planning, and the whole class of performance issue above.
`CLAUDE.md` has not been corrected yet.

### Correction: the database is SQLite, not SQL Server

`CLAUDE.md` states Microsoft SQL Server. That is **wrong** for RouteOne's own
data, which lives in SQLite (`better-sqlite3`) at `server/data/fieldsales.db`,
now 1.19 GB. `mssql` is only the read connection *into* SYSPRO. This matters for
backups, disk planning, and the whole class of performance issue above.
`CLAUDE.md` has not been corrected yet.

---

## Outstanding (2026-08-13 end of session)

### Immediate (affects testing tomorrow)

1. **HTTPS setup** — RouteOne is HTTP-only. For testing with two reps, at least
   a self-signed cert and reverse proxy (IIS or nginx) are needed. Choose the
   server config, get or generate the cert, and wire it up.
2. **Verify the three new rep accounts** — James, Bongani, Vallerie Klue can
   all log in with their one-time passwords and see their customers attached
   (via the next customer sync).
3. **Deactivate Valerie (code 48)** — was created before we knew she'd left.
   She has 0 customers so no data is stranded, but mark her `active = 0` in the
   app (Users → Valerie → inactive).

### Next session / testing phase

4. **Codes 101 and 111 carry two people each** — the importer skips a code the
   moment anyone holds it, so the second person (Joseph Shabangu, Bernice Molokwe)
   can never get an account. Fix requires keying the existence check on code+branch
   rather than code alone. `matchRep` already supports this (warehouse+code).
5. **Read the new `[sync]` timings** in `service.log` after the first full nightly
   run post-deployment. If *fetch* dominates (should be ~33s now), the DBA fix is
   incremental sync (a last-modified column on the SYSPRO view). If *write*
   dominates, lower `SYNC_BATCH_SIZE`. `health-monitor.log` should stop showing
   the hourly :30–:48 timeout cluster.
6. **Confirm `customer_pricing` is daily 02:00** on the Integration page.

### Debt

7. **Bound the `errors` array in `runSync`** — it collects one string per failing
   row with no cap; a systematic failure across 4.3M rows is an OOM risk. Only
   the first 10 are ever used. (Pre-existing, not a regression.)
8. **Fix `CLAUDE.md`** — change the database line from SQL Server to SQLite.
9. **IT handover doc** — was given verbally in chat only, never written to a
   file, and contained the SQL Server error. Needs redoing properly.
10. **Wire the Technical recipient list into form notifications** — currently
    only the single `technical_email` setting is used.

**Nothing from this session is committed** — all of the above is uncommitted
working-tree changes.

## Closed since the 2026-07-31 handover

- **Monitoring/alerting** (was "Before production" item 5) — done. Health check
  every 5 min, disk and backup checks daily, SMTP alerts. Settings → Monitoring
  page added. Scripts are ASCII-only for PowerShell 5.1.
- **Backup retention** reduced 14 days → 7.
- **Deploy scripts were never building or syncing the client** — `deploy.bat`
  and `deploy.ps1` now run `npm run build` and mirror `dist/` with `/MIR`. This
  is why client changes appeared to vanish on the server.
- **Orders vs Technical email recipients** shared one list — `email_recipients`
  now has a `category` column and the two lists are independent.

---
---

# Session Handover — 2026-07-31

This document captures the state of the RouteOne test server and deployment workflow as of the end of the 2026-07-31 session. Use this to orient the next session.

> Superseded where it conflicts with the 2026-08-13 section above — notably the
> database size, backup retention (now 7 days), and the monitoring item.

---

## Session Summary

**Goal:** Get the test server deployable and stable (it's holding real customer data but was behaving like a dev box).

**Key Accomplishments:**

1. **Security hardening**: `SECRET_KEY` now unconditionally required; app throws at startup if missing instead of silently falling back to insecure hardcoded key. Fixes a failure mode where missing key was discovered days later when SYSPRO auth broke.

2. **Service management**: Test server now runs as NSSM Windows service. Survives RDP logoff, reboots, and auto-restarts on crash. Tested and verified working.

3. **Deployment tooling**: `deploy.bat`, `deploy.ps1`, `status.ps1`, `backup-db.ps1` — scripts that work over the mapped `Z:` drive (no SSH), with robocopy exclusions that protect the live database and uploads.

4. **Diagnostics**: `server/diagnose-unmatched.js`, `server/list-orphan-reps.js`, `server/reset-password.js` — admin utilities for customer assignment, rep account discovery, and password recovery.

5. **Documentation rewrite**: DEPLOYMENT.md (§8 NSSM walkthrough, §9 HTTP-only gotchas), QUICK_REFERENCE.md (day-to-day workflow), .env.example (clarified SECRET_KEY is always required).

6. **Git**: Everything from this session committed in commit `8284944`.

---

## Current Deployment State

**Server:** Windows Server, `C:\RouteOne`, reachable at:
- Hostname: `http://routeone-test.sbakels.net:4200` (DNS A record → `192.168.0.22`)
- IP: `http://192.168.0.22:4200`
- Access: RDP only (not SSH)

**Running as:** NSSM Windows service named `RouteOne`
- Status: `SERVICE_RUNNING` (verified 2026-07-31 after RDP disconnect)
- Restart: `nssm restart RouteOne` (from any PowerShell window on server)
- Logs: `C:\RouteOne\server\logs\service.log` and `.service-error.log` (rotated at 10MB)

**App config:** `.env` on server has:
- `SECRET_KEY` = present (restored from laptop)
- `APP_ORIGIN` = `http://routeone-test.sbakels.net:4200,http://192.168.0.22:4200` (hostname first, IP second)
- `NODE_ENV` = unset (intentional for plain HTTP; will be `production` when TLS lands)
- `COOKIE_SECURE` = unset (app defaults to secure-only in production mode, but we're on plain HTTP so unset is correct)

**Database:** SQLite at `C:\RouteOne\server\data\fieldsales.db`
- Size: 1.15 GB (real customer data from SYSPRO)
- Backups: 7 snapshots, newest 2026-07-30 03:31 (12+ hours old at session end; schedule needs checking)
- Sync status: Last run before session was ✓ 0 newly assigned, 0 already had a rep, 13889 had no matching rep code/branch

**Laptop:** Code at `C:\Projects\RouteOne`
- `deploy.bat` syncs code via robocopy to `Z:\` (mapped to server)
- Excludes: `node_modules`, `.git`, `dist`, `build`, `server/data`, `server/backups`, `server/uploads`, `.env*`, `*.db*`
- Deploy process: laptop runs `deploy.bat` → server restarts service with `nssm restart RouteOne`

---

## Critical Files to Know

| File | Purpose | On Laptop | On Server |
|------|---------|-----------|-----------|
| `.env` | Secrets, origin | Keep safe, never overwrite; use `Set-EnvValue` helper to edit | Owned by server; has real `SECRET_KEY` |
| `server/data/fieldsales.db` | Live database | Excluded from sync | Never overwrite; back up before risky changes |
| `server/backups/` | Backup snapshots | `backup-db.ps1` pulls to `C:\RouteOne_Backups` | Auto-created by `npm run backup` |
| `DEPLOYMENT.md` | Deployment guide | Definitive; rewritten 2026-07-31 | Reference |
| `QUICK_REFERENCE.md` | Day-to-day commands | Definitive | Reference |

---

## What's Still Open

### Immediate (affects testing)
- **Backup schedule stale?** Newest backup is 12+ hours old at session end. Check whether the scheduled task is running (Settings → Backups).
- **Orphan reps (125–267 unassigned customers):** Run `node server/list-orphan-reps.js` on server. Identify which rep codes should be in `EXCLUDE_CODES` (house accounts, export desks) vs. which need business-side clarification. Reps 94 and 13 specifically need a decision.
- **Password reset not exercised:** The bug fix for password-reset links (extracts first origin from comma-separated `APP_ORIGIN`) hasn't been end-to-end tested. Send a real forgot-password email when time allows.

### Before production (from the 2026-07-26 audit)
1. **TLS + reverse proxy:** RouteOne is still HTTP-only. For production, pick a reverse proxy (nginx recommended), get a self-signed cert for internal VPN, and re-run with `NODE_ENV=production` + `COOKIE_SECURE` set (or unset, app default is correct).
2. **Move backups off app disk:** Currently `C:\RouteOne\server\backups`; at 1.15 GB database + 6 GB backups (14-day retention), this will fill the app disk. Set `BACKUP_DIR` to a protected separate volume.
3. **User password changes:** 43 existing users (from seed) have not been forced to change their passwords. The gate works but is only triggered on login; ensure all users hit it before broad access.
4. **SYSPRO read-only account:** Currently using developer credentials (likely with write access). Create a least-privileged read-only SQL login for production.
5. **Monitoring/alerting:** No log collection, uptime checks, or alerts yet. Set these up before going live.

---

## How to Continue

### Deploy a code change
1. **Laptop:** `cd C:\Projects\RouteOne && .\deploy.bat`
2. **Server (RDP):** `nssm restart RouteOne`
3. **Verify:** Run `.\status.ps1 -BaseUrl "http://routeone-test.sbakels.net:4200"` from laptop (checks API health, client build, origin acceptance, .env keys including SECRET_KEY)

### Edit `.env` safely
**Never use Notepad.** Copy-paste in Notepad replaces the whole file silently. Instead, on the server:

```powershell
function Set-EnvValue($Path, $Key, $Value) {
    $lines = @(Get-Content $Path -ErrorAction SilentlyContinue)
    $pattern = "^$([regex]::Escape($Key))="
    if ($lines -match $pattern) {
        $lines = $lines | ForEach-Object { if ($_ -match $pattern) { "$Key=$Value" } else { $_ } }
    } else {
        $lines += "$Key=$Value"
    }
    Set-Content -Path $Path -Value $lines -Encoding UTF8
}

Set-EnvValue C:\RouteOne\.env "APP_ORIGIN" "http://new-origin:4200"
Get-Content C:\RouteOne\.env | ForEach-Object { ($_ -split '=')[0] }  # verify
```

### Restart the service
```powershell
& C:\nssm\nssm-2.24\win64\nssm.exe restart RouteOne
```

### Check service health
```powershell
& C:\nssm\nssm-2.24\win64\nssm.exe status RouteOne
Get-Content C:\RouteOne\server\logs\service-error.log -Tail 30
```

### Run diagnostics on server
```bash
cd C:\RouteOne
node server/diagnose-unmatched.js    # customer assignment gaps
node server/list-orphan-reps.js      # rep codes with no login
node server/reset-password.js <email>  # password recovery
npm run backup                        # snapshot database
```

---

## Key Decisions Made This Session

See DECISIONS.md for full rationale on each. Summary:

1. **SECRET_KEY unconditionally required** — no insecure fallback, ever. Fails loud and immediate, not silent.
2. **NSSM Windows service** — app survives RDP logoff and reboot; auto-restarts on crash.
3. **Hostname-first in APP_ORIGIN** — password-reset links use the first origin in comma-separated list.

---

## Architectural Notes

- **SYSPRO is master system:** RouteOne reads from SYSPRO SQL views, never writes back. All pricing, customer, stock data originates there.
- **Rep ownership is SYSPRO-master:** `server/integration/sync.js` uses `COALESCE` to update rep on every sync — failed matches don't wipe existing rep, but successful matches flow through from SYSPRO.
- **Excludes:** Certain rep codes (house accounts, export desks, inter-company) are in `EXCLUDE_CODES` in `server/import-reps.js` and are never assigned customers. ~125 unassigned customers still need categorization.

---

## Memory Files

Updated for this session:
- `memory/deployment-topology.md` — Windows/RDP topology, NSSM service setup, safe .env editing
- `memory/project_naming.md` — product is "RouteOne" (not "OneRoute")
- `memory/SYSPRO-rep-ownership.md` — rep assignment is SYSPRO-master, not app-managed

---

## Next Session Checklist

- [ ] Run `status.ps1` to confirm service is up
- [ ] Check backup age (Settings → Backups); if > 48h, run `npm run backup` manually
- [ ] Run `list-orphan-reps.js` and categorize the unassigned customers
- [ ] Test password reset flow end-to-end (use a test account)
- [ ] Review the unreleased work (Documents, Tasks phase 2/3, invoices, email/settings admin) and decide on next commit
- [ ] Design the TLS/reverse proxy plan (nginx + self-signed cert) if production is imminent

---

End of handover. Questions? Check DEPLOYMENT.md, QUICK_REFERENCE.md, or run a diagnostics script.
