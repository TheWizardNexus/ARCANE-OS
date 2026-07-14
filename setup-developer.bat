@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup-developer.ps1" %*
set "ARCANE_SETUP_EXIT=%errorlevel%"
if not "%ARCANE_SETUP_EXIT%"=="0" (
  echo.
  echo Arcane OS developer setup failed with exit code %ARCANE_SETUP_EXIT%.
  exit /b %ARCANE_SETUP_EXIT%
)
echo.
echo Arcane OS developer setup completed successfully.
exit /b 0
