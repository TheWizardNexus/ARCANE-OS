@echo off
setlocal
cd /d "%~dp0"
echo.
echo === Building Arcane OS 0.8.3 for Windows WebView2 ===
echo.
where node.exe >nul 2>nul || (
  echo Node.js 22 or newer is required to build Arcane.
  echo Install Node.js, reopen this terminal, and run this file again.
  echo.
  pause
  exit /b 2
)
call npm ci
if errorlevel 1 goto :failed
call npm run build:win
if errorlevel 1 goto :failed
echo.
echo Build complete.
echo Start the provisioner with start-provisioner.bat
echo Release files are in: %~dp0dist\windows
echo.
pause
exit /b 0
:failed
echo.
echo Arcane Windows build failed. No installed Arcane machine files were changed.
echo.
pause
exit /b 1
