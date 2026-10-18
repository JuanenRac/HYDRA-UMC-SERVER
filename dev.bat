@echo off
cd /d "%~dp0"
rem Keep the window open for people, never in automation (CI / HYDRA_UMC_CI).
set "KEEP_OPEN=pause"
if defined CI set "KEEP_OPEN=ver >nul"
if "%HYDRA_UMC_CI%"=="1" set "KEEP_OPEN=ver >nul"
REM =============================================================================
REM HYDRA-UMC SERVER - Development Server Start Script
REM Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
REM GPL-3.0 - see LICENSE
REM =============================================================================

echo ========================================
echo  HYDRA-UMC SERVER
echo  Development Server Start Script - installs dependencies and starts the dev server
echo  Author: JuanenRac (Electro Hobby 3D)
echo  E-mail: electrohobby3d@gmail.com
echo  License: GPL-3.0 - see LICENSE
echo ========================================
echo.

echo ========================================
echo  Installing dependencies...
echo ========================================
call npm install
call npm install-scripts approve --all

echo ========================================
echo  Starting HYDRA-UMC SERVER (Dev Mode)
echo ========================================
call npm run dev
if errorlevel 1 (
  echo.
  echo HYDRA-UMC SERVER exited with an error.
  %KEEP_OPEN%
  exit /b 1
)
%KEEP_OPEN%
