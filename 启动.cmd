@echo off
chcp 65001 >nul
"%~dp0runtime\node.exe" "%~dp0service\cli.mjs" start --open %*
if errorlevel 1 pause
