@echo off
chcp 65001 >nul
"%~dp0runtime\node.exe" "%~dp0service\cli.mjs" diagnose %*
if errorlevel 1 pause
pause
