@echo off
setlocal
chcp 65001 >nul 2>&1
title Buddy 加油站 GitHub 一键配置

echo ============================================
echo   Buddy 加油站 - GitHub 一键配置
echo ============================================
echo.
echo 本窗口只向你索要一样东西：GitHub Token（令牌）。
echo.
echo 还没有的话，请先用浏览器完成下面两步（各一次，约 3 分钟）：
echo.
echo   第 1 步  注册 GitHub 账号：
echo     https://github.com/signup
echo.
echo   第 2 步  生成 Token（打开后权限已自动勾好）：
echo     https://github.com/settings/tokens/new?scopes=repo,workflow^&description=buddy-daily
echo       - 确认勾选 repo 和 workflow 两项
echo       - 拉到页面最底部，点 Generate token
echo       - 复制 ghp_ 开头的字符串
echo.
echo 完成后回到本窗口粘贴 Token。建仓库/传代码/写密钥/首跑全自动。
echo.
echo --------------------------------------------
echo.

set "GITHUB_PAT="
set /p GITHUB_PAT=把 Token 粘贴到这里后回车: 
if not defined GITHUB_PAT (
  echo.
  echo [提示] Token 不能为空。
  echo        你还没生成 Token 的话，先按上面两步去网页操作，
  echo        拿到 ghp_ 开头的字符串后再重新双击本文件。
  pause
  exit /b 1
)

set "REPO_NAME="
set /p REPO_NAME=仓库名（直接回车 = workbuddy-daily）: 
if not defined REPO_NAME set "REPO_NAME=workbuddy-daily"

set "NODE_EXE="
set "CAND1=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if exist "%CAND1%" set "NODE_EXE=%CAND1%"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"
if not defined NODE_EXE (
  echo [错误] 找不到 node.exe。
  pause
  exit /b 1
)

echo.
echo 开始配置，大约需要 1-3 分钟，请勿关闭本窗口……
echo.
pushd "%~dp0.."
"%NODE_EXE%" "scripts\setup-github.mjs" --repo-name "%REPO_NAME%"
set "RC=%ERRORLEVEL%"
popd

echo.
if "%RC%"=="0" (
  echo [完成] 全部搞定！以后每天北京时间 09:00 云端自动执行，与电脑开关机无关。
  echo        看台账：双击本目录里的「同步台账.bat」。
) else (
  echo [未完成] 请看上方的具体提示，修好后重新双击本文件即可。
  echo          重复运行是安全的，已完成的步骤会自动跳过。
)

echo.
echo 按任意键关闭窗口……
pause >nul
endlocal
