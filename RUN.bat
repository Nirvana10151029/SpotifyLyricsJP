@echo off
setlocal
set "LAUNCHER=%~dp0Launcher.ps1"
if not exist "%LAUNCHER%" (
  echo Launcher.ps1 was not found.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%LAUNCHER%"
if errorlevel 1 (
  echo.
  echo Startup failed. Please send a photo of this window.
  pause
)
endlocal
