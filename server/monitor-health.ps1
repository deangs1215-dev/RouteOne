# RouteOne Health Monitor - runs every 5 minutes
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files as
# Windows-1252, which turns UTF-8 symbols into curly quotes and breaks parsing.

$BaseUrl = "http://routeone-test.sbakels.net:4200"
$MaxResponseTimeSeconds = 10
$LogFile = "C:\RouteOne\server\logs\health-monitor.log"
$FailCountFile = "C:\RouteOne\server\logs\health-monitor-fails.txt"

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

# Initialize fail count file
if (-not (Test-Path $FailCountFile)) {
    Set-Content -Path $FailCountFile -Value "0" -Encoding UTF8
}

# Check health
$startTime = [System.Diagnostics.Stopwatch]::StartNew()
$isHealthy = $false

try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/api/health" -Method Get -TimeoutSec $MaxResponseTimeSeconds -UseBasicParsing -ErrorAction Stop
    $startTime.Stop()

    if ($response.StatusCode -eq 200) {
        $elapsed = [math]::Round($startTime.Elapsed.TotalSeconds, 2)
        Log "[OK] Health check passed (${elapsed}s)"
        $isHealthy = $true
    } else {
        Log "[FAIL] Health check failed: HTTP $($response.StatusCode)"
    }
} catch {
    $startTime.Stop()
    Log "[FAIL] Health check error: $($_.Exception.Message)"

    # Try to diagnose and restart
    $nssm = "C:\nssm\nssm-2.24\win64\nssm.exe"
    try {
        $status = & $nssm status RouteOne
        Log "  Service status: $status"

        if ($status -like "*STOPPED*" -or $status -like "*stopped*") {
            Log "  Attempting automatic restart..."
            & $nssm restart RouteOne
            Start-Sleep -Seconds 5
            Log "  Restart issued"
        }
    } catch {
        Log "  Error checking service status: $($_.Exception.Message)"
    }
}

# Handle failures and alerts
if (-not $isHealthy) {
    $failCount = [int](Get-Content $FailCountFile -ErrorAction SilentlyContinue)
    $failCount++
    Set-Content -Path $FailCountFile -Value $failCount -Encoding UTF8
    Log "  Failure count: $failCount"

    if ($failCount -ge 3) {
        Send-Alert "ALERT: RouteOne health check failed 3 times" "RouteOne at $BaseUrl failed the health check 3 times in a row. Check the log at $LogFile" "Error"
        Set-Content -Path $FailCountFile -Value "0" -Encoding UTF8
    }
} else {
    Set-Content -Path $FailCountFile -Value "0" -Encoding UTF8
}
