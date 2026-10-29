@echo off
title CiRA Inspection Server (PM2 Stopper)
cd /d "%~dp0"
echo Stopping CiRA Inspection Server (PM2)...
call pm2.cmd stop cira-inspection-server
call pm2.cmd status
echo.
pause
