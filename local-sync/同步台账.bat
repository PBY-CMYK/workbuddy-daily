@echo off
setlocal
chcp 65001 >nul 2>&1
title Buddy 台账同步

echo ============================================
echo   Buddy 台账  -  同步
echo ============================================
echo.

REM -- 定位 node.exe（优先用 WorkBuddy 自带的那份）--
set "NODE_EXE="
set "NODE_VER=22.22.2-6"
set "CAND1=%USERPROFILE%\.workbuddy\binaries\node\versions\%NODE_VER%\node.exe"
if exist "%CAND1%" set "NODE_EXE=%CAND1%"
if not defined NODE_EXE for /f "delims=" %%V in ('dir /b /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%V\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%V\node.exe"

if not defined NODE_EXE (
  echo [错误] 没找到 node.exe。
  echo.
  echo 请安装 Node.js，或编辑本文件把 NODE_EXE 直接写成完整路径。
  echo.
  pause
  exit /b 1
)

echo node  : %NODE_EXE%
echo 脚本  : %~dp0sync-ledger.mjs
echo.
echo 正在同步 ...
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
echo [完成] 台账已更新到最新。
echo        窗口 3 秒后自动关闭。
echo        令牌过期会由脚本自动续期（refreshToken 滚动 60 天），无需人工换令牌。
ping -n 4 127.0.0.1 >nul
exit /b 0

:WARN
echo [未完成] 请看上面的具体原因。
echo.
echo 常见原因：
echo   1. 仓库里还没有台账（云端任务一次都没成功过）
echo   2. 仓库是私有的，公开地址拉不到
echo   3. 网络或代理挡住了 raw.githubusercontent.com / api.github.com
echo   4. 只是「余额不刷新」：令牌过期且自动续期失败（台账照样更新，属正常降级），
echo      把新的 token.local.json 放到本文件夹或桌面即可恢复
goto END

:CFG
echo [配置错误] 请先改 local-sync\sync-config.json：
echo   - 把 "repo" 填成 你的用户名/仓库名
echo   - 仓库必须是公开的，本脚本才能拉
goto END

:OTHER
echo [错误] 未预期的退出码 %RC%
goto END

:END
echo.
echo [结束] 按任意键关闭 ...
pause >nul
endlocal
