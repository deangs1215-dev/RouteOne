# Stop and restart the RouteOne Windows service (NSSM).
# Run this ON THE SERVER, in an ELEVATED PowerShell (RDP session) - NSSM
# service control isn't reachable from the laptop over the mapped Z: drive.
#
# Usage: .\restart-service.ps1
#        .\restart-service.ps1 -Nssm "D:\tools\nssm.exe"   # non-default nssm path

param(
    [string]$ServiceName = "RouteOne",
    [string]$Nssm        = "C:\nssm\nssm-2.24\win64\nssm.exe",
    [string]$HealthUrl   = "http://localhost:4200/api/health",
    [string]$ErrorLog    = "C:\RouteOne\server\logs\service-error.log"
)

$ErrorActionPreference = "Stop"

function Log {
    param([string]$Message, [string]$Color = "White")
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message" -ForegroundColor $Color
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Log "ERROR: Run this from an elevated PowerShell (Run as Administrator)." "Red"
    exit 1
}

if (!(Test-Path $Nssm)) {
    Log "ERROR: nssm.exe not found at $Nssm" "Red"
    Log "Pass -Nssm <path> if it's installed somewhere else." "Yellow"
    exit 1
}

Log "`n========================================" "Cyan"
Log "  RouteOne service restart" "Cyan"
Log "========================================`n" "Cyan"

Log "[1] Stopping $ServiceName..." "Cyan"
& $Nssm stop $ServiceName | Out-Null
Start-Sleep -Seconds 2
$status = (& $Nssm status $ServiceName).Trim()
Log "  Status: $status" $(if ($status -eq "SERVICE_STOPPED") { "Green" } else { "Yellow" })

Log "`n[2] Starting $ServiceName..." "Cyan"
& $Nssm start $ServiceName | Out-Null
Start-Sleep -Seconds 3
$status = (& $Nssm status $ServiceName).Trim()
if ($status -eq "SERVICE_RUNNING") {
    Log "  Status: $status" "Green"
} else {
    Log "  Status: $status" "Red"
    Log "  Service did not come up - check the error log:" "Red"
    if (Test-Path $ErrorLog) {
        Log "`n--- last 20 lines of $ErrorLog ---" "Yellow"
        Get-Content $ErrorLog -Tail 20 | ForEach-Object { Log "  $_" "Gray" }
    } else {
        Log "  (log not found at $ErrorLog)" "Yellow"
    }
    exit 1
}

Log "`n[3] Checking health endpoint..." "Cyan"
$healthy = $false
for ($i = 1; $i -le 5; $i++) {
    try {
        $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200 -and $response.Content -match '"ok"\s*:\s*true') {
            $healthy = $true
            break
        }
    } catch {
        # not up yet, retry
    }
    Start-Sleep -Seconds 2
}

if ($healthy) {
    Log "  OK - $HealthUrl responding" "Green"
} else {
    Log "  WARN - $HealthUrl not responding after restart" "Red"
    if (Test-Path $ErrorLog) {
        Log "`n--- last 20 lines of $ErrorLog ---" "Yellow"
        Get-Content $ErrorLog -Tail 20 | ForEach-Object { Log "  $_" "Gray" }
    }
    exit 1
}

Log "`n========================================" "Green"
Log "  OK: RouteOne restarted successfully" "Green"
Log "========================================`n" "Green"
