# RouteOne Monitoring & Alerting Setup

**For IT Operations Team**  
*Implementation guide for production monitoring*

---

## Overview

This guide sets up uptime checks, disk space alerts, backup verification, and log collection for the RouteOne application running on Windows Server at `C:\RouteOne`.

All tools are **built-in to Windows Server** or freely available — no paid monitoring infrastructure required.

> **The scripts already exist in the repo** — `server/monitor-health.ps1`,
> `server/monitor-disk.ps1`, `server/monitor-backups.ps1`, `server/get-status.ps1`.
> They deploy to `C:\RouteOne\server\` with the normal `deploy.bat` sync. Use those
> files; the listings below are for reference only.
>
> **Keep every `.ps1` in this project pure ASCII.** The server runs Windows
> PowerShell 5.1, which reads a BOM-less file as Windows-1252. A UTF-8 tick mark
> (`E2 9C 93`) then decodes to `âœ“`, and that trailing byte is a curly quote —
> which PowerShell treats as a *string delimiter*. The rest of the file becomes one
> unterminated string and the script dies with a misleading "missing closing '}'"
> parser error. Use `[OK]` / `[FAIL]` / `[WARN]` markers instead of symbols.
>
> Same reason: no PowerShell 7+ syntax. `??`, `?:`, and `?.` are parser errors on
> 5.1 — use `if (...) { } else { }` instead.

---

## 1. Health Check Endpoint (Already Built-In)

### What It Does
The app exposes a health endpoint at `/api/health` that returns `{ "ok": 1 }` when the service is running normally.

### Test the Endpoint
```powershell
# From any machine on the network
curl http://routeone-test.sbakels.net:4200/api/health

# Expected response (status 200):
# { "ok": 1 }
```

### Failure Scenarios
- **Connection refused** → Node process is not running
- **Connection timeout** → Firewall blocked, or network unreachable
- **HTTP 500** → Database is corrupted or locked
- **HTTP 503** → SYSPRO connection failed (no sync errors, but the app detected a problem)

---

## 2. Uptime Monitoring (Every 5 Minutes)

### Windows Task Scheduler Approach

**Step 1: Create a monitoring script**

Save as `C:\RouteOne\server\monitor-health.ps1`:

```powershell
# RouteOne Health Monitor - runs every 5 minutes
# Logs to: C:\RouteOne\server\logs\health-monitor.log

$BaseUrl = "http://routeone-test.sbakels.net:4200"
$MaxResponseTimeSeconds = 10
$LogFile = "C:\RouteOne\server\logs\health-monitor.log"

function Log($message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp | $message" | Out-File -FilePath $LogFile -Append -Encoding UTF8
}

function Check-Health {
    $startTime = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest `
            -Uri "$BaseUrl/api/health" `
            -Method Get `
            -TimeoutSec $MaxResponseTimeSeconds `
            -ErrorAction Stop
        $startTime.Stop()
        
        if ($response.StatusCode -eq 200) {
            $elapsed = $startTime.Elapsed.TotalSeconds
            Log "✓ Health check passed (${elapsed}s)"
            return $true
        } else {
            Log "✗ Health check failed: HTTP $($response.StatusCode)"
            return $false
        }
    } catch {
        $startTime.Stop()
        Log "✗ Health check error: $($_.Exception.Message)"
        
        # Attempt to diagnose the failure
        $nssm = "C:\nssm\nssm-2.24\win64\nssm.exe"
        $status = & $nssm status RouteOne 2>&1
        Log "  → Service status: $status"
        
        # If service is not running, try to restart it
        if ($status -like "*SERVICE_STOPPED*" -or $status -like "*stopped*") {
            Log "  → Attempting automatic restart..."
            & $nssm restart RouteOne
            Start-Sleep -Seconds 5
            Log "  → Restart issued, will re-check on next cycle"
        }
        
        return $false
    }
}

# Run the check
$isHealthy = Check-Health

# If check failed 3 times in a row, alert
$failLogFile = "C:\RouteOne\server\logs\health-monitor-fails.txt"
if (-not $isHealthy) {
    $failCount = @(Get-Content $failLogFile -ErrorAction SilentlyContinue).Count
    $failCount = if ($null -eq $failCount) { 0 } else { $failCount }
    $failCount++
    $failCount | Out-File $failLogFile -Encoding UTF8
    
    if ($failCount -ge 3) {
        $subject = "ALERT: RouteOne Health Check Failed 3 Times"
        $body = "RouteOne at $BaseUrl failed the health check 3 times in a row.`n`nCheck logs at $LogFile"
        
        # Send alert (see Email Alerts section below)
        Send-HealthAlert -Subject $subject -Body $body
        
        # Reset counter
        "" | Out-File $failLogFile -Encoding UTF8
    }
} else {
    # Reset failure counter on success
    "" | Out-File $failLogFile -Encoding UTF8
}
```

**Step 2: Create a scheduled task**

Run these commands on the server (as Administrator):

```powershell
$action = New-ScheduledTaskAction `
  -Execute "PowerShell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\RouteOne\server\monitor-health.ps1"

$trigger = New-ScheduledTaskTrigger `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -At "00:00" `
  -Once

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName "RouteOne Health Monitor" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Checks RouteOne /api/health every 5 minutes" `
  -User "SYSTEM" `
  -Force
```

**Step 3: Verify the task**

```powershell
# List the scheduled task
Get-ScheduledTask -TaskName "RouteOne Health Monitor" | Select-Object *

# Check if it's enabled
Get-ScheduledTask -TaskName "RouteOne Health Monitor" | Select-Object Name, State
```

**Step 4: Monitor the logs**

```powershell
# Tail the health check log
Get-Content "C:\RouteOne\server\logs\health-monitor.log" -Tail 30

# Check for failures
Get-Content "C:\RouteOne\server\logs\health-monitor-fails.txt"
```

---

## 3. Disk Space Monitoring

### Windows Task Scheduler Alert

**Step 1: Create disk check script**

Save as `C:\RouteOne\server\monitor-disk.ps1`:

```powershell
# RouteOne Disk Space Monitor
# Alerts if C: drive has < 50GB free (warn) or < 20GB free (critical)

$WarningThresholdGB = 50
$CriticalThresholdGB = 20
$LogFile = "C:\RouteOne\server\logs\disk-monitor.log"

function Log($message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp | $message" | Out-File -FilePath $LogFile -Append -Encoding UTF8
}

# Check disk space on C: drive
$disk = Get-Volume -DriveLetter C
$freeGB = [math]::Round($disk.SizeRemaining / 1GB, 2)
$totalGB = [math]::Round($disk.Size / 1GB, 2)
$usedGB = $totalGB - $freeGB
$usedPercent = [math]::Round(($usedGB / $totalGB) * 100, 1)

$message = "C: Drive - ${usedGB}GB / ${totalGB}GB used (${usedPercent}%) - ${freeGB}GB free"
Log $message

if ($freeGB -lt $CriticalThresholdGB) {
    $subject = "CRITICAL: RouteOne Server Disk Space Critical (${freeGB}GB free)"
    $body = "C: drive has only ${freeGB}GB free. Immediate action required.`n`n$message"
    Send-DiskAlert -Subject $subject -Body $body -Severity "Critical"
} elseif ($freeGB -lt $WarningThresholdGB) {
    $subject = "WARNING: RouteOne Server Disk Space Low (${freeGB}GB free)"
    $body = "C: drive has ${freeGB}GB free (threshold: ${WarningThresholdGB}GB).`n`n$message"
    Send-DiskAlert -Subject $subject -Body $body -Severity "Warning"
}
```

**Step 2: Register the task**

```powershell
$action = New-ScheduledTaskAction `
  -Execute "PowerShell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\RouteOne\server\monitor-disk.ps1"

# Run once per day at 1 AM
$trigger = New-ScheduledTaskTrigger -Daily -At "01:00"

Register-ScheduledTask `
  -TaskName "RouteOne Disk Monitor" `
  -Action $action `
  -Trigger $trigger `
  -Description "Daily disk space check for C: drive" `
  -User "SYSTEM" `
  -Force
```

---

## 4. Backup Verification

### Script to Verify Last Backup

Save as `C:\RouteOne\server\monitor-backups.ps1`:

```powershell
# RouteOne Backup Monitor
# Verifies that backups are running and age is acceptable

$BackupDir = "C:\RouteOne\server\backups"
$MaxAgeHours = 48
$LogFile = "C:\RouteOne\server\logs\backup-monitor.log"

function Log($message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp | $message" | Out-File -FilePath $LogFile -Append -Encoding UTF8
}

# Find the most recent backup file
$backupFiles = Get-ChildItem -Path $BackupDir -Filter "*.db" | Sort-Object LastWriteTime -Descending
if ($backupFiles.Count -eq 0) {
    Log "✗ No backup files found in $BackupDir"
    Send-BackupAlert `
        -Subject "CRITICAL: No RouteOne Backups Found" `
        -Body "No backup files found in $BackupDir. Backup process may be broken."
    exit 1
}

$latestBackup = $backupFiles[0]
$ageHours = ([datetime]::Now - $latestBackup.LastWriteTime).TotalHours
$sizeMB = [math]::Round($latestBackup.Length / 1MB, 2)

Log "✓ Latest backup: $($latestBackup.Name) (${sizeMB}MB, ${ageHours}h old)"

if ($ageHours -gt $MaxAgeHours) {
    $subject = "WARNING: RouteOne Backup is Stale (${ageHours}h old)"
    $body = "Last backup is ${ageHours} hours old (threshold: ${MaxAgeHours}h).`n`nFile: $($latestBackup.FullName)"
    Send-BackupAlert -Subject $subject -Body $body
} else {
    Log "✓ Backup age is acceptable"
}

# Verify backup can be read
try {
    $testRead = Get-Item $latestBackup.FullName
    if ($testRead.Length -lt 100MB) {
        Log "⚠ Backup file is smaller than expected (${sizeMB}MB)"
    }
} catch {
    Log "✗ Cannot read backup file: $($_.Exception.Message)"
    Send-BackupAlert `
        -Subject "CRITICAL: Backup File Unreadable" `
        -Body "Cannot read backup file: $($latestBackup.FullName)"
}

# Report backup count
Log "Total backups on disk: $($backupFiles.Count)"
```

**Register the task:**

```powershell
$action = New-ScheduledTaskAction `
  -Execute "PowerShell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\RouteOne\server\monitor-backups.ps1"

# Run daily at 1:30 AM (after disk check)
$trigger = New-ScheduledTaskTrigger -Daily -At "01:30"

Register-ScheduledTask `
  -TaskName "RouteOne Backup Monitor" `
  -Action $action `
  -Trigger $trigger `
  -Description "Daily backup verification" `
  -User "SYSTEM" `
  -Force
```

---

## 5. Email Alerts

### Setup SMTP Configuration

Add to `.env` on the server (if not already present):

```env
# Email alerts (M365/Office 365)
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=routeone-alerts@sbakels.net
SMTP_PASSWORD=<M365 password>
SMTP_FROM=routeone-alerts@sbakels.net

# Monitoring recipients (comma-separated)
ALERT_RECIPIENTS=it-oncall@sbakels.net,dean.jansen@sbakels.net
```

### Create Alert Function

Add to PowerShell profile or each monitoring script:

```powershell
function Send-Alert {
    param(
        [string]$Subject,
        [string]$Body,
        [string]$Severity = "Warning"
    )
    
    # Load .env file
    $envFile = "C:\RouteOne\.env"
    $env_vars = @{}
    foreach ($line in (Get-Content $envFile | Where-Object { $_ -and -not $_.StartsWith("#") })) {
        $key, $value = $line -split "=", 2
        $env_vars[$key] = $value
    }
    
    $smtpHost = $env_vars["SMTP_HOST"]
    $smtpPort = [int]($env_vars["SMTP_PORT"] ?? 587)
    $smtpUser = $env_vars["SMTP_USER"]
    $smtpPass = $env_vars["SMTP_PASSWORD"]
    $from = $env_vars["SMTP_FROM"]
    $to = $env_vars["ALERT_RECIPIENTS"] -split ","
    
    $credential = New-Object System.Management.Automation.PSCredential($smtpUser, (ConvertTo-SecureString $smtpPass -AsPlainText -Force))
    
    # Add severity badge
    $body = "[$Severity] $body`n`nServer: routeone-test.sbakels.net`nTimestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    
    foreach ($recipient in $to) {
        try {
            Send-MailMessage `
                -SmtpServer $smtpHost `
                -Port $smtpPort `
                -From $from `
                -To $recipient.Trim() `
                -Subject $Subject `
                -Body $body `
                -Credential $credential `
                -UseSsl `
                -ErrorAction Stop
            
            $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            Write-Host "$timestamp | Alert sent to $recipient"
        } catch {
            Write-Error "Failed to send alert to $recipient: $($_.Exception.Message)"
        }
    }
}

# Alias functions for each monitoring script
function Send-HealthAlert { Send-Alert @args -Severity "Error" }
function Send-DiskAlert { Send-Alert @args -Severity $args[2] }
function Send-BackupAlert { Send-Alert @args -Severity "Error" }
```

---

## 6. Log Collection & Rotation

### Current Log Files

| File | Purpose | Max Size |
|------|---------|----------|
| `C:\RouteOne\server\logs\service.log` | Application startup & runtime | 10 MB (auto-rotated) |
| `C:\RouteOne\server\logs\service-error.log` | Errors & exceptions | 10 MB (auto-rotated) |
| `C:\RouteOne\server\logs\health-monitor.log` | Health check results | (manual rotation) |
| `C:\RouteOne\server\logs\disk-monitor.log` | Disk space checks | (manual rotation) |
| `C:\RouteOne\server\logs\backup-monitor.log` | Backup verification | (manual rotation) |

### Manual Log Rotation (Optional)

```powershell
function Rotate-Logs {
    $logsDir = "C:\RouteOne\server\logs"
    $archiveDir = "C:\RouteOne\server\logs\archive"
    
    # Create archive directory if needed
    if (-not (Test-Path $archiveDir)) { New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null }
    
    # Rotate logs older than 7 days
    Get-ChildItem $logsDir -File | Where-Object {
        $_.LastWriteTime -lt (Get-Date).AddDays(-7) -and $_.Name -like "*.log"
    } | ForEach-Object {
        $newName = "$($_.BaseName)-$(Get-Date $_.LastWriteTime -Format 'yyyy-MM-dd').log"
        Move-Item -Path $_.FullName -Destination "$archiveDir\$newName" -Force
    }
}

# Schedule this to run weekly
$action = New-ScheduledTaskAction `
  -Execute "PowerShell.exe" `
  -Argument "-Command 'Rotate-Logs'"

$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "02:00"

Register-ScheduledTask `
  -TaskName "RouteOne Log Rotation" `
  -Action $action `
  -Trigger $trigger `
  -User "SYSTEM" `
  -Force
```

---

## 7. Centralized Log View (Optional: Windows Event Viewer)

For a more integrated view, forward application logs to Windows Event Viewer:

```powershell
# Register a custom event log source
$logName = "RouteOne"
$source = "RouteOne Service"

if (-not [System.Diagnostics.EventLog]::SourceExists($source)) {
    New-EventLog -LogName $logName -Source $source
}

# From a monitoring script, write to Event Log:
Write-EventLog -LogName "RouteOne" -Source "RouteOne Service" `
    -EventId 1000 -EntryType Information `
    -Message "Health check passed"
```

View in Event Viewer: `eventvwr.msc` → "RouteOne" log

---

## 8. Incident Escalation & Handoff

### On-Call Rotation

**Define who gets paged:**
- **Primary:** [IT On-Call Contact]
- **Secondary:** [Backup Contact]
- **Escalation (no response in 30 min):** [Manager Contact]

### Alert Severity Levels

| Severity | When to Alert | Response Time |
|----------|---------------|----------------|
| **Error** | Service down, health checks failing | Immediate (5 min) |
| **Critical** | Disk critically low (< 20GB), backup missing | Immediate (5 min) |
| **Warning** | Disk low (< 50GB), backup stale (> 48h) | Within 2 hours |

### Escalation Procedure

1. **First alert** → Attempt automatic restart (health monitor does this)
2. **3 consecutive failures** → Page primary on-call
3. **No response in 30 min** → Page secondary on-call
4. **Still no response** → Page manager + escalate to incident commander

### Incident Log

Keep a simple incident log at `C:\RouteOne\server\logs\incidents.txt`:

```
2026-08-15 14:23 | INCIDENT: Health check failed 3x, auto-restart triggered
2026-08-15 14:28 | RESOLVED: Service recovered after restart
2026-08-16 09:00 | WARNING: Disk at 45GB free, cleanup recommended
2026-08-16 10:30 | RESOLVED: Old backups archived, now 62GB free
```

---

## 9. Dashboard (Optional: Simple Status Page)

Create a basic PowerShell status report script:

Save as `C:\RouteOne\server\get-status.ps1`:

```powershell
# RouteOne Status Dashboard

$baseUrl = "http://routeone-test.sbakels.net:4200"

Write-Host "=== RouteOne Status Report ===" -ForegroundColor Cyan
Write-Host "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray

# Service Status
$nssm = "C:\nssm\nssm-2.24\win64\nssm.exe"
$serviceStatus = & $nssm status RouteOne
$statusColor = if ($serviceStatus -like "*SERVICE_RUNNING*") { "Green" } else { "Red" }
Write-Host "Service: $serviceStatus" -ForegroundColor $statusColor

# Health Check
try {
    $health = Invoke-WebRequest -Uri "$baseUrl/api/health" -Method Get -TimeoutSec 5 -ErrorAction Stop
    Write-Host "Health: ✓ OK (HTTP $($health.StatusCode))" -ForegroundColor Green
} catch {
    Write-Host "Health: ✗ FAILED" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
}

# Database File
$dbPath = "C:\RouteOne\server\data\fieldsales.db"
$dbSize = (Get-Item $dbPath -ErrorAction SilentlyContinue).Length / 1GB
Write-Host "Database: ${dbSize:F2} GB" -ForegroundColor Yellow

# Latest Backup
$latestBackup = Get-ChildItem "C:\RouteOne\server\backups" -Filter "*.db" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$backupAge = ([datetime]::Now - $latestBackup.LastWriteTime).TotalHours
$backupColor = if ($backupAge -lt 24) { "Green" } elseif ($backupAge -lt 48) { "Yellow" } else { "Red" }
Write-Host "Latest Backup: $($latestBackup.Name) (${backupAge:F1}h ago)" -ForegroundColor $backupColor

# Disk Space
$disk = Get-Volume -DriveLetter C
$freeGB = [math]::Round($disk.SizeRemaining / 1GB, 2)
$diskColor = if ($freeGB -gt 50) { "Green" } elseif ($freeGB -gt 20) { "Yellow" } else { "Red" }
Write-Host "Disk Free: ${freeGB}GB" -ForegroundColor $diskColor

Write-Host "`n=== Recent Errors ===" -ForegroundColor Cyan
Get-Content "C:\RouteOne\server\logs\service-error.log" -Tail 5 -ErrorAction SilentlyContinue | Write-Host

Write-Host "`n=== Last Health Check ===" -ForegroundColor Cyan
Get-Content "C:\RouteOne\server\logs\health-monitor.log" -Tail 3 -ErrorAction SilentlyContinue | Write-Host
```

**Run it manually:**
```powershell
& "C:\RouteOne\server\get-status.ps1"
```

---

## 10. Quick Setup Checklist

### On the Server (One-Time Setup)

```powershell
# 1. Create log directory if it doesn't exist
New-Item -ItemType Directory -Path "C:\RouteOne\server\logs" -Force -ErrorAction SilentlyContinue

# 2. Create monitoring scripts
# (Copy the scripts from sections 2, 3, 4 above to their respective files)

# 3. Update .env with SMTP settings
# (Use the Set-EnvValue helper to add SMTP_* keys)

# 4. Register all scheduled tasks
# (Run the Register-ScheduledTask commands from sections 2, 3, 4)

# 5. Verify tasks are scheduled
Get-ScheduledTask | Where-Object { $_.TaskName -like "RouteOne*" } | Select-Object TaskName, State, NextRunTime

# 6. Test health check manually
curl http://routeone-test.sbakels.net:4200/api/health

# 7. Test alert function
# (Send a test email to verify SMTP works)
```

### Ongoing Operations

**Daily:**
- Check `C:\RouteOne\server\logs\health-monitor.log` for any alerts
- Run status script if needed: `& "C:\RouteOne\server\get-status.ps1"`

**Weekly:**
- Review logs for patterns (errors, slow responses)
- Check disk space trend

**Monthly:**
- Verify backups restore cleanly
- Review incident log for systemic issues

---

## 11. Troubleshooting

### Health Check Always Fails

```powershell
# 1. Verify service is running
C:\nssm\nssm-2.24\win64\nssm.exe status RouteOne

# 2. Check for startup errors
Get-Content "C:\RouteOne\server\logs\service-error.log" -Tail 30

# 3. Test the endpoint directly from the server
curl http://localhost:4200/api/health

# 4. Check if port 4200 is listening
Get-NetTCPConnection -LocalPort 4200 -State Listen
```

### Alerts Not Sending

```powershell
# 1. Verify .env has SMTP settings
Get-Content "C:\RouteOne\.env" | Select-String "SMTP"

# 2. Test SMTP connection manually
$credential = New-Object System.Management.Automation.PSCredential(
    "routeone-alerts@sbakels.net",
    (ConvertTo-SecureString "password" -AsPlainText -Force)
)
Send-MailMessage -SmtpServer smtp.office365.com -Port 587 `
    -From "routeone-alerts@sbakels.net" -To "test@sbakels.net" `
    -Subject "Test" -Body "Test" -Credential $credential -UseSsl -ErrorAction Stop

# 3. Check alert recipient list
Get-Content "C:\RouteOne\.env" | Select-String "ALERT_RECIPIENTS"
```

### Disk Space Alert Never Triggers

```powershell
# 1. Manually run disk monitor script
& "C:\RouteOne\server\monitor-disk.ps1"

# 2. Check the log
Get-Content "C:\RouteOne\server\logs\disk-monitor.log" -Tail 10

# 3. Verify task is enabled
Get-ScheduledTask -TaskName "RouteOne Disk Monitor" | Select-Object State
```

---

## Next Steps

1. **Copy all scripts** from this guide to the server
2. **Update `.env`** with SMTP settings and alert recipients
3. **Register scheduled tasks** (use commands from each section)
4. **Send a test alert** to verify email works
5. **Monitor logs daily** for the first week to catch any issues

Once stable, this setup will automatically:
- ✓ Check health every 5 minutes
- ✓ Alert on failures with auto-restart attempt
- ✓ Verify backups daily
- ✓ Monitor disk space
- ✓ Collect logs with auto-rotation

---

**Questions?** Check TODO.md for production readiness items, or refer to IT_SERVER_SETUP_GUIDE.md for architecture details.
