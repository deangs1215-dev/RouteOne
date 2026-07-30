# Deploy RouteOne - Sync local to server Z:\ and restart
# Usage: .\deploy.ps1

param(
    [string]$LocalPath = "C:\Projects\RouteOne",
    [string]$ServerDrive = "Z:",
    [switch]$DryRun = $false
)

$ErrorActionPreference = "Stop"

function Log {
    param([string]$Message, [string]$Color = "White")
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message" -ForegroundColor $Color
}

Log "`n========================================" "Cyan"
Log "  RouteOne Deploy - Sync & Restart" "Cyan"
Log "========================================`n" "Cyan"

# Verify paths
if (!(Test-Path $LocalPath)) {
    Log "ERROR: Local path not found: $LocalPath" "Red"
    exit 1
}

if (!(Test-Path $ServerDrive)) {
    Log "ERROR: Server drive not found: $ServerDrive" "Red"
    Log "Make sure Z:\ is mapped to your server" "Yellow"
    exit 1
}

Log "Local:  $LocalPath" "White"
Log "Server: $ServerDrive" "White"
if ($DryRun) {
    Log "Mode:   DRY RUN (preview only)" "Yellow"
} else {
    Log "Mode:   LIVE SYNC" "White"
}
Log ""

# Sync files using robocopy
Log "[1] Syncing changed files..." "Cyan"

# Never sync server-owned state: the live database, its backups, uploaded
# files, or the server's own .env (which holds APP_ORIGIN and secrets).
# /R:1 /W:1 fails fast on a locked file instead of retrying for hours.
$robocopyArgs = @(
    $LocalPath,
    $ServerDrive,
    "/E",
    "/XO",
    "/XD", "node_modules",
    "/XD", ".git",
    "/XD", ".next",
    "/XD", "dist",
    "/XD", "build",
    "/XD", "graphify-out",
    "/XD", (Join-Path $LocalPath "server\data"),
    "/XD", (Join-Path $LocalPath "server\backups"),
    "/XD", (Join-Path $LocalPath "server\uploads"),
    "/XF", ".env", ".env.local", ".env.production",
    "/XF", "*.db", "*.db-shm", "*.db-wal",
    "/R:1", "/W:1",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS"
)

if ($DryRun) {
    $robocopyArgs += "/L"
    Log "Preview mode - showing what would be copied:`n" "Yellow"
}

# Run robocopy
$output = & robocopy @robocopyArgs 2>&1
$copiedCount = 0
$output | ForEach-Object {
    if ($_ -match "^\s*$") { return }
    $copiedCount++
    if ($DryRun) { Log "  $_" "Gray" }
}

if ($copiedCount -gt 0) {
    Log "OK: Synced $copiedCount file(s)" "Green"
} else {
    Log "OK: Already up to date (0 files to copy)" "Green"
}

if ($DryRun) {
    Log "`nOK: Dry run complete - no files were actually copied" "Yellow"
    Log "Run without -DryRun to deploy: .\deploy.ps1" "Cyan"
    exit 0
}

# Restart the app
Log "`n[2] Restarting app on server..." "Cyan"

Log "NEXT: You need to restart npm on the server:" "Yellow"
Log "`n  1. RDP into the server" "White"
Log "  2. Stop the app: npm stop  (or Ctrl+C in the terminal)" "White"
Log "  3. Start it: npm start" "White"
Log "`n  Server path: Z:\ (C:\OneRoute\RouteOne on server)" "Gray"

# Try to check if app is responding
Log "`n[3] Checking app status..." "Cyan"
Start-Sleep -Seconds 2
try {
    $response = Invoke-WebRequest -Uri "http://routeone-test.sbakels.net:4200/api/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
    if ($response.StatusCode -eq 200) {
        Log "OK: App is already responding - may not need restart" "Green"
    }
} catch {
    Log "WARN: App not responding - it may need to be restarted" "Yellow"
}

Log "`n========================================" "Green"
Log "  OK: Files synced successfully!" "Green"
Log "========================================`n" "Green"

Log "Test in browser: http://routeone-test.sbakels.net:4200" "Cyan"
Log "`nTip: Next time, just run .\deploy.ps1 (no -DryRun)" "Gray"
