// =============================================================================
// HYDRA-UMC-SERVER - src/logRotation.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
import fs from "node:fs";

/** How many rotated files to keep next to the live log; 1 keeps only `<file>.1`, as before. */
export function resolveLogKeep(raw: string | undefined): number {
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 50);
}

/** Size, in bytes, at which the live log is rotated; unset or invalid keeps 10 MB. */
export function resolveLogMaxBytes(raw: string | undefined): number {
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 64 * 1024) return 10 * 1024 * 1024;
  return parsed;
}

/**
 * Shift `<file>.(n-1)` to `<file>.n`, ..., `<file>` to `<file>.1`, dropping what falls past `keep`.
 * The live file no longer exists afterwards; the caller opens a new one.
 */
export function rotateLogFiles(file: string, keep: number): void {
  fs.rmSync(`${file}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    if (fs.existsSync(`${file}.${index}`)) fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}
