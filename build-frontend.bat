@echo off
REM HYDRA_UMC_SCRIPT_STANDARD_HEADER_BEGIN
REM *****************************************************************************
REM Project   : HYDRA-UMC-SERVER
REM Script    : build-frontend.bat
REM Purpose   : Incremental frontend bundle build and publication workflow.
REM Author    : JuanenRac (Electro Hobby 3D)
REM Email     : electrohobby3d@gmail.com
REM Copyright : (C) 2026 JuanenRac
REM License   : GPL-3.0 - see LICENSE
REM *****************************************************************************
REM HYDRA_UMC_SCRIPT_STANDARD_HEADER_END
REM HYDRA_UMC_SCRIPT_STANDARD_BANNER_BEGIN
echo.
echo *****************************************************************************
echo * HYDRA-UMC-SERVER - build-frontend.bat
echo * Mode      : INCREMENTAL BUILD
echo * Author    : JuanenRac (Electro Hobby 3D)
echo * Email     : electrohobby3d@gmail.com
echo * Copyright : (C) 2026 JuanenRac
echo * License   : GPL-3.0 - see LICENSE
echo * ------------------------------------------------------------------------- *
echo * 1. Increment the project version and synchronise its manifest.
echo * 2. Run this project's declared build, verification and packaging commands.
echo * 3. Report the result and keep an interactive terminal open.
echo *****************************************************************************
echo.
REM HYDRA_UMC_SCRIPT_STANDARD_BANNER_END
REM
REM Optional step - see src/server.ts's own header comment. This server can
REM run perfectly headless without ever calling this script (public/ simply
REM won't exist, and server.ts already handles that: no frontend served at
REM "/" or "/admin", everything else unaffected). Run this once (and again
REM after pulling STUDIO changes, or changing anything under admin-ui/) to
REM make this server ALSO serve:
REM   - HYDRA-UMC STUDIO's own 3D viewport/dashboard at "/" - the same URL
REM     HYDRA-UMC-ANDROID-CONTROL, HYDRA-UMC-IOS-CONTROL and HYDRA-UMC-DSI
REM     already embed in their own in-app WebViews.
REM   - This repo's OWN admin-ui/ (server/fleet administration - devices,
REM     logs, config, users - NOT robot control) at "/admin".
REM
REM Assumes the standard ecosystem checkout layout for STUDIO: sitting right
REM next to this repo (..\HYDRA-UMC-STUDIO) - the same assumption
REM HYDRA-UMC-SUITE and every other cross-repo tool in this ecosystem already
REM makes, not a new convention invented here. admin-ui/ is source IN this
REM repo, no cross-repo assumption needed for it.
REM The synchronized manifest bump below is this optional build's only version
REM mutation. npm build commands invoked later are intentionally compile-only.
REM HYDRA_UMC_SCRIPT_STANDARD_VERSION_STEP
echo [1/3] Incrementing project version and synchronising its manifest...
REM HYDRA_UMC_SCRIPT_STANDARD_VERSION_CAPTURE_BEFORE
for /f "usebackq delims=" %%V in (`python -c "import json; print(json.load(open(r'%~dp0hydra-umc.project.json', encoding='utf-8'))['version'])"`) do set "HYDRA_UMC_VERSION_BEFORE=%%V"
python "%~dp0bump_manifest_version.py"
if errorlevel 1 ( echo VERSION BUMP FAILED. & pause & exit /b 1 )
REM HYDRA_UMC_SCRIPT_STANDARD_VERSION_CAPTURE_AFTER
for /f "usebackq delims=" %%V in (`python -c "import json; print(json.load(open(r'%~dp0hydra-umc.project.json', encoding='utf-8'))['version'])"`) do set "HYDRA_UMC_VERSION_AFTER=%%V"
if not defined HYDRA_UMC_VERSION_BEFORE set "HYDRA_UMC_VERSION_BEFORE=unknown"
if not defined HYDRA_UMC_VERSION_AFTER set "HYDRA_UMC_VERSION_AFTER=unknown"
echo.
echo *****************************************************************************
echo * VERSION INCREMENT COMPLETED
echo * v%HYDRA_UMC_VERSION_BEFORE% ^> v%HYDRA_UMC_VERSION_AFTER%
echo * Project manifest has been synchronised by the project build flow.
echo *****************************************************************************
echo.
echo.
set "SCRIPT_DIR=%~dp0"
set "STUDIO_DIR=%SCRIPT_DIR%..\HYDRA-UMC-STUDIO"

if not exist "%STUDIO_DIR%" (
  echo ERROR: HYDRA-UMC-STUDIO not found at %STUDIO_DIR%
  echo This script expects the standard ecosystem checkout layout - clone
  echo HYDRA-UMC-STUDIO as a sibling of this repo ^(same parent directory^).
  pause
  exit /b 1
)

echo ========================================
echo  Building HYDRA-UMC STUDIO ^(%STUDIO_DIR%^)
echo ========================================
pushd "%STUDIO_DIR%"
call npm install
if errorlevel 1 (
  popd
  echo.
  echo STUDIO build FAILED.
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  popd
  echo.
  echo STUDIO build FAILED.
  pause
  exit /b 1
)
popd

echo ========================================
echo  Copying build output into public\
echo ========================================
if exist "%SCRIPT_DIR%public" rmdir /s /q "%SCRIPT_DIR%public"
mkdir "%SCRIPT_DIR%public"
xcopy "%STUDIO_DIR%\dist\*" "%SCRIPT_DIR%public\" /e /i /y >nul
REM STUDIO's own public/settings.json and public/WORKS/RobotA1..8 are that
REM repo's OWN standalone-dev demo data (committed there on purpose, for
REM running STUDIO's Vite dev server with no real backend at all) - Vite
REM copies its whole public/ verbatim into dist/, so they land here too.
REM This server already has its OWN authoritative settings.json/WORKS under
REM data/ (see dataPath in src/server.ts, mounted BEFORE this one so real
REM data always wins) - removing STUDIO's demo copies here instead of
REM leaving them as unused dead weight that could confuse anyone poking at
REM public\ directly.
if exist "%SCRIPT_DIR%public\WORKS" rmdir /s /q "%SCRIPT_DIR%public\WORKS"
if exist "%SCRIPT_DIR%public\settings.json" del /q "%SCRIPT_DIR%public\settings.json"

echo ========================================
echo  Building this repo's own admin-ui\
echo ========================================
pushd "%SCRIPT_DIR%admin-ui"
call npm install
if errorlevel 1 (
  popd
  echo.
  echo admin-ui build FAILED.
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  popd
  echo.
  echo admin-ui build FAILED.
  pause
  exit /b 1
)
popd

echo ========================================
echo  Copying admin-ui build output into public\admin\
echo ========================================
mkdir "%SCRIPT_DIR%public\admin"
xcopy "%SCRIPT_DIR%admin-ui\dist\*" "%SCRIPT_DIR%public\admin\" /e /i /y >nul

echo.
echo Done - this server will now serve STUDIO's frontend at "/" and its own
echo admin UI at "/admin" the next time it starts (npm run dev / npm start).

REM HYDRA_UMC_SCRIPT_STANDARD_SAFE_PAUSE
set "HYDRA_UMC_SCRIPT_RESULT=%ERRORLEVEL%"
echo.
echo [INFO] Script completed. Exit code: %HYDRA_UMC_SCRIPT_RESULT%.
pause
exit /b %HYDRA_UMC_SCRIPT_RESULT%
