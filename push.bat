@echo off
cd /d "%~dp0"
set "LOG=%~dp0push_log.txt"
echo [%date% %time%] === push start === > "%LOG%"

rem GitHub must go through local proxy (direct connection fails); socks5 is more stable than http mode
set "HTTPS_PROXY=socks5://127.0.0.1:7897"
set "HTTP_PROXY=socks5://127.0.0.1:7897"

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] git not found in PATH. Install Git for Windows, or run these commands in Git Bash instead.
  echo [ERROR] git not found in PATH >> "%LOG%"
  pause
  exit /b 1
)

git --version >> "%LOG%" 2>&1
git init >> "%LOG%" 2>&1
git config user.name "uorzen" >> "%LOG%" 2>&1
git config user.email "uorzen@users.noreply.github.com" >> "%LOG%" 2>&1
git add . >> "%LOG%" 2>&1
git commit -m "update tauri project" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [WARN] nothing new to commit, will push current HEAD.
)
git branch -M main >> "%LOG%" 2>&1
git remote remove origin >nul 2>&1
git remote add origin https://github.com/uorzen/-image-downloader-tauri.git >> "%LOG%" 2>&1
git push -u origin main >> "%LOG%" 2>&1

echo push exit code: %errorlevel% >> "%LOG%"
if errorlevel 1 (
  echo [FAIL] push failed. Open push_log.txt in this folder to see why.
) else (
  echo [OK] pushed to GitHub. Go to Actions tab to watch the build, then Releases to download.
)
pause
