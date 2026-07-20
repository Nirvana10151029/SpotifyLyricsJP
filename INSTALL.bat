@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1"
if errorlevel 1 (
  echo.
  echo インストールに失敗しました。上の表示を確認してください。
  pause
)
endlocal
