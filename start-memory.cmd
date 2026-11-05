@echo off
rem Starts Conversation Memory on http://localhost:3000 (keeps a log in logs\server.log next to this file).
cd /d "%~dp0"
if not exist logs mkdir logs
npm run start >> logs\server.log 2>&1
