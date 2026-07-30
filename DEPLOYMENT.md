# Deployment (manual copy)

Steps for copying this folder to the hosted server and bringing it up as a
production instance. See TODO.md for the fuller pre-production checklist this
summarizes the mechanical parts of.

## 1. What to copy

Copy everything **except**:

- `node_modules/` — reinstall on the server instead (native modules like
  `better-sqlite3` need to build for that machine).
- `server/data/` — this is the dev database. It has test accounts (including
  an admin password changed during this session) and test orders/customers.
  Let production start with a clean database.
- `server/uploads/` — dev test files (photos, PDFs, test documents).
- `server/backups/` — dev backup snapshots, some 1GB+.
- `.env` — dev secrets. Create a new one on the server (step 3).
- `dist/` — rebuild on the server (step 2), don't copy a stale build.

## 2. On the server

```bash
npm install
npm run build          # builds client/ into dist/, served by the API in production
```

## 3. Create `.env`

Copy `.env.example` to `.env` and fill in real values:

```
SECRET_KEY=<generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
NODE_ENV=production
APP_ORIGIN=https://<your-real-domain>
API_PORT=4200
TRUST_PROXY=1                      # only if directly behind one trusted reverse proxy
BACKUP_DIR=<separate disk/volume>  # keep off the app disk
BACKUP_RETENTION_DAYS=14
```

`SECRET_KEY` is required in production — the app refuses to start without it
(it encrypts the SMTP/SYSPRO passwords stored in the database). Losing it
means those stored passwords can't be decrypted and must be re-entered.

## 4. First run

```bash
npm run seed       # ONLY if you want demo data — skip this for a real deployment
npm start
```

Without seeding, the database is empty on first start. Log in isn't possible
until at least one admin user exists — either seed, or insert one directly
(ask me to script this if you'd rather not seed the demo data).

## 5. Reconfigure integrations (fresh database = fresh settings)

Since `server/data/` wasn't copied, these need to be re-entered through the
app itself, not restored from the old database:

- **Settings → Email Settings**: SMTP or Microsoft 365 credentials, from/order
  addresses, recipient list.
- **Settings → Integration**: SYSPRO SQL connection (host, port, credentials),
  and tick **"Trust an internal server certificate"** if SYSPRO's SQL Server
  presents a self-signed cert (it does on the `192.168.0.53` server used
  during development).
- **Settings → Backups**: schedule (it defaults on, 02:00, 14-day retention —
  confirm that's what you want).

## 6. Reverse proxy / TLS

Terminate HTTPS at a reverse proxy (nginx/IIS/Caddy) in front of `API_PORT`.
Confirm the session cookie arrives with the `Secure` flag once TLS is live —
`NODE_ENV=production` is what enables that.

## 7. Verify

- `GET /api/health` responds.
- Log in as the admin account you created.
- Force-through the "must change password" gate if you seeded demo users.
- Confirm a manual backup runs (Settings → Backups → "Run backup now").
- Send a test email (Settings → Email Settings → "Send test email").
- Run a manual SYSPRO sync from Settings → Integration and confirm it connects.

## 8. Keep it running (Windows)

`npm start` in an RDP window dies when that session logs off. Two ways to keep
the app up across logoff and reboot — pick one.

### Option A — NSSM (recommended)

[NSSM](https://nssm.cc/download) wraps any executable as a real Windows service,
so it starts at boot with no one logged in, and restarts on crash.

Confirm the Node path first — a wrong path is the most common reason a service
silently fails to start:

```powershell
(Get-Command node).Source
```

Download and extract (no admin needed for this part):

```powershell
$nssmDir = "C:\nssm"
New-Item -ItemType Directory -Path $nssmDir -Force | Out-Null
Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile "$nssmDir\nssm.zip"
Expand-Archive -Path "$nssmDir\nssm.zip" -DestinationPath $nssmDir -Force
$nssmExe = "$nssmDir\nssm-2.24\win64\nssm.exe"
Test-Path $nssmExe   # must print True before continuing
```

Register the service — **elevated PowerShell** required from here on:

```powershell
New-Item -ItemType Directory -Path C:\RouteOne\server\logs -Force | Out-Null

$nssm = "C:\nssm\nssm-2.24\win64\nssm.exe"
$node = "C:\Program Files\nodejs\node.exe"   # from the Get-Command output above

& $nssm install RouteOne $node "--use-system-ca server\index.js"
& $nssm set RouteOne AppDirectory "C:\RouteOne"
& $nssm set RouteOne AppStdout "C:\RouteOne\server\logs\service.log"
& $nssm set RouteOne AppStderr "C:\RouteOne\server\logs\service-error.log"
& $nssm set RouteOne AppRotateFiles 1
& $nssm set RouteOne AppRotateBytes 10485760   # cap each log at 10MB
& $nssm set RouteOne Start SERVICE_AUTO_START
& $nssm set RouteOne AppExit Default Restart   # restart on crash
```

Stop any manually-running `npm start` (Ctrl+C in that window), then:

```powershell
& $nssm start RouteOne
& $nssm status RouteOne          # expect SERVICE_RUNNING
netstat -an | findstr 4200       # confirm it's listening
```

Prove it survives logoff: disconnect the RDP session entirely (not minimize),
then re-run `status.ps1` from the laptop. It should still be green.

Redeploy restart, from now on:

```powershell
& $nssm restart RouteOne
```

If it won't start, the logs are the first place to look:

```powershell
& $nssm status RouteOne
Get-Content C:\RouteOne\server\logs\service-error.log -Tail 30
```

The two most likely causes: `SECRET_KEY` missing from `.env` (now a hard,
visible startup failure by design — see `server/crypto.js`), or a wrong Node
path above.

### Option B — Task Scheduler (no download)

Built into Windows. Less robust (no crash restart), but adequate for a test box.

```powershell
# Elevated PowerShell
$action  = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
             -Argument "--use-system-ca server\index.js" -WorkingDirectory "C:\RouteOne"
$trigger = New-ScheduledTaskTrigger -AtStartup
$set     = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName RouteOne -Action $action -Trigger $trigger `
  -Settings $set -User "SYSTEM" -RunLevel Highest
Start-ScheduledTask -TaskName RouteOne
```

Restart after a deploy with `Restart-ScheduledTask -TaskName RouteOne`.

### Either way

- The account running the service needs read/write on `C:\RouteOne\server\data`,
  `server\uploads` and the backup directory.
- It also needs network access to the SYSPRO SQL Server. `SYSTEM` authenticates
  as the machine account — if SYSPRO uses Windows auth rather than a SQL login,
  run the service as a domain account instead.
- Confirm the port is reachable after a reboot: `netstat -an | findstr 4200`.

## 9. HTTP-only test servers

If the box has no TLS in front of it (plain `http://<ip>:4200`), leave
`NODE_ENV` unset, or set `COOKIE_SECURE=0` explicitly. With
`NODE_ENV=production` on plain HTTP the session cookie is issued `Secure`, the
browser discards it, and login appears to succeed then immediately bounces back
to the login screen. See the comment at the top of `server/auth.js`.

`APP_ORIGIN` must match exactly how the browser reaches the app, scheme and port
included — `http://192.168.0.22:4200`, not the hostname, if that is what people
type. A mismatch shows as **"Cross-site request blocked"** on login.

## Not covered here

Monitoring/alerting and the DBA-side SQL Server work are still open per TODO.md.
