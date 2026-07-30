# RouteOne — Test Server Quick Reference

Day-to-day commands for the Windows test server. For a first-time production
install see `DEPLOYMENT.md`.

## The two machines

| | Path | Role |
|---|---|---|
| **Laptop** | `C:\Projects\RouteOne` | Edit code. Run `deploy.bat`. Nothing else. |
| **Server** | `C:\RouteOne` | Runs the app. Owns the database, `.env`, uploads, backups. |

Reached by **RDP**, not SSH. Served at
**http://routeone-test.sbakels.net:4200** (DNS A record → `192.168.0.22`); the
IP works too.

Both need to be listed in `APP_ORIGIN` on the server, comma-separated, or POST
requests from the un-listed one are rejected as "Cross-site request blocked".
GET is exempt from that check, so a page can load fine and still fail at login.
Put the hostname **first** — the first entry is the canonical origin used to
build password-reset links.

`Z:\` on the laptop is a mapped network drive to the server's app folder.
Re-map it after a server restart with:

```powershell
net use Z: \\192.168.0.22\c$\RouteOne /persistent:yes
```

---

## Deploy a code change

**On the laptop:**

```powershell
cd C:\Projects\RouteOne
.\deploy.bat
```

Preview what would copy without copying it:

```powershell
.\deploy.ps1 -DryRun
```

**Then on the server (RDP), restart the app:**

```powershell
& C:\nssm\nssm-2.24\win64\nssm.exe restart RouteOne
```

If it's not yet installed as a service (see `DEPLOYMENT.md` §8 to set that up):
Ctrl+C in the `npm start` window, then `npm start` again. A manually-started
app dies when the RDP session logs off — the service does not.

### What deploy does and does not copy

Copies source, `package.json`, docs. **Never** copies:

- `server\data` — the live database
- `server\backups`, `server\uploads`
- `.env` — the server has its own, with `APP_ORIGIN` and `SECRET_KEY`
- `node_modules`, `.git`, `dist`, `build`, `graphify-out`

If you change dependencies, run `npm install` on the server after deploying.
If you change anything under `client\`, run `npm run build` on the server —
`dist` is not copied and the API serves the built client from there.

---

## Server operations

All of these run **on the server**, from `C:\RouteOne`.

```powershell
npm start            # start the app
npm run build        # rebuild the client into dist\ after a UI change
npm install          # after a dependency change
npm run backup       # snapshot the database + uploads before anything risky
npm test             # run the test suite
```

Check it is listening:

```powershell
netstat -an | findstr 4200
```

---

## Editing `.env` on the server

**Do not `notepad .env` and retype a line.** Select-all-and-paste in Notepad
silently replaces the whole file — that's exactly how `SECRET_KEY` went missing
during setup. Add or update one key at a time instead:

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

# Example:
Set-EnvValue C:\RouteOne\.env "APP_ORIGIN" "http://routeone-test.sbakels.net:4200,http://192.168.0.22:4200"
```

Then always confirm with a **keys-only** listing — never `cat .env` on a value
you don't want in shell scrollback:

```powershell
Get-Content C:\RouteOne\.env | ForEach-Object { ($_ -split '=')[0] }
```

Restart the app after any `.env` change — it's only read at startup.

---

## Diagnostics

Read-only scripts, all run on the server from `C:\RouteOne`.

```powershell
node server\diagnose-unmatched.js   # why customers have no rep, by category
node server\list-orphan-reps.js     # rep codes owning customers but with no login
```

`diagnose-unmatched.js` splits unassigned customers into `NO_REP_CODE`,
`NO_SUCH_REP` (expected for house/export accounts excluded by
`import-reps.js`) and `BRANCH_MISMATCH`.

`list-orphan-reps.js` lists rep codes that own customers but have no RouteOne
login and were never deliberately excluded — with an `in_vw_FS_Reps` column
showing whether re-running the rep import would create them.

---

## Admin tasks

```powershell
node server\import-reps.js --dry    # preview rep accounts from vw_FS_Reps
node server\import-reps.js          # create them (skips codes that already exist)
node server\reset-password.js <email> [--force-change]
```

`import-reps.js` is safe to re-run — it skips any `rep_code` that already has a
user. Temporary passwords are printed once and are not recoverable afterwards.

`reset-password.js` prompts twice, hidden, and enforces the same strength rules
as the app.

---

## Rep ↔ customer assignment

Three mechanisms, in order of when they apply:

1. **`import-reps.js`** creates one rep user per `rep_code`, with a single home
   warehouse.
2. **Customers sync** assigns `rep_id` on every run — SYSPRO is master for rep
   ownership, so a reassignment there follows through to the app. A failed
   match leaves the existing rep in place rather than clearing it.
3. **Integration → Sync rep** backfills customers still without a rep. Fills
   nulls only, so it is always safe to re-run.

A customer stays unassigned when its rep code has no active user (house and
export accounts, deliberately) or when the customer's branch differs from its
rep's home branch. Run the diagnostics above to see which.

---

## Troubleshooting

**"Cross-site request blocked" on login** — `APP_ORIGIN` in the server's `.env`
does not match how the browser reaches the app. It must include scheme and port
exactly: `http://192.168.0.22:4200`. Restart after changing it.

**Login succeeds then bounces back to the login screen** — `NODE_ENV=production`
on plain HTTP. The session cookie is issued `Secure` and the browser discards
it. Set `COOKIE_SECURE=0`, or unset `NODE_ENV`.

**"Cannot GET /"** — `dist` is missing or stale. Run `npm run build` on the
server; `deploy.bat` does not copy it.

**"Cannot find module 'dotenv'"** — `node_modules` missing after a move. Run
`npm install` on the server.

**Test connection says `source: demo`** — the Data source dropdown on the
Integration page is still set to *Demo data*. Change it to *SYSPRO SQL Server*.
A "success" against demo proves nothing about SQL Server.

**Test connection fails on authentication** — the stored SYSPRO password was
encrypted with a different `SECRET_KEY` than the one now in `.env`. Retype the
password in Settings → Integration and save; it re-encrypts under the current
key.

**robocopy retries forever on a locked file** — something is holding the file.
`deploy.bat` uses `/R:1 /W:1` so it fails fast rather than retrying; if you see
long retry loops, you are running an older copy of the script.

---

## Before anything risky

```powershell
cd C:\RouteOne
npm run backup
```

Backups land in `server\backups\` (or `BACKUP_DIR` if set). The scheduler also
takes one automatically — default 02:00, 14-day retention, configurable under
Settings → Backups.
