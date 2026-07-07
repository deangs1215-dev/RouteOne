@echo off
title RouteOne Field Sales
cd /d "%~dp0"
echo Starting RouteOne Field Sales...
echo (Keep this window open - closing it stops the app)
start "" "http://localhost:5190"
call npm run dev
pause
