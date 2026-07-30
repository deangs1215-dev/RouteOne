@echo off
REM Deploy RouteOne - Sync local to server Z:\ and restart
REM Double-click to run, or: deploy.bat

setlocal enabledelayedexpansion

set LocalPath=C:\Projects\RouteOne
set ServerDrive=Z:

cls
echo.
echo ========================================
echo   RouteOne Deploy - Sync to Server
echo ========================================
echo.
echo Local:  %LocalPath%
echo Server: %ServerDrive%
echo.

REM Check if paths exist
if not exist "%LocalPath%" (
    color 0c
    echo ERROR: Local path not found: %LocalPath%
    pause
    exit /b 1
)

if not exist "%ServerDrive%" (
    color 0c
    echo ERROR: Server drive not found: %ServerDrive%
    echo Make sure Z:\ is mapped to your server
    pause
    exit /b 1
)

REM Sync files
echo [1] Syncing files to server...
echo.

REM /XD excludes build/tooling dirs AND server-owned state:
REM   server\data    = the LIVE database - never overwrite from local
REM   server\backups = server's own backups
REM   server\uploads = files uploaded on the server
REM /XF excludes env files (server has its own .env with APP_ORIGIN etc)
REM     and any stray database files
REM /R:1 /W:1 = fail fast on a locked file instead of retrying for hours
robocopy "%LocalPath%" "%ServerDrive%" ^
  /E ^
  /XO ^
  /XD node_modules .git .next dist build graphify-out ^
      "%LocalPath%\server\data" ^
      "%LocalPath%\server\backups" ^
      "%LocalPath%\server\uploads" ^
  /XF .env .env.local .env.production *.db *.db-shm *.db-wal ^
  /R:1 /W:1 ^
  /NFL /NDL /NJH /NJS

if errorlevel 8 (
    color 0c
    echo ERROR: Sync failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo   OK: Files synced successfully!
echo ========================================
echo.
echo NEXT STEP:
echo   RDP into server and run:
echo     C:\nssm\nssm-2.24\win64\nssm.exe restart RouteOne
echo.
echo Test in browser: http://routeone-test.sbakels.net:4200/
echo.
pause
