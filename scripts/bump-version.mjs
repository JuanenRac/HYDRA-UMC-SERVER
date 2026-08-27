// =============================================================================
// HYDRA-UMC SERVER - Build-time version bump: scripts/bump-version.mjs
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Runs as the first step of `npm run build` (see the "build" script in
// package.json) so every real production build bumps package.json's own
// "version" field automatically - no manual version bumps, no builds that
// silently ship under the previous number. Copied/adapted from
// HYDRA-UMC-STUDIO's own scripts/bump-version.mjs - same ecosystem-wide
// convention, applied here unchanged.
//
// Increment rule ("odometer" in base 10, ecosystem-wide convention):
//   - patch +1
//   - patch > 9  -> patch = 0, minor +1
//   - minor > 9  -> minor = 0, major +1 (cascades the same way, in case a
//                   minor carry pushes major over 9 too)
// Example: 1.0.9 -> 1.1.0 (not 1.0.10). 1.9.9 -> 2.0.0.
//
// Deliberately dependency-free (plain Node fs/path) since this has to run
// before any bundler/dependency is guaranteed built, and it's a 5-line job
// that doesn't warrant pulling in semver or similar.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.join(__dirname, "..", "package.json");

const raw = readFileSync(pkgPath, "utf-8");
const pkg = JSON.parse(raw);

const parts = String(pkg.version || "0.0.0").split(".").map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
  throw new Error(`bump-version: unexpected "version" format in package.json: "${pkg.version}"`);
}
let [major, minor, patch] = parts;

patch += 1;
if (patch > 9) {
  patch = 0;
  minor += 1;
}
if (minor > 9) {
  minor = 0;
  major += 1;
}

const nextVersion = `${major}.${minor}.${patch}`;
pkg.version = nextVersion;

// Preserve the file's existing style: 2-space indent, single trailing newline.
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

console.log(`[bump-version] package.json version -> ${nextVersion}`);
