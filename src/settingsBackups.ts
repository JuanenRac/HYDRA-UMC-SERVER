// =============================================================================
// HYDRA-UMC-SERVER - src/settingsBackups.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Copies of settings.json kept next to the data, the one-time copy taken when an existing
// installation first uses the transactional store, and the way back when settings.json itself
// is found damaged.
import fs from "node:fs";
import path from "node:path";

export const BACKUP_DIR = "backups";
const BACKUP_PREFIX = "settings-";

const stamp = (when: number) => new Date(when).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export function backupDirOf(dataDir: string): string {
  return path.join(dataDir, BACKUP_DIR);
}

function listBackups(dataDir: string): string[] {
  try {
    return fs
      .readdirSync(backupDirOf(dataDir))
      .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Copies settings.json into backups/ unless a copy newer than `intervalMs` exists, then keeps the
 * newest `keep` copies. `keep` 0 turns the copies off. Returns the new copy, or null.
 */
export function backupSettings(dataDir: string, settingsPath: string, keep: number, intervalMs: number, now: number = Date.now()): string | null {
  if (keep <= 0) return null;
  if (!fs.existsSync(settingsPath)) return null;
  const existing = listBackups(dataDir);
  const newest = existing.at(-1);
  if (newest && intervalMs > 0) {
    try {
      if (now - fs.statSync(path.join(backupDirOf(dataDir), newest)).mtimeMs < intervalMs) return null;
    } catch {
      /* fall through and take a new copy */
    }
  }
  const target = path.join(backupDirOf(dataDir), `${BACKUP_PREFIX}${stamp(now)}.json`);
  fs.mkdirSync(backupDirOf(dataDir), { recursive: true });
  fs.copyFileSync(settingsPath, target);
  const all = listBackups(dataDir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    try { fs.unlinkSync(path.join(backupDirOf(dataDir), old)); } catch { /* best effort */ }
  }
  return target;
}

/** The newest backup that still parses as JSON, or null. */
export function latestValidBackup(dataDir: string): { path: string; text: string } | null {
  for (const name of listBackups(dataDir).reverse()) {
    const file = path.join(backupDirOf(dataDir), name);
    try {
      const text = fs.readFileSync(file, "utf-8");
      JSON.parse(text);
      return { path: file, text };
    } catch {
      continue;
    }
  }
  return null;
}

export const STORE_META_FILE = "store-meta.json";

/**
 * The first start of the transactional store on an installation that already has settings: a full
 * copy of settings.json and of the points files goes to backups/pre-store-<time>/ and
 * store-meta.json records it. The files keep their format, so nothing is converted and an older
 * server can still read them. Returns the copy directory, or null when nothing was needed.
 */
export function migrateToStore(dataDir: string, now: number = Date.now()): string | null {
  const meta = path.join(dataDir, STORE_META_FILE);
  if (fs.existsSync(meta)) return null;
  const settings = path.join(dataDir, "settings.json");
  let target: string | null = null;
  if (fs.existsSync(settings)) {
    target = path.join(backupDirOf(dataDir), `pre-store-${stamp(now)}`);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(settings, path.join(target, "settings.json"));
    const points = path.join(dataDir, "points");
    if (fs.existsSync(points)) fs.cpSync(points, path.join(target, "points"), { recursive: true });
  }
  fs.writeFileSync(meta, JSON.stringify({ schema: 1, store: "journal", migratedAt: new Date(now).toISOString(), copy: target ? path.basename(target) : null }, null, 2));
  return target;
}
