# RouteOne Disk Space Monitor
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files as
# Windows-1252, which turns UTF-8 symbols into curly quotes and breaks parsing.

$WarningThresholdGB = 50
$CriticalThresholdGB = 20
$LogFile = "C:\RouteOne\server\logs\disk-monitor.log"

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

try {
    $disk = Get-Volume -DriveLetter C -ErrorAction Stop
    $freeGB = [math]::Round($disk.SizeRemaining / 1GB, 2)
    $totalGB = [math]::Round($disk.Size / 1GB, 2)
    $usedGB = [math]::Round($totalGB - $freeGB, 2)
    $usedPercent = [math]::Round(($usedGB / $totalGB) * 100, 1)

    $message = "C: drive - ${usedGB}GB / ${totalGB}GB used (${usedPercent}%) - ${freeGB}GB free"
    Log $message

    if ($freeGB -lt $CriticalThresholdGB) {
        Send-Alert "CRITICAL: RouteOne server disk space critical (${freeGB}GB free)" "C: drive has only ${freeGB}GB free. Immediate action required.`r`n`r`n$message" "Critical"
    } elseif ($freeGB -lt $WarningThresholdGB) {
        Send-Alert "WARNING: RouteOne server disk space low (${freeGB}GB free)" "C: drive has ${freeGB}GB free (threshold: ${WarningThresholdGB}GB).`r`n`r`n$message" "Warning"
    } else {
        Log "[OK] Disk space is healthy"
    }
} catch {
    Log "[FAIL] Error checking disk space: $($_.Exception.Message)"
    Send-Alert "ERROR: RouteOne disk check failed" $_.Exception.Message "Error"
}
