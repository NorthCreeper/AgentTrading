@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0service\autostart.ps1" -Remove
if errorlevel 1 pause
pause
