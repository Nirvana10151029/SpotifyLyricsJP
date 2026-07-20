@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Spotify Lyrics JP Setup
chcp 65001 >nul

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

if not exist "%~dp0SpotifyLyricsJP-Setup.ps1" (
  echo.
  echo Error: SpotifyLyricsJP-Setup.ps1 was not found.
  echo Extract the ZIP completely, then run this file from the extracted folder.
  echo.
  pause
  exit /b 1
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0SpotifyLyricsJP-Setup.ps1"
set "RESULT=%ERRORLEVEL%"

echo.
if not "%RESULT%"=="0" (
  echo Setup did not finish. Read the message above.
) else (
  echo Setup completed. Spotify is starting.
)
echo.
pause
exit /b %RESULT%
