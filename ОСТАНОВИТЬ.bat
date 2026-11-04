@echo off
chcp 65001 >nul
echo Stopping TRENA...
powershell -NoProfile -Command "foreach($p in 8765,8766,8767,8768,8770,8780){ Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"
echo Done.
pause
