@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\rebuild-run.ps1"
set "launchExit=%errorlevel%"
if not "%launchExit%"=="0" pause
exit /b %launchExit%
