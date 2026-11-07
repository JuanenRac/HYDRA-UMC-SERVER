// =============================================================================
// HYDRA-UMC-SERVER - src/detectionHefSettings.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The settings file of HYDRA-UMC-DETECTION-HEF: {"acceptLoadedReports": true|false}. This server writes it when an administrator changes the
// switch of Server Admin (detectionHef.acceptLoadedReports); that service only reads it, again whenever its size or time changes, so the
// switch works without a restart. The file is written whole to a temporary name and renamed over the old one, so the service never reads half of it,
// and it is readable by its owner and group only (0640).
import fs from "node:fs";
import path from "node:path";

export const DETECTION_HEF_SETTINGS_NAME = "detection-hef-settings.json";
export const DETECTION_HEF_SETTINGS_MODE = 0o640;

/** Where the file goes: the one the configuration names, else data/detection-hef-settings.json. A relative name is relative to the data folder. */
export function detectionHefSettingsPath(dataPath: string, configured: string | undefined): string {
  const name = typeof configured === "string" ? configured.trim() : "";
  if (!name) return path.join(dataPath, DETECTION_HEF_SETTINGS_NAME);
  if (name.includes("\0")) throw new Error("the settings file name has a character that is not allowed");
  return path.resolve(dataPath, name);
}

/** The exact bytes of the file (a small JSON object and a line end). */
export function detectionHefSettingsText(acceptLoadedReports: boolean): string {
  return `${JSON.stringify({ acceptLoadedReports })}\n`;
}

/** Writes the file; returns the path it wrote. Throws when the folder cannot be written (the caller tells the administrator). */
export function writeDetectionHefSettings(dataPath: string, acceptLoadedReports: boolean, configured?: string): string {
  const target = detectionHefSettingsPath(dataPath, configured);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, detectionHefSettingsText(acceptLoadedReports), { encoding: "utf8", mode: DETECTION_HEF_SETTINGS_MODE });
    try { fs.chmodSync(temporary, DETECTION_HEF_SETTINGS_MODE); } catch { /* a file system without modes (Windows): nothing to set */ }
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* nothing left to remove */ }
    throw error;
  }
  return target;
}
