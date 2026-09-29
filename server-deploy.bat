@echo off
REM Run this ON THE SERVER after deploy.bat has synced new files from your
REM laptop. Rebuilds the frontend and restarts the RouteOne service in one go
REM - self-elevates if you didn't already open this as Administrator (the
REM service restart step needs admin rights, everything else doesn't).

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

title RouteOne Server Deploy
cd /d "%~dp0"

cls
echo.
echo ========================================
echo   RouteOne Server Deploy
echo ========================================
echo.
echo Folder: %cd%
echo.

echo [1/3] Installing dependencies...
call npm install
if errorlevel 1 (
    color 0c
    echo.
    echo ERROR: npm install failed - see above
    pause
    exit /b 1
)

echo.
echo [2/3] Building frontend...
call npm run build
if errorlevel 1 (
    color 0c
    echo.
    echo ERROR: npm run build failed - see above
    pause
    exit /b 1
)

echo.
echo [3/3] Restarting RouteOne service...
C:\nssm\nssm-2.24\win64\nssm.exe restart RouteOne
if errorlevel 1 (
    color 0c
    echo.
    echo ERROR: Service restart failed - check the service name/path with:
    echo   C:\nssm\nssm-2.24\win64\nssm.exe status RouteOne
    pause
    exit /b 1
)

echo.
echo ========================================
echo   OK: Deploy complete!
echo ========================================
echo.
echo Test in browser: http://routeone-test.sbakels.net:4200/
echo.
pause
