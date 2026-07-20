@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Spotify Lyrics JP Uninstall
chcp 65001 >nul

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

if not exist "%~dp0SpotifyLyricsJP-Uninstall.ps1" (
  echo.
  echo Error: SpotifyLyricsJP-Uninstall.ps1 was not found.
  echo Extract the ZIP completely, then run this file from the extracted folder.
  echo.
  pause
  exit /b 1
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0SpotifyLyricsJP-Uninstall.ps1"
set "RESULT=%ERRORLEVEL%"

echo.
if not "%RESULT%"=="0" (
  echo Uninstall did not finish. Read the message above.
) else (
  echo Uninstall completed.
)
echo.
pause
exit /b %RESULT%
