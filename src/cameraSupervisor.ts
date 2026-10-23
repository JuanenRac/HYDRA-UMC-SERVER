// =============================================================================
// HYDRA-UMC-SERVER - src/cameraSupervisor.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The per-camera stream process supervisor, moved out of server.ts unchanged.
import { redactLines } from "./redaction";
import path from "path";
import fs from "fs";
import { spawn, type ChildProcess } from "child_process";
import {
  computeDeviceArg, cameraFingerprint, cameraStreamPort, redactDeviceCredentials, cameraSpawnSpec,
  isValidCameraId,
} from "./serverPolicy";
import { visionStreamerExecutablePath, probeTcp } from "./ecosystemStatus";
import { industrialLog } from "./runtime";

export function createCameraSupervisor() {
  // --- Real per-camera process supervisor -------------------------------
  //
  // GET /api/camera/:id/stream (below) is a pure proxy to a local
  // hydra-umc-vision-streamer "stream serve" instance on
  // 127.0.0.1:8100+(id-1) - it never launches one itself. Before this,
  // NOTHING did: STUDIO/SUITE's own camera config UI (sourceType/
  // ipHost/rtspPort/rtspPath/ipUsername/ipPassword, already
  // field-complete on both) only ever persisted JSON here - saving a
  // camera's real IP config had zero effect on whether any video
  // actually showed up. This reconciles the real child process for
  // every camera against its real current config, every time settings
  // are saved (via applySettingsUpdate(), below) and once at startup.
  interface CameraProcessState {
    proc: ChildProcess | null;
    port: number;
    fingerprint: string;
    status: "starting" | "running" | "error" | "stopped";
    lastError: string | null;
    recentOutput: string[];
    // How many times in a row the self-heal below has had to kill and
    // respawn THIS exact fingerprint without ever seeing it reach
    // "running" - drives the escalating backoff between attempts (see
    // the health check below) and resets to 0 the moment it actually
    // comes up. Not persisted across a real fingerprint change/stop -
    // a genuinely different config starts this back at 0.
    restartAttempts: number;
  }
  const cameraProcesses = new Map<string, CameraProcessState>();

  // cameraFingerprint now lives in ./serverPolicy (see that module's own
  // header comment) - moved unchanged so it's directly unit-testable.

  function stopCameraProcess(key: string): void {
    const state = cameraProcesses.get(key);
    if (!state?.proc) return;
    const proc = state.proc;
    industrialLog(`[CAMERA] stopping ${key} pid=${proc.pid}`);
    state.proc = null;
    proc.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }, 2000);
    killTimer.unref();
    proc.once("exit", () => clearTimeout(killTimer));
    writeCameraPidFile();
  }

  // Real pidfile-based orphan reaping for camera child processes - unlike
  // POSIX, killing this Node process by anything other than a clean
  // SIGINT/SIGTERM that actually reaches gracefulShutdown() (window
  // closed via taskkill /F, a debugger stopping the process, a crash)
  // does NOT take its spawned children down with it on Windows - there's
  // no process-group-wide kill happening automatically. An orphaned
  // `stream serve` child just keeps running forever, silently holding
  // its camera device and TCP port. Caught live on this same dev machine:
  // 2 real orphaned vision-streamer processes still holding ports
  // 8100/8101 from an earlier server incarnation, fighting the current
  // server's own freshly-reconciled replacements over the same real
  // webcam and RTSP stream. Fixed with a small pidfile
  // (data/camera-process-pids.json), kept current by writeCameraPidFile()
  // below every time cameraProcesses actually changes, and read back
  // once here, before this incarnation reconciles (and so spawns) any
  // camera process of its own - a real liveness probe (process.kill(pid,
  // 0), never a guess) decides what's actually still running.
  function cameraPidFilePath(): string {
    return path.join(process.cwd(), "data", "camera-process-pids.json");
  }

  function writeCameraPidFile(): void {
    const pids = Array.from(cameraProcesses.values())
      .map((s) => s.proc?.pid)
      .filter((pid): pid is number => typeof pid === "number");
    try {
      fs.mkdirSync(path.dirname(cameraPidFilePath()), { recursive: true });
      fs.writeFileSync(cameraPidFilePath(), JSON.stringify(pids), "utf-8");
    } catch {
      // best-effort - losing this file only means a future orphan from
      // THIS incarnation won't be reaped next boot, not a functional
      // break today.
    }
  }

  function reapOrphanedCameraProcesses(): void {
    let pids: unknown;
    try {
      pids = JSON.parse(fs.readFileSync(cameraPidFilePath(), "utf-8"));
    } catch {
      return; // no pidfile yet (first run ever, or already empty) - nothing to reap
    }
    if (!Array.isArray(pids)) return;
    let killed = 0;
    for (const pid of pids) {
      if (typeof pid !== "number") continue;
      try {
        process.kill(pid, 0); // real liveness probe - throws (ESRCH) if this PID is already gone, the common case
        process.kill(pid, "SIGTERM");
        killed++;
      } catch {
        // already gone - nothing to reap for this one
      }
    }
    if (killed > 0) {
      industrialLog(`[STARTUP] Reaped ${killed} orphaned camera process(es) left running by an earlier server instance (see reapOrphanedCameraProcesses's own comment).`);
    }
  }

  // Real self-heal, not just a status label: a process that's still
  // technically alive but never answers (a hung RTSP reconnect - the
  // exact real bug reported live: camera 4's own stream would freeze
  // mid-switch and never come back) or one that genuinely exits on its
  // own used to just sit in cameraProcesses forever marked "error" -
  // reconcileCameraProcesses()'s own short-circuit only skips a camera
  // when it already has a live `proc`, so once one went stuck, NOTHING
  // touched it again until an unrelated settings save happened to come
  // through. This schedules a real respawn of the exact same config
  // instead, with an escalating backoff (5s/10s/20s, capped at 30s) so a
  // genuinely broken camera (wrong credentials, unreachable host)
  // doesn't hammer the OS or the real camera hardware with a spawn every
  // few seconds forever.
  function scheduleCameraRespawn(key: string, port: number, deviceArg: string, fingerprint: string, priorAttempts: number): void {
    const delayMs = Math.min(5000 * Math.pow(2, priorAttempts), 30000);
    const retryTimer = setTimeout(() => {
      const current = cameraProcesses.get(key);
      // Only respawn if this exact stuck config is still the one
      // tracked - a real reconcile (config changed, camera disabled or
      // deleted) may already have superseded it, and that always wins
      // over this fallback.
      if (current && current.proc === null && current.fingerprint === fingerprint && current.status === "error") {
        startCameraProcess(key, port, deviceArg, fingerprint, priorAttempts + 1);
      }
    }, delayMs);
    retryTimer.unref();
  }

  function startCameraProcess(key: string, port: number, deviceArg: string, fingerprint: string, restartAttempts: number = 0): void {
    const exePath = visionStreamerExecutablePath();
    if (!fs.existsSync(exePath)) {
      industrialLog(`[CAMERA] ${key}: HYDRA-UMC-VISION-STREAMER not found at ${exePath} - reporting error status, not spawning`);
      cameraProcesses.set(key, {
        proc: null, port, fingerprint, status: "error",
        lastError: `HYDRA-UMC-VISION-STREAMER not found at ${exePath} - is it checked out as a sibling repo with its own .venv installed (pip install -e .)?`,
        recentOutput: [], restartAttempts,
      });
      return;
    }
    const spec = cameraSpawnSpec(deviceArg, port);
    const proc = spawn(exePath, spec.args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...spec.extraEnv } });
    industrialLog(`[CAMERA] starting ${key} on port ${port} (device=${redactDeviceCredentials(deviceArg)}) pid=${proc.pid}${restartAttempts > 0 ? ` (self-heal retry #${restartAttempts})` : ""}`);
    const state: CameraProcessState = { proc, port, fingerprint, status: "starting", lastError: null, recentOutput: [], restartAttempts };
    cameraProcesses.set(key, state);
    writeCameraPidFile();
    const captureOutput = (data: Buffer) => {
      const lines = redactLines(data.toString("utf-8").split(/\r?\n/)).filter(Boolean);
      state.recentOutput.push(...lines);
      if (state.recentOutput.length > 20) state.recentOutput.splice(0, state.recentOutput.length - 20);
    };
    proc.stdout?.on("data", captureOutput);
    proc.stderr?.on("data", captureOutput);
    // Real check, not a guess: mjpeg_server.py's own stream serve binds
    // and starts serving HTTP as soon as it opens the real camera/RTSP
    // device, before the child process would otherwise ever exit on its
    // own - a short real TCP probe against its own port is a more
    // honest "is this actually up" signal than "the process object
    // still exists".
    // Real retries, not one shot: a cold RTSP connect (real network round
    // trip to the camera, real GStreamer/OpenCV backend init) genuinely
    // took longer than a single 1.5s check allowed for on the real CM5 -
    // caught live testing this against real hardware on the real CM5: a
    // cold RTSP connect over a real network plus real ARM CPU startup
    // overhead can genuinely take well past what any single fixed
    // window covers (10s still wasn't always enough for some of this
    // ecosystem's own real cameras) - and a one-shot check that never
    // runs again also can't ever notice a camera that WAS running and
    // then genuinely dropped. So this is a persistent health check, not
    // a bounded startup probe: ticks every HEALTH_CHECK_INTERVAL_MS for
    // as long as this exact process is the one tracked for `key`,
    // flipping to "running" the moment it answers and to "error" only
    // after HEALTH_CHECK_FAILURE_THRESHOLD consecutive misses (avoids
    // flapping the badge between "starting"/"error" during a normal,
    // if slow, cold start - "starting" is the honest state to show
    // until that many misses actually happen).
    const HEALTH_CHECK_INTERVAL_MS = 2000;
    const HEALTH_CHECK_FAILURE_THRESHOLD = 10; // ~20s of misses before calling it an error
    let consecutiveFailures = 0;
    const healthTimer = setInterval(async () => {
      if (cameraProcesses.get(key)?.proc !== proc) {
        clearInterval(healthTimer); // superseded by a respawn or a stop already
        return;
      }
      const up = await probeTcp(port);
      if (cameraProcesses.get(key)?.proc !== proc) {
        clearInterval(healthTimer);
        return;
      }
      if (up) {
        consecutiveFailures = 0;
        state.status = "running";
        state.lastError = null;
        state.restartAttempts = 0; // it recovered - the next real failure starts backoff over from 5s
        return;
      }
      consecutiveFailures++;
      if (consecutiveFailures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
        clearInterval(healthTimer);
        const nextAttempt = state.restartAttempts + 1;
        const retryInSec = Math.min(5 * Math.pow(2, state.restartAttempts), 30);
        state.status = "error";
        state.lastError =
          (state.recentOutput.slice(-3).join(" | ") ||
            `stream serve has not answered on its own port for ${(HEALTH_CHECK_FAILURE_THRESHOLD * HEALTH_CHECK_INTERVAL_MS) / 1000}s`) +
          ` - killing and retrying in ${retryInSec}s (attempt #${nextAttempt})`;
        industrialLog(`[CAMERA] ${key}: unresponsive, killing pid=${proc.pid} and scheduling a real respawn in ${retryInSec}s`);
        proc.kill("SIGTERM");
        const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, 2000);
        killTimer.unref();
        state.proc = null;
        writeCameraPidFile();
        scheduleCameraRespawn(key, port, deviceArg, fingerprint, state.restartAttempts);
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    healthTimer.unref();
    proc.once("exit", (code, signal) => {
      if (cameraProcesses.get(key)?.proc !== proc) return; // already replaced by a respawn
      clearInterval(healthTimer);
      state.proc = null;
      state.status = "error";
      const retryInSec = Math.min(5 * Math.pow(2, state.restartAttempts), 30);
      state.lastError = `stream serve exited (code=${code}, signal=${signal}) - ${state.recentOutput.slice(-3).join(" | ") || "no output captured"} - retrying in ${retryInSec}s`;
      writeCameraPidFile();
      scheduleCameraRespawn(key, port, deviceArg, fingerprint, state.restartAttempts);
    });
    proc.once("error", (err) => {
      clearInterval(healthTimer);
      state.proc = null;
      state.status = "error";
      const retryInSec = Math.min(5 * Math.pow(2, state.restartAttempts), 30);
      state.lastError = `failed to launch stream serve: ${err.message} - retrying in ${retryInSec}s`;
      writeCameraPidFile();
      scheduleCameraRespawn(key, port, deviceArg, fingerprint, state.restartAttempts);
    });
  }

  function reconcileCameraProcesses(payload: any): void {
    const seenKeys = new Set<string>();
    for (const controller of payload?.controllers ?? []) {
      for (const camera of controller?.cameras ?? []) {
        if (!isValidCameraId(camera?.id)) continue;
        const key = `${controller.id}:${camera.id}`;
        seenKeys.add(key);
        const fingerprint = cameraFingerprint(camera);
        const existing = cameraProcesses.get(key);
        const port = cameraStreamPort(camera.id);

        // The real on/off switch (Vision Center's own "toggle
        // connection" button) - caught live from real user feedback: a
        // camera toggled off kept its real stream serve process alive,
        // silently burning CPU/memory for a feed nothing was even
        // asking to see. `connected` is deliberately NOT part of
        // cameraFingerprint() (see that function's own comment - it
        // only tracks fields a respawn would actually need to react
        // to), so this is checked here, before the fingerprint
        // short-circuit below, not folded into it - toggling connected
        // off/on needs a real stop/start regardless of whether the
        // underlying connection config itself changed at the same time.
        if (camera.connected !== true) {
          if (existing?.proc) stopCameraProcess(key);
          cameraProcesses.set(key, {
            proc: null, port, fingerprint, status: "stopped", lastError: null,
            recentOutput: existing?.recentOutput ?? [], restartAttempts: 0,
          });
          continue;
        }

        if (existing && existing.fingerprint === fingerprint && existing.proc) {
          continue; // unchanged config, already has a real process running (or starting) - don't restart a healthy stream
        }
        const deviceArg = computeDeviceArg(camera);
        stopCameraProcess(key);
        if (deviceArg === null) {
          cameraProcesses.set(key, { proc: null, port, fingerprint, status: "error", lastError: "camera config is incomplete or in an unrecognized format", recentOutput: [], restartAttempts: 0 });
          continue;
        }
        startCameraProcess(key, port, deviceArg, fingerprint);
      }
    }
    // A camera that existed before but is gone from this payload
    // (deleted, or its controller was removed) - stop its process too,
    // don't leave it running with no config backing it anymore.
    for (const key of cameraProcesses.keys()) {
      if (!seenKeys.has(key)) {
        stopCameraProcess(key);
        cameraProcesses.delete(key);
      }
    }
    writeCameraPidFile();
  }

  return { cameraProcesses, stopCameraProcess, reconcileCameraProcesses, reapOrphanedCameraProcesses };
}
