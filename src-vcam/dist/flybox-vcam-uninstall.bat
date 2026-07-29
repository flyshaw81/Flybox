@echo off
cd /d "%~dp0"
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Need Administrator. Right-click Run as administrator.
  pause
  exit /b 1
)
set DLL=%~dp0flybox-virtualcam-module64.dll
if exist "%DLL%" (
  regsvr32.exe /u /s "%DLL%"
)
echo FLYBOX Camera uninstalled.
pause
