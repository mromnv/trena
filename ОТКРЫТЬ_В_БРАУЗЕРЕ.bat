@echo off
chcp 65001 >nul
echo Opening TRENA...
powershell -NoProfile -Command "foreach($p in 8765,8766,8767,8768,8770,8780){ try { $r=Invoke-RestMethod \"http://127.0.0.1:$p/api/status\" -TimeoutSec 1; if($r.ok){ Start-Process \"http://127.0.0.1:$p/\"; exit 0 } } catch {} }; Start-Process '%~dp0index.html'"
