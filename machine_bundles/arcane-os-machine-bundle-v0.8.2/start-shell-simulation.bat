@echo off
setlocal
set "APP=%~dp0dist\windows\bin\ArcaneShell.exe"
if not exist "%APP%" (
  echo ArcaneShell.exe has not been built.
  echo Run build-windows.bat first.
  exit /b 2
)
start "Arcane OS Simulation" "%APP%" --simulate --allow-unsigned-local-release
