@echo off
cd /d "%~dp0"
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Need Administrator. Right-click Run as administrator.
  pause
  exit /b 1
)
set DLL=%~dp0flybox-virtualcam-module64.dll
if not exist "%DLL%" (
  echo Missing %DLL%
  pause
  exit /b 1
)
echo Installing FLYBOX Camera...
regsvr32.exe /i /s "%DLL%"
if %errorLevel% neq 0 (
  echo regsvr32 failed
  pause
  exit /b 1
)
echo FLYBOX Camera installed.
pause
