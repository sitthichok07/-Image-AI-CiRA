@echo off
title CiRA Inspection Server (PM2 Starter)
cd /d "%~dp0"
echo ========================================================
echo   CiRA Image AI Workpiece Inspection System - Murata DX12
echo   Starting Background Server with PM2 Process Manager
echo ========================================================
call pm2.cmd start ecosystem.config.cjs
call pm2.cmd status
echo.
echo Server is running in background at http://localhost:9999
echo.
pause
