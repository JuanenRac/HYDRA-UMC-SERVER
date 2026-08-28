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
printf '%s\n' "* 1. Increment the project version and synchronise its manifest."
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
# The synchronized manifest bump below is this optional build's only version
# mutation. npm build commands invoked later are intentionally compile-only.
# HYDRA_UMC_SCRIPT_STANDARD_VERSION_STEP
printf '%s\n' "[1/3] Incrementing project version and synchronising its manifest..."
# HYDRA_UMC_SCRIPT_STANDARD_VERSION_CAPTURE_BEFORE
HYDRA_UMC_VERSION_BEFORE="$(python3 -c 'import json, pathlib, sys; print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["version"])' "$(dirname "$0")/hydra-umc.project.json")"
python3 "$(dirname "$0")/bump_manifest_version.py" || exit 1
# HYDRA_UMC_SCRIPT_STANDARD_VERSION_CAPTURE_AFTER
HYDRA_UMC_VERSION_AFTER="$(python3 -c 'import json, pathlib, sys; print(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["version"])' "$(dirname "$0")/hydra-umc.project.json")"
printf '\n*******************************************************************************\n'
printf '%s\n' '* VERSION INCREMENT COMPLETED'
printf '%s\n' "* v${HYDRA_UMC_VERSION_BEFORE:-unknown} -> v${HYDRA_UMC_VERSION_AFTER:-unknown}"
printf '%s\n' '* Project manifest has been synchronised by the project build flow.'
printf '%s\n' '*******************************************************************************'
printf '\n'
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

echo ""
echo "Done - this server will now serve STUDIO's frontend at \"/\" and its"
echo "own admin UI at \"/admin\" the next time it starts (npm run dev /"
echo "npm start)."
