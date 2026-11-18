@echo off
chcp 65001 >nul
title ระบบตรวจสอบการบรรจุชิ้นงานด้วย Image AI CiRA - Murata DX12
echo ======================================================================
echo   ระบบตรวจสอบการบรรจุชิ้นงานด้วย Image AI CiRA
echo   บริษัท มูราตะ อิเล็กทรอนิกส์ (ประเทศไทย) จำกัด แผนก DX12
echo ======================================================================
echo.
echo กำลังเริ่มต้นระบบ Web Dashboard และระบบควบคุม...
echo.

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    py run_system.py
) else (
    python run_system.py
)

pause
