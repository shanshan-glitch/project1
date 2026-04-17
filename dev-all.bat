@echo off
cd /d "%~dp0"
echo 将同时启动：sync-server (3789) + 前端 (5173)
echo 请勿关闭本窗口，关闭后两个服务都会停止。
echo.
npm.cmd run dev:all
pause
