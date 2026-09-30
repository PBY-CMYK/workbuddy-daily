@echo off
setlocal
chcp 65001 >nul 2>&1
title Repair .bat line endings

echo ============================================
echo   Repair .bat line endings (LF to CRLF)
echo ============================================
echo.

set "NODE_EXE="
set "CAND1=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if exist "%CAND1%" set "NODE_EXE=%CAND1%"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"

if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Install Node.js first.
  pause
  exit /b 1
)

pushd "%~dp0"
"%NODE_EXE%" "%~dp0repair-bat.mjs"
set "RC=%ERRORLEVEL%"
echo.
"%NODE_EXE%" "%~dp0check-bat-eol.mjs"
popd

echo.
if "%RC%"=="0" echo [DONE] Repair finished. Now double-click the sync bat again.
if not "%RC%"=="0" echo [WARN] Repair reported problems, see above.

echo.
echo Press any key to close ...
pause >nul
endlocal
