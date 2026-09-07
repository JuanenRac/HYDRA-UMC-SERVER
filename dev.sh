#!/bin/bash
# =============================================================================
# HYDRA-UMC SERVER - Development Server Start Script
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0 - see LICENSE
# =============================================================================

echo "========================================"
echo " HYDRA-UMC SERVER"
echo " Development Server Start Script - installs dependencies and starts the dev server"
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
echo " Starting HYDRA-UMC SERVER (Dev Mode) "
echo "========================================"
if npm run dev; then
  read -p "Press Enter to close..."
else
  echo ""
  echo "HYDRA-UMC SERVER exited with an error."
  read -p "Press Enter to close..."
  exit 1
fi
