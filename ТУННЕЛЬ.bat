@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TRENA Tunnel
echo.
echo  Keep ЗАПУСК / server running on port 8765
echo  Keep this window open and send the https link to your friend.
echo  Using localhost.run (more stable than localtunnel)
echo.
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R 80:127.0.0.1:8765 nokey@localhost.run
echo.
echo  Tunnel stopped.
pause
