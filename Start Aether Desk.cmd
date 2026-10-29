@echo off
setlocal
cd /d "%~dp0"
title Aether Desk
set "NODE_EXE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE (
  echo Node.js was not found. Install the LTS version from https://nodejs.org, then try again.
  pause
  exit /b 1
)
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"
"%NODE_EXE%" -e "if(Number(process.versions.node.split('.')[0])<22)process.exit(1)"
if errorlevel 1 (
  echo Aether Desk requires Node.js 22 or newer. Install the LTS version from https://nodejs.org.
  pause
  exit /b 1
)
"%NODE_EXE%" -e "require.resolve('express');require.resolve('dotenv')" >nul 2>&1
if errorlevel 1 (
  echo Installing Aether Desk dependencies for the first launch. Internet access is required.
  if not exist "%NODE_DIR%npm.cmd" (
    echo npm was not found beside Node.js. Reinstall Node.js with npm included.
    pause
    exit /b 1
  )
  call "%NODE_DIR%npm.cmd" ci --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
"%NODE_EXE%" launcher.js
if errorlevel 1 (
  echo.
  echo Aether Desk could not start. See the message above.
  pause
  exit /b 1
)
