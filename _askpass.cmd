@echo off
echo %1| findstr /b "Username" >nul && (echo uorzen) || (echo %GITHUB_PASSWORD%)
