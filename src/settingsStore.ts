// =============================================================================
// HYDRA-UMC-SERVER - src/settingsStore.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The settings files on disk (settings.json plus one points file per robot), the
// crash-safe writer and the ordered write queue, moved out of server.ts unchanged.
import path from "path";
import fs from "fs";
import { safeIdSegment } from "./serverPolicy";
import { settingsWriteDuration } from "./metrics";
import { commitFiles, recoverTransactions, type TxnHooks } from "./transactionalFiles";
import { backupSettings, latestValidBackup, migrateToStore } from "./settingsBackups";

export function sweepOrphanedTmpFiles(dataDir: string, industrialLog: (message: string) => void = console.log): void {
  let removed = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".tmp")) {
        try { fs.unlinkSync(full); removed++; } catch { /* best-effort */ }
      }
    }
  };
  walk(dataDir);
  if (removed > 0) industrialLog(`[STARTUP] Removed ${removed} orphaned .tmp file(s) under ${dataDir} left over from an earlier interrupted write.`);
}

export interface SettingsStore {
  getSettingsPath: () => string;
  getPointsPath: (controllerId: unknown, robotId: unknown) => string;
  loadFullSettingsFromDisk: () => any;
  queueSettingsWrite: (payload: any) => Promise<void>;
  getSettings: () => any;
  setSettings: (payload: any) => void;
}

export interface SettingsStoreOptions {
  /** "journal" (default): all-or-nothing writes with a journal, backups and recovery. "plain": the file-by-file writes this server used before. */
  mode?: "journal" | "plain";
  /** How many copies of settings.json to keep (0 turns them off). */
  backups?: number;
  /** The least time between two copies. */
  backupIntervalMs?: number;
  /** Where the store reports what it recovers or restores (the server passes its industrial log). */
  log?: (message: string) => void;
  /** Called with the path of every new copy of settings.json (the audit record is copied next to it). */
  onBackup?: (backupPath: string) => void;
  /** For tests: runs inside a write to simulate a cut. */
  txnHooks?: TxnHooks;
}

/** Reads the store options from the environment: HYDRA_UMC_SETTINGS_STORE, HYDRA_UMC_SETTINGS_BACKUPS, HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S. */
export function settingsStoreOptionsFromEnv(env: NodeJS.ProcessEnv): SettingsStoreOptions {
  const count = Number.parseInt(env.HYDRA_UMC_SETTINGS_BACKUPS ?? "", 10);
  const seconds = Number.parseInt(env.HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S ?? "", 10);
  return {
    mode: (env.HYDRA_UMC_SETTINGS_STORE ?? "").trim().toLowerCase() === "plain" ? "plain" : "journal",
    backups: Number.isFinite(count) && count >= 0 ? Math.min(count, 200) : 10,
    backupIntervalMs: (Number.isFinite(seconds) && seconds >= 0 ? seconds : 600) * 1000,
  };
}

export function createSettingsStore(dataPath: string, options: SettingsStoreOptions = {}): SettingsStore {
  const industrialLog = options.log ?? console.log;
  const journal = (options.mode ?? "journal") === "journal";
  const backupCount = options.backups ?? 10;
  const backupIntervalMs = options.backupIntervalMs ?? 600_000;
  const txnRoot = path.join(dataPath, ".txn");
  if (journal) {
    try {
      const report = recoverTransactions(txnRoot);
      if (report.rolledForward || report.rolledBack || report.problems.length) {
        industrialLog(`[STORE] Recovery after an interrupted write: ${report.rolledForward} finished, ${report.rolledBack} discarded${report.problems.length ? `, problems: ${report.problems.join("; ")}` : ""}.`);
      }
      const copy = migrateToStore(dataPath);
      if (copy) industrialLog(`[STORE] The settings now use the transactional store; a full copy of the previous files is in ${copy}.`);
    } catch (error) {
      industrialLog(`[STORE] Could not prepare the transactional store (${(error as Error).message}); continuing with the files as they are.`);
    }
  }
  const getSettingsPath = () => {
    return path.join(dataPath, "settings.json");
  };

  // safeIdSegment now lives in ./serverPolicy (see that module's own
  // header comment) - moved unchanged so it's directly unit-testable.

  // See queueSettingsWrite's own header comment for why each robot's
  // recordedPoints array lives in its own file here rather than inline in
  // settings.json - isolates the one field that can legitimately grow to
  // several MB (a long real trajectory) or balloon because of a client-side
  // duplication bug, into its own file whose own size and modification time immediately point at
  // the culprit robot instead of hiding inside one multi-MB settings.json.
  function getPointsPath(controllerId: unknown, robotId: unknown): string {
    return path.join(dataPath, "points", safeIdSegment(controllerId), `${safeIdSegment(robotId)}.json`);
  }

  // Writes `json` to `finalPath` via the same crash-safe pattern
  // queueSettingsWrite always used for settings.json itself -
  // sibling temp file (PID + timestamp, so two overlapping writers never
  // collide on the same temp path) written first, then atomically renamed
  // over the real path, so a write interrupted partway (disk full, process
  // killed, power loss) never leaves `finalPath` itself truncated/corrupt -
  // it's either the complete new content or untouched, never in between.
  // Shared now that queueSettingsWrite writes more than one file per call.
  //
  // Real bug found and fixed here: unlike POSIX rename(2), Windows'
  // rename-over-an-existing-destination isn't guaranteed atomic and can
  // fail with EPERM/EBUSY if the destination is transiently open by
  // something else for a moment (an AV scanner, a backup/sync agent, a
  // file watcher) - and with no retry or cleanup, that left the real
  // tmpPath orphaned forever. Found 16 real orphaned
  // `data/settings.json.<pid>.<timestamp>.tmp` files on this same dev
  // machine, spanning 7 different server runs (see
  // sweepOrphanedTmpFiles(), below, for the cleanup of what already
  // accumulated). Fixed with a few short retries on ENOENT/EPERM/EBUSY
  // (the transient-lock case actually clears almost always within a few
  // ms) and a real cleanup of tmpPath if every retry still fails, so a
  // genuine failure at least doesn't leave garbage behind too.
  async function writeFileAtomic(finalPath: string, json: string): Promise<void> {
    const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.promises.rename(tmpPath, finalPath);
        return;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
    try { await fs.promises.unlink(tmpPath); } catch { /* best-effort - don't mask the real error below with a cleanup failure */ }
    throw lastError;
  }

  // Real, honest cleanup for whatever writeFileAtomic() failures already
  // left behind before the fix above existed - a *.tmp sibling of
  // data/settings.json or a data/points/**/*.json file that's still
  // here at startup was never mid-rename (that always completes or gets
  // cleaned up within milliseconds, never across a process restart), so
  // it's real garbage, safe to remove unconditionally.

  // Reassembles the full in-memory settings shape (recordedPoints inline,
  // exactly as every route/broadcast in this file already expects) from
  // the split on-disk layout: data/settings.json (everything else) plus
  // one data/points/<controllerId>/<robotId>.json per robot. Used both at
  // startup (to seed lastKnownSettings) and by GET /api/settings (which
  // always re-reads disk fresh rather than trusting the in-memory mirror -
  // see that route's own comment) - a single implementation so the two
  // can never quietly diverge on how a robot's points get reattached.
  //
  // Backward compatible with a settings.json from before this split: if a
  // robot's own points file doesn't exist yet AND that robot object
  // already carries an inline recordedPoints array (pre-split data,
  // migrated on-disk once by any subsequent write - see
  // queueSettingsWrite), that inline array is left as-is rather than
  // wiped to []. Only a robot with neither an inline array nor a points
  // file (genuinely never recorded anything) defaults to [].
  function loadFullSettingsFromDisk(): any {
    const settingsPath = getSettingsPath();
    let core: any = {};
    if (fs.existsSync(settingsPath)) {
      try {
        core = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch (error) {
        // A damaged settings.json: keep it for inspection and go back to the newest copy that parses.
        const backup = journal ? latestValidBackup(dataPath) : null;
        if (!backup) throw error;
        fs.renameSync(settingsPath, `${settingsPath}.corrupt-${Date.now()}`);
        fs.writeFileSync(settingsPath, backup.text);
        industrialLog(`[STORE] settings.json could not be read (${(error as Error).message}); restored from ${backup.path}.`);
        core = JSON.parse(backup.text);
      }
    }
    for (const c of core.controllers || []) {
      for (const r of c.robots || []) {
        const pointsPath = getPointsPath(c.id, r.id);
        try {
          if (fs.existsSync(pointsPath)) {
            r.recordedPoints = JSON.parse(fs.readFileSync(pointsPath, "utf-8"));
          } else if (!Array.isArray(r.recordedPoints)) {
            r.recordedPoints = [];
          }
        } catch {
          // Corrupt points file for this ONE robot - don't let it take
          // down settings for every other robot, just start this robot
          // with no recorded points (same fallback the whole file already
          // gets one level up if settings.json itself is unreadable).
          r.recordedPoints = [];
        }
      }
    }
    return core;
  }


  // In-memory mirror of the last settings write, kept for /api/hydra-info's
  // own cheap robot/controller counts (see that route below) and as the
  // payload broadcastSettings() sends to newly-(re)connecting WebSocket
  // clients. Seeded from disk at startup so a remote client scanning right
  // after a server restart still sees real counts, not zeros.
  let lastKnownSettings: any = {};
  try {
    lastKnownSettings = loadFullSettingsFromDisk();
  } catch {
    // corrupt/unreadable settings.json - start from an empty object rather than crash the server
  }

  const getSettings = () => lastKnownSettings;
  const setSettings = (payload: any) => { lastKnownSettings = payload; };

  // Serializes every write to settings.json (POST /api/settings, the
  // atomic POST /api/robot/:id/command, and the WS "settings" message all
  // target this same file) behind one promise chain, so two writes that
  // arrive close together always land on disk in the order they were
  // REQUESTED instead of whichever one's own fs.promises.writeFile()
  // happens to finish first - without this, two concurrent writers could
  // interleave at the OS level, or (more commonly) an earlier request's
  // write could simply finish AFTER a later one's and silently overwrite
  // it with stale data ("Last Write Wins" by completion time, not by
  // request time - the exact data-loss window this queue exists to
  // close). JSON.stringify happens HERE, synchronously, at enqueue time -
  // not lazily inside the queued callback - because /api/robot/:id/command
  // passes the shared, in-place-mutated `lastKnownSettings` object; if the
  // snapshot were taken lazily it could pick up a LATER request's
  // mutations by the time this write actually runs. This only fixes the
  // low-level disk I/O race between concurrent writers on THIS server; it
  // intentionally does not attempt to merge or diff two independent edits
  // made from stale reads (see docs/REMOTE_API.md section 2c's own note
  // on that separate, higher-level, protocol-level race - closing that
  // one would need a real merge/patch contract coordinated with every
  // client, not a server-only change).
  let settingsWriteQueue: Promise<void> = Promise.resolve();
  // Splits `payload` (the full in-memory settings shape, recordedPoints
  // inline - same object every caller already built before this split
  // existed) into settings.json (everything else) plus one
  // points/<controllerId>/<robotId>.json per robot (see getPointsPath's
  // own header comment for why: isolating the one field that can
  // legitimately grow to several MB, or balloon from a client-side bug,
  // into its own file whose size/mtime immediately points at the culprit
  // robot). Every snapshot
  // (JSON.stringify) happens HERE, synchronously, at enqueue time - not
  // lazily inside the queued callback - for the exact same reason this
  // function always took that care for its one JSON.stringify:
  // /api/robot/:id/command passes the shared, in-place-mutated
  // `lastKnownSettings` object; if any of these snapshots were taken
  // lazily they could pick up a LATER request's mutations by the time
  // this write actually runs.
  function queueSettingsWrite(payload: any): Promise<void> {
    const controllers = Array.isArray(payload?.controllers) ? payload.controllers : [];
    const coreJson = JSON.stringify(
      {
        ...payload,
        controllers: controllers.map((c: any) => ({
          ...c,
          robots: Array.isArray(c.robots)
            ? c.robots.map((r: any) => {
                const { recordedPoints, ...rest } = r;
                return rest;
              })
            : c.robots,
        })),
      },
      null,
      2
    );
    const pointsWrites: { path: string; json: string }[] = [];
    for (const c of controllers) {
      for (const r of Array.isArray(c.robots) ? c.robots : []) {
        if (Array.isArray(r.recordedPoints)) {
          pointsWrites.push({ path: getPointsPath(c.id, r.id), json: JSON.stringify(r.recordedPoints) });
        }
      }
    }
    const result = settingsWriteQueue.then(async () => {
      // Wraps every file this call writes (not the snapshotting above, and
      // not the queue-wait time before this callback runs) - src/metrics.ts's
      // own hydra_settings_write_duration_seconds histogram, exposed on
      // GET /metrics. stopTimer() always runs (finally), so a failed write
      // still gets observed rather than silently skewing the histogram
      // toward only-successful, artificially-fast samples.
      const stopTimer = settingsWriteDuration.startTimer();
      try {
        if (journal) {
          try {
            const copy = backupSettings(dataPath, getSettingsPath(), backupCount, backupIntervalMs);
            if (copy) options.onBackup?.(copy);
          } catch (error) {
            industrialLog(`[STORE] Could not copy settings.json before the write: ${(error as Error).message}`);
          }
          await commitFiles(
            txnRoot,
            [{ path: getSettingsPath(), content: coreJson }, ...pointsWrites.map((w) => ({ path: w.path, content: w.json }))],
            options.txnHooks,
          );
        } else {
          await writeFileAtomic(getSettingsPath(), coreJson);
          for (const w of pointsWrites) {
            await writeFileAtomic(w.path, w.json);
          }
        }
      } finally {
        stopTimer();
      }
    });
    // Keep the queue moving even if this particular write fails - an
    // unhandled rejection here would otherwise permanently wedge every
    // write queued after it. The caller of THIS write still observes its
    // own failure via the `result` promise returned below.
    settingsWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  return { getSettingsPath, getPointsPath, loadFullSettingsFromDisk, queueSettingsWrite, getSettings, setSettings };
}
