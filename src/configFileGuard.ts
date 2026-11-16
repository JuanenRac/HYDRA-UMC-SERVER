// =============================================================================
// HYDRA-UMC-SERVER - src/configFileGuard.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// What to do with a saved options file that exists but cannot be understood (damaged, cut in half, or holding a value this version refuses).
// A file that is simply not there is a fresh install and starts from the defaults; a file that is there and unreadable is different: the
// options in it (the jog arming, the lowered limits, TLS, the trusted networks) would be dropped without a word and the next save would
// make the loss permanent. So the server keeps a copy of the file next to it and refuses to start, naming the file and the way out. An
// administrator who wants to start anyway, on the defaults, sets HYDRA_UMC_ALLOW_DAMAGED_CONFIG=1 for that start.
import fs from "node:fs";

export const ALLOW_DAMAGED_VARIABLE = "HYDRA_UMC_ALLOW_DAMAGED_CONFIG";

export class DamagedConfigError extends Error {
  constructor(message: string, readonly file: string, readonly copy: string | null) {
    super(message);
    this.name = "DamagedConfigError";
  }
}

/** Only the exact word "1" lets the server start on the defaults over a file it cannot understand. */
export function damagedConfigAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return (env[ALLOW_DAMAGED_VARIABLE] ?? "").trim() === "1";
}

/** Copies the damaged file next to itself (owner-only, never over an earlier copy); the path of the copy, or null when it could not be made. */
export function keepDamagedCopy(file: string, now: number = Date.now()): string | null {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
  for (let n = 0; n < 100; n += 1) {
    const copy = `${file}.damaged-${stamp}${n === 0 ? "" : `-${n}`}`;
    try {
      fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(copy, 0o600); } catch { /* the copy is still kept */ }
      return copy;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      return null;
    }
  }
  return null;
}

/**
 * Called when `file` exists and cannot be understood. Keeps a copy and throws, unless the administrator allowed the start on the defaults
 * (then it logs what happened and returns, and the caller uses the defaults).
 */
export function refuseDamagedConfig(file: string, reason: string, log: (message: string) => void = () => undefined, env: Record<string, string | undefined> = process.env): void {
  const copy = keepDamagedCopy(file);
  const kept = copy ? `a copy was kept at ${copy}` : "no copy could be made";
  if (damagedConfigAllowed(env)) {
    log(`[CONFIG] ${file} cannot be understood (${reason}); ${kept}. ${ALLOW_DAMAGED_VARIABLE}=1 is set, so the defaults are used for this start.`);
    return;
  }
  throw new DamagedConfigError(
    `${file} exists but cannot be understood (${reason}); ${kept}. The server does not start with it because the options saved in it would be dropped without a word. Repair or remove the file, or start once with ${ALLOW_DAMAGED_VARIABLE}=1 to use the defaults.`,
    file,
    copy,
  );
}
