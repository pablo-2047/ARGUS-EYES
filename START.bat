@echo off
title ARGUS EYES
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org  ^(v18 or newer^)
  pause
  exit /b 1
)
start "" http://localhost:8080
node server.js
pause
