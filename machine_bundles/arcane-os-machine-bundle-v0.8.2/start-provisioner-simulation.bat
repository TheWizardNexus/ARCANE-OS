@echo off
setlocal
set "APP=%~dp0dist\windows\bin\ArcaneProvisioner.exe"
if not exist "%APP%" (
  echo ArcaneProvisioner.exe has not been built.
  echo Run build-windows.bat first.
  exit /b 2
)
start "Arcane OS Provisioner Simulation" "%APP%" --simulate --allow-unsigned-local-release
