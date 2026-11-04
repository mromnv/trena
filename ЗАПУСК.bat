@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TRENA
set NODE=%~dp0tools\node\node.exe
set NPM=%~dp0tools\node\npm.cmd

if not exist "%NODE%" (
  echo Node.js not found in tools\node
  echo Download portable Node or install Node.js, then retry.
  pause
  exit /b 1
)

if not exist "%~dp0apps\server\node_modules" (
  echo Installing dependencies...
  pushd "%~dp0apps\server"
  call "%NPM%" install --no-fund --no-audit
  popd
)

echo.
echo  ========================================
echo                 TRENA
echo  ========================================
echo  Starting server...
echo  Open http://127.0.0.1:8765/
echo  Do not close this window.
echo.

start "" http://127.0.0.1:8765/
"%NODE%" "%~dp0apps\server\src\index.js"
echo.
echo  Server stopped.
pause
