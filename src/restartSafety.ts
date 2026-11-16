// =============================================================================
// HYDRA-UMC-SERVER - src/restartSafety.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// What must survive a restart of the server so that a restart can never undo a stop:
//   - the global stop (POST /api/stop-all): written to data/global-stop.json BEFORE the answer, read again at start-up, removed only by
//     POST /api/stop-all/release (an administrator);
//   - the attempts of the job executor that were already started (data/job-executor-attempts.json): after a restart the executor never starts
//     the same attempt of a job again, so a restart does not play a trajectory a second time on its own.
// Every write is atomic (a temporary file, flushed, then renamed over the real one). A file that is there but can not be read is read as
// "stopped" and as "attempts unknown": a damaged record never lets anything move.
import fs from "node:fs";
import path from "node:path";

export const GLOBAL_STOP_FILE = "global-stop.json";
export const EXECUTOR_ATTEMPTS_FILE = "job-executor-attempts.json";

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(handle, content, "utf-8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* the original error is the one to report */ }
    throw error;
  }
}

export type GlobalStopRecord =
  | { stopped: false }
  | { stopped: true; since: string | null; by: string | null; damaged: boolean };

/** Writes the global stop to disk. Never throws: false means it could not be written (the stop itself is still applied in memory). */
export function persistGlobalStop(dataDir: string, by: string, now: () => number = Date.now): boolean {
  try {
    const previous = readGlobalStop(dataDir);
    const since = previous.stopped && !previous.damaged && previous.since ? previous.since : new Date(now()).toISOString();
    writeAtomic(path.join(dataDir, GLOBAL_STOP_FILE), `${JSON.stringify({ schema: 1, stopped: true, since, by }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The global stop as the disk keeps it. A missing file is "not stopped"; a file that can not be read or understood is "stopped" (damaged). */
export function readGlobalStop(dataDir: string): GlobalStopRecord {
  const file = path.join(dataDir, GLOBAL_STOP_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { stopped: false };
    return { stopped: true, since: null, by: null, damaged: true };
  }
  try {
    const parsed = JSON.parse(text) as { stopped?: unknown; since?: unknown; by?: unknown };
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    if (parsed.stopped === false) return { stopped: false };
    if (parsed.stopped !== true) throw new Error("no state");
    return { stopped: true, since: typeof parsed.since === "string" ? parsed.since : null, by: typeof parsed.by === "string" ? parsed.by : null, damaged: false };
  } catch {
    return { stopped: true, since: null, by: null, damaged: true };
  }
}

/** Removes the written global stop (the release). False when it could not be removed: the release is then refused and the server stays stopped. */
export function clearGlobalStop(dataDir: string): boolean {
  try {
    fs.rmSync(path.join(dataDir, GLOBAL_STOP_FILE), { force: true });
    return !fs.existsSync(path.join(dataDir, GLOBAL_STOP_FILE));
  } catch {
    return false;
  }
}

/** The attempts ("jobId#attempt") the executor has started and that are still assigned. null: the file is there but can not be read (unknown). */
export function loadExecutorAttempts(dataDir: string): string[] | null {
  const file = path.join(dataDir, EXECUTOR_ATTEMPTS_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? [] : null;
  }
  try {
    const parsed = JSON.parse(text) as { attempts?: unknown };
    if (!parsed || !Array.isArray(parsed.attempts) || parsed.attempts.some((entry) => typeof entry !== "string")) return null;
    return parsed.attempts as string[];
  } catch {
    return null;
  }
}

/** Writes the started attempts. Never throws; false when they could not be written. */
export function saveExecutorAttempts(dataDir: string, attempts: string[]): boolean {
  try {
    writeAtomic(path.join(dataDir, EXECUTOR_ATTEMPTS_FILE), `${JSON.stringify({ schema: 1, attempts: [...attempts].sort() }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
