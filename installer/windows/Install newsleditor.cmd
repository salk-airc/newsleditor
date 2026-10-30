@echo off
rem Double-click to install newsleditor (or update it) from a setup code.
rem Runs install.ps1 from this folder, or downloads it if this file is on its own.
setlocal
set "PS1=%~dp0install.ps1"
if not exist "%PS1%" (
  set "PS1=%TEMP%\newsleditor-install.ps1"
  powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/salk-airc/newsleditor/main/installer/windows/install.ps1' -OutFile $env:TEMP\newsleditor-install.ps1"
  if errorlevel 1 (
    echo Couldn't download the installer. Check the internet connection and try again.
    pause
    exit /b 1
  )
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
