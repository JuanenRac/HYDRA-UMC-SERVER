#!/bin/bash
# =============================================================================
# HYDRA-UMC SERVER - Build and Compile Script
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0 - see LICENSE
# =============================================================================
python3 "$(dirname "$0")/bump_manifest_version.py" || exit 1

echo "========================================"
echo " HYDRA-UMC SERVER"
echo " Build and Compile Script - installs dependencies and compiles the app"
echo " Author: JuanenRac (Electro Hobby 3D)"
echo " E-mail: electrohobby3d@gmail.com"
echo " License: GPL-3.0 - see LICENSE"
echo "========================================"
echo ""

echo "========================================"
echo " Installing dependencies... "
echo "========================================"
npm install
npm install-scripts approve --all

echo "========================================"
echo " Compiling HYDRA-UMC SERVER (Prod Mode) "
echo "========================================"
if npm run build; then
  echo ""
  echo "Build complete! You can now start the production server with:"
  echo "npm start"
  read -p "Press Enter to close..."
else
  echo ""
  echo "Build FAILED."
  read -p "Press Enter to close..."
  exit 1
fi
