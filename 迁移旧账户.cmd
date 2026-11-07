@echo off
chcp 65001 >nul
"%~dp0runtime\node.exe" "%~dp0tools\migrate-legacy.mjs" %*
if errorlevel 1 pause
pause
