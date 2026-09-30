@echo off
setlocal
chcp 65001 >nul 2>&1
title Buddy GitHub Setup

set "NODE_EXE="
set "CAND1=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if exist "%CAND1%" set "NODE_EXE=%CAND1%"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"
if not defined NODE_EXE goto NO_NODE

pushd "%~dp0.."
"%NODE_EXE%" "scripts\setup-github.mjs" --interactive
set "RC=%ERRORLEVEL%"
popd

echo.
if "%RC%"=="0" goto DONE
goto FAILED

:DONE
echo [DONE] Setup finished. You can close this window.
goto END

:FAILED
echo [NOT DONE] See messages above. Fix and run this file again.
echo Re-running is safe. Finished steps are skipped automatically.
goto END

:NO_NODE
echo [ERROR] node.exe not found. Please install Node.js first.
goto END

:END
echo.
pause
endlocal
