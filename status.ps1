# Check the RouteOne test server from the laptop.
# Everything here works over HTTP and the mapped Z: drive - there is no SSH to
# the server, so anything needing a shell has to be run in RDP.
#
# Usage: .\status.ps1

param(
    [string]$BaseUrl     = "http://192.168.0.22:4200",
    [string]$ServerDrive = "Z:"
)

function Log {
    param([string]$Message, [string]$Color = "White")
    Write-Host $Message -ForegroundColor $Color
}

Log "`n======================================" "Cyan"
Log "  RouteOne test server status" "Cyan"
Log "======================================`n" "Cyan"
Log "URL:   $BaseUrl"
Log "Drive: $ServerDrive`n"

# 1. Is the API up? /api/health needs no auth and hits the database.
Log "[1] API health" "Yellow"
try {
    $health = Invoke-WebRequest -Uri "$BaseUrl/api/health" -UseBasicParsing -TimeoutSec 5
    if ($health.StatusCode -eq 200 -and $health.Content -match '"ok"\s*:\s*true') {
        Log "  OK - API up, database responding" "Green"
    } else {
        Log "  WARN - HTTP $($health.StatusCode): $($health.Content)" "Yellow"
    }
} catch {
    Log "  DOWN - no response ($($_.Exception.Message))" "Red"
    Log "  Start it in RDP: cd C:\RouteOne; npm start" "Gray"
}

# 2. Is the built client being served? "Cannot GET /" means dist is missing.
Log "`n[2] Client build" "Yellow"
try {
    $root = Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing -TimeoutSec 5
    if ($root.Content -match '<title>') {
        Log "  OK - dist is being served" "Green"
    } else {
        Log "  WARN - unexpected response body" "Yellow"
    }
} catch {
    Log "  FAIL - '$($_.Exception.Message)'" "Red"
    Log "  If this is 'Cannot GET /', rebuild in RDP: cd C:\RouteOne; npm run build" "Gray"
}

# 3. Will a POST from this origin be accepted? GET is exempt from the origin
#    check, so the two above can pass while login still fails. Uses deliberately
#    invalid credentials - 401 means the origin was accepted and we reached the
#    password check, 403 means APP_ORIGIN does not list this origin.
Log "`n[3] Login origin ($BaseUrl)" "Yellow"
try {
    $null = Invoke-WebRequest -Uri "$BaseUrl/api/auth/login" -Method POST -UseBasicParsing -TimeoutSec 8 `
              -Headers @{ Origin = $BaseUrl } -ContentType "application/json" `
              -Body '{"email":"origin-check@example.invalid","password":"not-a-real-password"}'
    Log "  WARN - unexpected success from an invalid login" "Yellow"
} catch {
    $resp = $_.Exception.Response
    if (-not $resp) {
        Log "  No response: $($_.Exception.Message)" "Red"
    } elseif ([int]$resp.StatusCode -eq 401) {
        Log "  OK - origin accepted (401 on bad credentials, as expected)" "Green"
    } elseif ([int]$resp.StatusCode -eq 403) {
        Log "  BLOCKED - APP_ORIGIN does not list $BaseUrl" "Red"
        Log "  Login will fail with 'Cross-site request blocked' even though pages load." "Gray"
        Log "  Fix in the server's .env, then restart. Comma-separate multiple origins." "Gray"
    } else {
        Log "  Unexpected HTTP $([int]$resp.StatusCode)" "Yellow"
    }
}

# 4. Everything below needs the mapped drive.
Log "`n[4] Server files (via $ServerDrive)" "Yellow"
if (-not (Test-Path $ServerDrive)) {
    Log "  Drive not mapped - skipping file checks" "Yellow"
    Log "  net use Z: \\192.168.0.22\c`$\RouteOne /persistent:yes" "Gray"
} else {
    $dbPath = Join-Path $ServerDrive "server\data\fieldsales.db"
    if (Test-Path $dbPath) {
        $db = Get-Item $dbPath
        Log ("  Database: {0:N1} MB, modified {1:yyyy-MM-dd HH:mm}" -f ($db.Length / 1MB), $db.LastWriteTime) "Green"
    } else {
        Log "  Database not found at server\data\fieldsales.db" "Red"
    }

    $backupDir = Join-Path $ServerDrive "server\backups"
    if (Test-Path $backupDir) {
        $backups = @(Get-ChildItem $backupDir -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
        if ($backups.Count) {
            $age = (New-TimeSpan -Start $backups[0].LastWriteTime -End (Get-Date)).TotalHours
            $colour = if ($age -gt 48) { "Yellow" } else { "Green" }
            Log ("  Backups: {0}, newest {1:yyyy-MM-dd HH:mm} ({2:N0}h ago)" -f $backups.Count, $backups[0].LastWriteTime, $age) $colour
        } else {
            Log "  No backups yet - run 'npm run backup' in RDP" "Yellow"
        }
    }

    $distIndex = Join-Path $ServerDrive "dist\index.html"
    if (Test-Path $distIndex) {
        Log ("  Client build: {0:yyyy-MM-dd HH:mm}" -f (Get-Item $distIndex).LastWriteTime) "Green"
    } else {
        Log "  dist\index.html missing - run 'npm run build' in RDP" "Red"
    }

    $envFile = Join-Path $ServerDrive ".env"
    if (Test-Path $envFile) {
        $keys = (Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Z_]+=' } |
                 ForEach-Object { ($_ -split '=')[0].Trim() }) -join ', '
        Log "  .env keys: $keys" "Green"
        if ($keys -notmatch 'APP_ORIGIN') {
            Log "  WARN - no APP_ORIGIN; login will fail with 'Cross-site request blocked'" "Yellow"
        }
        # Missing SECRET_KEY does not stop the app - crypto.js falls back to a
        # hardcoded key with only a console warning - but the stored SYSPRO and
        # SMTP passwords were encrypted with the real one and stop decrypting.
        if ($keys -notmatch 'SECRET_KEY') {
            Log "  CRITICAL - no SECRET_KEY. The app still starts on a fallback key," "Red"
            Log "  but stored SYSPRO/SMTP passwords will no longer decrypt." "Red"
            Log "  Restore it, then verify via Settings -> Integration -> Test connection." "Gray"
        }
    } else {
        Log "  .env missing" "Red"
    }
}

Log "`nIn RDP on the server:" "Gray"
Log "  & C:\nssm\nssm-2.24\win64\nssm.exe restart RouteOne   # restart the service" "Gray"
Log "  cd C:\RouteOne; npm run backup                        # snapshot before risky changes" "Gray"
Log "  cd C:\Projects\RouteOne; .\deploy.bat   # (laptop) push code" "Gray"
Log ""
