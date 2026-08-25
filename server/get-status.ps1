# RouteOne Status Dashboard - run manually for a quick health snapshot
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files as
# Windows-1252, which turns UTF-8 symbols into curly quotes and breaks parsing.

$baseUrl = "http://routeone-test.sbakels.net:4200"

Write-Host "=== RouteOne Status Report ===" -ForegroundColor Cyan
Write-Host "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
Write-Host ""

# Service status
$nssm = "C:\nssm\nssm-2.24\win64\nssm.exe"
Write-Host "Service status:" -ForegroundColor Yellow
try {
    $serviceStatus = & $nssm status RouteOne
    $statusColor = if ($serviceStatus -like "*RUNNING*") { "Green" } else { "Red" }
    Write-Host "  $serviceStatus" -ForegroundColor $statusColor
} catch {
    Write-Host "  [FAIL] $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Health check
Write-Host "Health check:" -ForegroundColor Yellow
try {
    $health = Invoke-WebRequest -Uri "$baseUrl/api/health" -Method Get -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    Write-Host "  [OK] HTTP $($health.StatusCode)" -ForegroundColor Green
} catch {
    Write-Host "  [FAIL] $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Database
Write-Host "Database:" -ForegroundColor Yellow
$dbPath = "C:\RouteOne\server\data\fieldsales.db"
if (Test-Path $dbPath) {
    $dbSize = [math]::Round((Get-Item $dbPath).Length / 1GB, 2)
    Write-Host "  Size: ${dbSize}GB" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Database file not found at $dbPath" -ForegroundColor Red
}
Write-Host ""

# Latest backup
Write-Host "Latest backup:" -ForegroundColor Yellow
try {
    $latestBackup = Get-ChildItem "C:\RouteOne\server\backups" -Filter "*.db" -ErrorAction Stop | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestBackup) {
        $backupAge = [math]::Round(([datetime]::Now - $latestBackup.LastWriteTime).TotalHours, 1)
        $backupSize = [math]::Round($latestBackup.Length / 1MB, 2)
        $backupColor = if ($backupAge -lt 24) { "Green" } elseif ($backupAge -lt 48) { "Yellow" } else { "Red" }
        Write-Host "  Name: $($latestBackup.Name)" -ForegroundColor $backupColor
        Write-Host "  Age:  ${backupAge}h" -ForegroundColor $backupColor
        Write-Host "  Size: ${backupSize}MB" -ForegroundColor $backupColor
    } else {
        Write-Host "  [FAIL] No backups found" -ForegroundColor Red
    }
} catch {
    Write-Host "  [FAIL] $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Disk space
Write-Host "Disk space (C:):" -ForegroundColor Yellow
try {
    $disk = Get-Volume -DriveLetter C -ErrorAction Stop
    $freeGB = [math]::Round($disk.SizeRemaining / 1GB, 2)
    $totalGB = [math]::Round($disk.Size / 1GB, 2)
    $usedGB = [math]::Round($totalGB - $freeGB, 2)
    $usedPercent = [math]::Round(($usedGB / $totalGB) * 100, 1)

    $diskColor = if ($freeGB -gt 50) { "Green" } elseif ($freeGB -gt 20) { "Yellow" } else { "Red" }
    Write-Host "  Used: ${usedGB}GB / ${totalGB}GB (${usedPercent}%)" -ForegroundColor Gray
    Write-Host "  Free: ${freeGB}GB" -ForegroundColor $diskColor
} catch {
    Write-Host "  [FAIL] $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Recent errors
Write-Host "=== Last 5 service errors ===" -ForegroundColor Cyan
$errorLogPath = "C:\RouteOne\server\logs\service-error.log"
if (Test-Path $errorLogPath) {
    $errors = Get-Content $errorLogPath -Tail 5 -ErrorAction SilentlyContinue
    if ($errors) {
        $errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    } else {
        Write-Host "  (none logged)" -ForegroundColor Green
    }
} else {
    Write-Host "  (error log not found)" -ForegroundColor Yellow
}
Write-Host ""

# Last health checks
Write-Host "=== Last 3 health checks ===" -ForegroundColor Cyan
$healthLogPath = "C:\RouteOne\server\logs\health-monitor.log"
if (Test-Path $healthLogPath) {
    $checks = Get-Content $healthLogPath -Tail 3 -ErrorAction SilentlyContinue
    if ($checks) {
        $checks | ForEach-Object {
            $color = if ($_ -like "*[OK]*") { "Green" } else { "Red" }
            Write-Host "  $_" -ForegroundColor $color
        }
    } else {
        Write-Host "  (none logged yet)" -ForegroundColor Yellow
    }
} else {
    Write-Host "  (health log not found - monitor has not run yet)" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "=== End of report ===" -ForegroundColor Cyan
