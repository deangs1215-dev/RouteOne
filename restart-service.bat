@echo off
REM Stop and restart the RouteOne Windows service (NSSM).
REM Run this ON THE SERVER, in RDP - self-elevates if not already admin
REM (service control needs admin rights).

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

title RouteOne Service Restart
cd /d "%~dp0"

set NSSM=C:\nssm\nssm-2.24\win64\nssm.exe
set SERVICE=RouteOne
set ERRLOG=C:\RouteOne\server\logs\service-error.log
set HEALTHURL=http://localhost:4200/api/health

if not exist "%NSSM%" (
    color 0c
    echo.
    echo ERROR: nssm.exe not found at %NSSM%
    pause
    exit /b 1
)

cls
echo.
echo ========================================
echo   RouteOne Service Restart
echo ========================================
echo.

echo [1/3] Stopping %SERVICE%...
"%NSSM%" stop %SERVICE%
timeout /t 2 /nobreak >nul
"%NSSM%" status %SERVICE%

echo.
echo [2/3] Starting %SERVICE%...
"%NSSM%" start %SERVICE%
timeout /t 3 /nobreak >nul

for /f "delims=" %%S in ('"%NSSM%" status %SERVICE%') do set STATUS=%%S
echo   Status: %STATUS%

if not "%STATUS%"=="SERVICE_RUNNING" (
    color 0c
    echo.
    echo ERROR: Service did not come up - last 20 lines of the error log:
    echo.
    if exist "%ERRLOG%" (
        powershell -Command "Get-Content '%ERRLOG%' -Tail 20"
    ) else (
        echo   (log not found at %ERRLOG%)
    )
    pause
    exit /b 1
)

echo.
echo [3/3] Checking health endpoint...
powershell -NoProfile -Command ^
    "$ok = $false; for ($i=0; $i -lt 5; $i++) { try { $r = Invoke-WebRequest -Uri '%HEALTHURL%' -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -eq 200 -and $r.Content -match '\"ok\"\s*:\s*true') { $ok = $true; break } } catch {}; Start-Sleep -Seconds 2 }; if ($ok) { Write-Host '  OK - %HEALTHURL% responding' -ForegroundColor Green } else { Write-Host '  WARN - %HEALTHURL% not responding' -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
    color 0c
    echo.
    echo Service is running but health check failed - last 20 lines of the error log:
    echo.
    if exist "%ERRLOG%" (
        powershell -Command "Get-Content '%ERRLOG%' -Tail 20"
    )
    pause
    exit /b 1
)

echo.
echo ========================================
echo   OK: RouteOne restarted successfully
echo ========================================
echo.
pause
