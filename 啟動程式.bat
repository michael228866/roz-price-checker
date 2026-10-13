@echo off
setlocal
cd /d "%~dp0" || goto :error

where node.exe >nul 2>&1 || (
    echo Node.js is not installed or is not on PATH.
    goto :error
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo Electron is not installed. Run npm.cmd install in this folder first.
    goto :error
)

call npm.cmd start
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo Press any key to close this window.
pause >nul
exit /b 1
