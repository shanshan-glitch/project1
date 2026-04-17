@echo off
cd /d "%~dp0"
echo Starting Feishu sync server...
node server/sync-server.mjs
if errorlevel 1 pause
