@echo off
setlocal
set "APP=%~dp0dist\nt\bin\ArcaneProvisioner.exe"
if not exist "%APP%" (
  echo ArcaneProvisioner.exe has not been built.
  echo Run build-windows.bat first.
  exit /b 2
)
set ARCANE_DEVTOOLS=1
"%APP%" --devtools
