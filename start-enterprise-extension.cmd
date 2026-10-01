@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-enterprise-extension.ps1" %*
set "launchExit=%ERRORLEVEL%"
if not "%launchExit%"=="0" (
  echo.
  echo RECAST launch failed. See the error above.
  pause
)
exit /b %launchExit%
