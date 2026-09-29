# RouteOne Backup Monitor
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files as
# Windows-1252, which turns UTF-8 symbols into curly quotes and breaks parsing.
#
# Backups are written by server/backup.js as timestamped DIRECTORIES named
# routeone-<ISO-timestamp>/, each containing fieldsales.db, uploads/, and
# backup.json - not flat .db files. Match that shape, not *.db.

$BackupDir = "C:\RouteOne\server\backups"
$MaxAgeHours = 48
$MinSizeMB = 100
$LogFile = "C:\RouteOne\server\logs\backup-monitor.log"

function Log($message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "$timestamp | $message" -Encoding UTF8
}

function Send-Alert($Subject, $Body, $Severity) {
    $envFile = "C:\RouteOne\.env"
    if (-not (Test-Path $envFile)) {
        Log "[WARN] .env file not found, cannot send alert"
        return
    }

    $env_vars = @{}
    foreach ($line in (Get-Content $envFile -ErrorAction SilentlyContinue | Where-Object { $_ -and -not $_.StartsWith("#") })) {
        if ($line -match "=") {
            $key, $value = $line -split "=", 2
            $env_vars[$key] = $value
        }
    }

    $smtpHost = $env_vars["SMTP_HOST"]
    $smtpPortStr = $env_vars["SMTP_PORT"]
    $smtpPort = if ($smtpPortStr) { [int]$smtpPortStr } else { 587 }
    $smtpUser = $env_vars["SMTP_USER"]
    $smtpPass = $env_vars["SMTP_PASSWORD"]
    $from = $env_vars["SMTP_FROM"]
    $recipientStr = $env_vars["ALERT_RECIPIENTS"]

    if (-not $smtpHost -or -not $from) {
        Log "[WARN] SMTP not configured in .env, cannot send alert"
        return
    }

    if (-not $recipientStr) {
        Log "[WARN] ALERT_RECIPIENTS not configured in .env"
        return
    }

    $recipients = @($recipientStr -split "," | ForEach-Object { $_.Trim() })

    try {
        # sb-hosted.sbakels.co.za uses an internal cert (the app's own Email
        # Settings page has "Trust an internal certificate" checked) - skip cert
        # validation here too, or Send-MailMessage fails with a trust error.
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }

        $credential = New-Object System.Management.Automation.PSCredential($smtpUser, (ConvertTo-SecureString $smtpPass -AsPlainText -Force))
        $emailBody = "[$Severity] $Body`r`n`r`nServer: routeone-test.sbakels.net`r`nTimestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

        foreach ($recipient in $recipients) {
            Send-MailMessage -SmtpServer $smtpHost -Port $smtpPort -From $from -To $recipient -Subject $Subject -Body $emailBody -Credential $credential -UseSsl -ErrorAction Stop
            Log "[OK] Alert sent to $recipient"
        }
    } catch {
        Log "[FAIL] Could not send alert: $($_.Exception.Message)"
    }
}

function Get-DirSizeMB($path) {
    $sz = (Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if (-not $sz) { return 0 }
    return [math]::Round($sz / 1MB, 2)
}

try {
    # Match backup.js's own listBackups() shape: directories named routeone-*
    # containing a backup.json manifest. A bare *.tmp dir mid-write doesn't count.
    $backupDirs = @(Get-ChildItem -Path $BackupDir -Directory -ErrorAction Stop |
        Where-Object { $_.Name -like "routeone-*" -and -not $_.Name.EndsWith(".tmp") -and (Test-Path (Join-Path $_.FullName "backup.json")) } |
        Sort-Object LastWriteTime -Descending)

    if ($backupDirs.Count -eq 0) {
        Log "[FAIL] No backup folders found in $BackupDir"
        Send-Alert "CRITICAL: No RouteOne backups found" "No backup folders (routeone-*) found in $BackupDir. The backup process may be broken." "Critical"
        exit 1
    }

    $latestBackup = $backupDirs[0]
    $ageHours = [math]::Round(([datetime]::Now - $latestBackup.LastWriteTime).TotalHours, 1)
    $sizeMB = Get-DirSizeMB $latestBackup.FullName

    Log "[OK] Latest backup: $($latestBackup.Name) (${sizeMB}MB, ${ageHours}h old)"

    if ($ageHours -gt $MaxAgeHours) {
        Send-Alert "WARNING: RouteOne backup is stale (${ageHours}h old)" "Last backup is ${ageHours} hours old (threshold: ${MaxAgeHours}h).`r`n`r`nFolder: $($latestBackup.FullName)" "Warning"
    } else {
        Log "[OK] Backup age is acceptable"
    }

    if ($sizeMB -lt $MinSizeMB) {
        Log "[WARN] Backup folder is smaller than expected (${sizeMB}MB)"
        Send-Alert "WARNING: RouteOne backup size suspicious (${sizeMB}MB)" "Backup folder is unusually small: ${sizeMB}MB (expected at least ${MinSizeMB}MB). May indicate an incomplete backup.`r`n`r`nFolder: $($latestBackup.FullName)" "Warning"
    } else {
        Log "[OK] Backup size looks reasonable"
    }

    $totalMB = 0
    foreach ($d in $backupDirs) { $totalMB += Get-DirSizeMB $d.FullName }
    $totalGB = [math]::Round($totalMB / 1024, 2)
    Log "Total backups on disk: $($backupDirs.Count) folders, ${totalGB}GB"

} catch {
    Log "[FAIL] Error checking backups: $($_.Exception.Message)"
    Send-Alert "ERROR: RouteOne backup check failed" $_.Exception.Message "Error"
    exit 1
}
