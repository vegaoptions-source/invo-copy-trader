@echo off
REM Double-click to start the Invo copy trader.
REM To stop it: press Ctrl+C, then Y, or just close this window.
title Invo Copy Trader
cd /d "%~dp0"
if not exist ".env" (
  echo.
  echo  Missing .env file. Copy .env.example to .env and fill in your values first.
  echo.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Installing dependencies, one moment...
  call npm install
)
:loop
echo.
echo [%date% %time%] Starting the Invo copy trader (log also saved to autocopy.log)
echo.
call npx tsx src/commands/autocopy.ts
echo.
echo [%date% %time%] The copier stopped. Restarting in 30 seconds - close this window to stop for good.
timeout /t 30
goto loop
