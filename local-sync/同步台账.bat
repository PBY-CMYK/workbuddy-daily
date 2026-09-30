@echo off
setlocal
chcp 65001 >nul 2>&1
title Buddy Ledger Sync

echo ============================================
echo   Buddy Ledger  -  Sync
echo ============================================
echo.

REM -- locate node.exe (prefer the one bundled with WorkBuddy) --
set "NODE_EXE="
set "NODE_VER=22.22.2-3"
set "CAND1=%USERPROFILE%\.workbuddy\binaries\node\versions\%NODE_VER%\node.exe"
if exist "%CAND1%" set "NODE_EXE=%CAND1%"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"
if not defined NODE_EXE for %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions") do if exist "%%~fD" for /f "delims=" %%N in ('dir /b /o-n "%%~fD\*\node.exe" 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%~fD\%%N"

if not defined NODE_EXE (
  echo [ERROR] node.exe not found.
  echo.
  echo Install Node.js, or edit this file and hardcode NODE_EXE.
  echo.
  pause
  exit /b 1
)

echo node  : %NODE_EXE%
echo script: %~dp0sync-ledger.mjs
echo.
echo Syncing ...
echo.

pushd "%~dp0"
"%NODE_EXE%" "%~dp0sync-ledger.mjs"
set "RC=%ERRORLEVEL%"
popd

echo.
if "%RC%"=="0" goto OK
if "%RC%"=="2" goto WARN
if "%RC%"=="1" goto CFG
goto OTHER

:OK
echo [DONE] Ledger updated.
echo        The table is opened. This window will close automatically.
REM ping 3 times ~= 2s delay; works even when stdin is redirected (timeout would error out)
ping -n 3 127.0.0.1 >nul
exit /b 0

:WARN
echo [NOT DONE] See messages above.
echo.
echo Common causes:
echo   1. the repo has no ledger yet ^(the workflow never succeeded^)
echo   2. the repo is private, so the raw URL cannot be fetched
echo   3. network / proxy blocked raw.githubusercontent.com
goto END

:CFG
echo [CONFIG ERROR] Please fix sync-config.json first:
echo   - set "repo" to  your-name/your-repo
echo   - the repo must be PUBLIC for this script
goto END

:OTHER
echo [ERROR] unexpected exit code %RC%
goto END

:END
echo.
echo [FAILED] Press any key to close ...
pause >nul
endlocal
