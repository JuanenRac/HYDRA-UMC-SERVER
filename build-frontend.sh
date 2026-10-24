#!/bin/bash
# HYDRA_UMC_SCRIPT_STANDARD_HEADER_BEGIN
# *****************************************************************************
# Project   : HYDRA-UMC-SERVER
# Script    : build-frontend.sh
# Purpose   : Incremental frontend bundle build and publication workflow.
# Author    : JuanenRac (Electro Hobby 3D)
# Email     : electrohobby3d@gmail.com
# Copyright : (C) 2026 JuanenRac
# License   : GPL-3.0 - see LICENSE
# *****************************************************************************
# HYDRA_UMC_SCRIPT_STANDARD_HEADER_END
# HYDRA_UMC_SCRIPT_STANDARD_BANNER_BEGIN
printf '\n*******************************************************************************\n'
printf '%s\n' "* HYDRA-UMC-SERVER - build-frontend.sh"
printf '%s\n' "* Mode      : INCREMENTAL BUILD"
printf '%s\n' "* Author    : JuanenRac (Electro Hobby 3D)"
printf '%s\n' "* Email     : electrohobby3d@gmail.com"
printf '%s\n' "* Copyright : (C) 2026 JuanenRac"
printf '%s\n' "* License   : GPL-3.0 - see LICENSE"
printf '%s\n' "* ------------------------------------------------------------------------- *"
printf '%s\n' "* 1. Read the project version (building never changes it; use the explicit bump command)."
printf '%s\n' "* 2. Run this project's declared build, verification and packaging commands."
printf '%s\n' "* 3. Report the result and keep an interactive terminal open."
printf '%s\n' "*******************************************************************************"
printf '\n'
# HYDRA_UMC_SCRIPT_STANDARD_BANNER_END

# HYDRA_UMC_SCRIPT_STANDARD_SAFE_PAUSE
# Prompt only in an interactive terminal: CI, pipes and service launchers never block.
hydra_umc_pause_on_exit() {
    local status=$?
    if [[ -t 0 && -t 1 ]]; then
        printf '\nPress Enter to close this window...'
        read -r _
    fi
    return "$status"
}
trap 'hydra_umc_pause_on_exit' EXIT

#
# Optional step - see src/server.ts's own header comment. This server can
# run perfectly headless without ever calling this script (public/ simply
# won't exist, and server.ts already handles that: no frontend served at
# "/" or "/admin", everything else unaffected). Run this once (and again
# after pulling STUDIO changes, or changing anything under admin-ui/) to
# make this server ALSO serve:
#   - HYDRA-UMC STUDIO's own 3D viewport/dashboard at "/" - the same URL
#     HYDRA-UMC-ANDROID-CONTROL, HYDRA-UMC-IOS-CONTROL and HYDRA-UMC-DSI
#     already embed in their own in-app WebViews.
#   - This repo's OWN admin-ui/ (server/fleet administration - devices,
#     logs, config, users - NOT robot control) at "/admin".
#
# Assumes the standard ecosystem checkout layout for STUDIO: sitting right
# next to this repo (../HYDRA-UMC-STUDIO) - the same assumption
# HYDRA-UMC-SUITE and every other cross-repo tool in this ecosystem already
# makes, not a new convention invented here. admin-ui/ is source IN this
# repo, no cross-repo assumption needed for it.
# Building never changes the version; npm build commands are compile-only.
# HYDRA_UMC_SCRIPT_STANDARD_VERSION_STEP
printf '%s\n' "[1/3] Reading the project version (building never changes it)..."
HYDRA_UMC_VERSION_BUILT="$(python3 -c 'import json, pathlib, sys; print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["version"])' "$(dirname "$0")/hydra-umc.project.json")"
printf '%s\n' "      Building v${HYDRA_UMC_VERSION_BUILT:-unknown} (building never changes the version)"
echo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUDIO_DIR="$SCRIPT_DIR/../HYDRA-UMC-STUDIO"

if [ ! -d "$STUDIO_DIR" ]; then
  echo "ERROR: HYDRA-UMC-STUDIO not found at $STUDIO_DIR"
  echo "This script expects the standard ecosystem checkout layout - clone"
  echo "HYDRA-UMC-STUDIO as a sibling of this repo (same parent directory)."
  exit 1
fi

echo "========================================"
echo " Building HYDRA-UMC STUDIO ($STUDIO_DIR)"
echo "========================================"
(cd "$STUDIO_DIR" && npm install && npm run build)
if [ $? -ne 0 ]; then
  echo ""
  echo "STUDIO build FAILED."
  exit 1
fi

echo "========================================"
echo " Copying build output into public/"
echo "========================================"
rm -rf "$SCRIPT_DIR/public"
mkdir -p "$SCRIPT_DIR/public"
cp -r "$STUDIO_DIR/dist/." "$SCRIPT_DIR/public/"
# STUDIO's own public/settings.json and public/WORKS/RobotA1..8 are that
# repo's OWN standalone-dev demo data (committed there on purpose, for
# running STUDIO's Vite dev server with no real backend at all) - Vite
# copies its whole public/ verbatim into dist/, so they land here too.
# This server already has its OWN authoritative settings.json/WORKS under
# data/ (see dataPath above, mounted BEFORE this one so real data always
# wins) - removing STUDIO's demo copies here instead of leaving them as
# unused dead weight that could confuse anyone poking at public/ directly.
rm -rf "$SCRIPT_DIR/public/WORKS"
rm -f "$SCRIPT_DIR/public/settings.json"

echo "========================================"
echo " Building this repo's own admin-ui/"
echo "========================================"
(cd "$SCRIPT_DIR/admin-ui" && npm install && npm run build)
if [ $? -ne 0 ]; then
  echo ""
  echo "admin-ui build FAILED."
  exit 1
fi

echo "========================================"
echo " Copying admin-ui build output into public/admin/"
echo "========================================"
mkdir -p "$SCRIPT_DIR/public/admin"
cp -r "$SCRIPT_DIR/admin-ui/dist/." "$SCRIPT_DIR/public/admin/"

# The dashboard of the AI summaries (HYDRA-UMC-DASHBOARD-AI), when it is checked out next to this repo: served at /dashboard-ai, behind the
# sessions and roles of this server. It is optional; without it nothing is served there.
DASHBOARD_AI_DIR="$SCRIPT_DIR/../HYDRA-UMC-DASHBOARD-AI"
if [ -d "$DASHBOARD_AI_DIR" ]; then
  echo "========================================"
  echo " Building HYDRA-UMC-DASHBOARD-AI ($DASHBOARD_AI_DIR)"
  echo "========================================"
  (cd "$DASHBOARD_AI_DIR" && npm install && npm run build)
  if [ $? -ne 0 ]; then
    echo ""
    echo "DASHBOARD-AI build FAILED."
    exit 1
  fi
  mkdir -p "$SCRIPT_DIR/public/dashboard-ai"
  cp -r "$DASHBOARD_AI_DIR/dist/." "$SCRIPT_DIR/public/dashboard-ai/"
else
  echo "HYDRA-UMC-DASHBOARD-AI not found next to this repo - the AI dashboard is not served at /dashboard-ai."
fi

echo ""
echo "Done - this server will now serve STUDIO's frontend at \"/\" and its"
echo "own admin UI at \"/admin\" the next time it starts (npm run dev /"
echo "npm start)."
printf '%s\n' "Built v${HYDRA_UMC_VERSION_BUILT:-unknown}. Building never changes the version; to raise it run: python tools/hydra_project_tool.py bump"
