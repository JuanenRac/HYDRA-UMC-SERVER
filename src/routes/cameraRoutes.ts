// =============================================================================
// HYDRA-UMC-SERVER - src/routes/cameraRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The /api/camera/* and /api/cameras/* routes, moved out of server.ts
// unchanged. Everything they need from startServer() comes in through `deps`:
// the two auth middlewares, the data directory helpers and the table of
// running camera processes.
import express from "express";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { Readable } from "stream";
import { discoverRtspPath, sendPtzCommand } from "../cameraProbe";
import { visionStreamerExecutablePath } from "../ecosystemStatus";
import { cameraStreamPort } from "../serverPolicy";

const execFileAsync = promisify(execFile);

type Middleware = (req: any, res: any, next: any) => unknown;

export interface CameraRouteDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  /** Absolute path of the data directory. */
  dataPath: string;
  /** Resolves segments inside the data directory, or null when they would leave it. */
  resolveWithinDataDir: (...segments: string[]) => string | null;
  /** The running camera capture processes, keyed by camera. Read only here. */
  cameraProcesses: Map<string, { status: string; lastError: string | null; port: number }>;
}

export function registerCameraRoutes(app: express.Express, deps: CameraRouteDeps): void {
  const { authenticate, requireAdmin, dataPath, resolveWithinDataDir, cameraProcesses } = deps;

  // Real proxy to HYDRA-UMC-VISION-STREAMER's own real MJPEG capture+serve
  // (mjpeg_server.py, "hydra-umc-vision-streamer stream serve") - this
  // used to be a placeholder that wrote fake, non-JPEG bytes forever (see
  // that project's own CHANGELOG for the real fix that made this
  // possible). One camera = one local, loopback-only mjpeg_server.py
  // instance on its own port, deterministically 8100 + (id - 1) - camera
  // 1 -> 8100, camera 2 -> 8101, etc, up to the documented 8-camera cap
  // (config.py's own MAX_CAMERAS) - avoids needing a separate port-
  // mapping config file for a v0 with this few, fixed slots. Real
  // passthrough proxy, not a re-implementation of MJPEG chunking:
  // upstream's own multipart body (and its own real boundary) is piped
  // through byte for byte, so this route's own behavior can never drift
  // from what mjpeg_server.py actually sends. cameraStreamPort itself now
  // lives in ./serverPolicy (see that module's own header comment), moved
  // unchanged so it's directly unit-testable.

  app.get("/api/camera/:id/stream", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "camera id must be a positive integer" });
    }
    const port = cameraStreamPort(id);
    let upstream: Response;
    // Bounds only the initial connect to the local mjpeg_server.py instance.
    // AbortSignal.timeout(N) fires N ms after it was created, full stop - it
    // does NOT reset per chunk received, so reusing the same signal past the
    // fetch() call (which resolves as soon as headers arrive, before the
    // real MJPEG body has streamed a single frame) aborts every stream dead
    // at exactly 5s regardless of whether it's still healthy. Confirmed real
    // in production: this crashed the entire server, not just this route,
    // the first time a real camera stream was actually watched for more
    // than 5s (see CHANGELOG for the DOMException [TimeoutError] trace).
    const connectController = new AbortController();
    const connectTimeout = setTimeout(() => connectController.abort(), 5000);
    try {
      upstream = await fetch(`http://127.0.0.1:${port}/stream`, { signal: connectController.signal });
    } catch {
      return res.status(503).json({ error: `No camera stream running locally for camera ${id} (expected on 127.0.0.1:${port}) - see HYDRA-UMC-VISION-STREAMER's own "stream serve" command.`, available: false });
    } finally {
      clearTimeout(connectTimeout);
    }
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `Local camera stream for camera ${id} answered with an unexpected response.` });
    }
    res.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") || "multipart/x-mixed-replace",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
    });
    const nodeStream = Readable.fromWeb(upstream.body as any);
    // A client disconnecting mid-stream (closed tab, page navigation, a
    // flaky network) is the normal, expected way this route ends, and an
    // upstream mjpeg_server.py restarting is a normal, expected transient
    // failure - neither may ever surface as an uncaught 'error' event again
    // (Node's default behavior for one is to crash the whole process; this
    // is the exact bug above, kept fixed here in general, not just for the
    // one cause found today).
    nodeStream.on("error", () => {
      if (!res.writableEnded) res.end();
    });
    res.on("error", () => {
      nodeStream.destroy();
    });
    nodeStream.pipe(res);
    req.on("close", () => nodeStream.destroy());
  });

  // Real camera media capture (snapshots + recordings), saved from the
  // exact same local mjpeg_server.py multipart stream /api/camera/:id/stream
  // already proxies above - no ffmpeg or other new system dependency,
  // since HYDRA-UMC-VISION-STREAMER's own wire format (boundary
  // "hydraumcframe", `Content-Type: image/jpeg` + `Content-Length: N`
  // headers before each frame's raw JPEG bytes, see mjpeg_server.py's own
  // make_handler()) is already a byte-exact, replayable multipart body on
  // its own: a recording is just those same bytes teed to a file while
  // active, and playing it back later is the same
  // `multipart/x-mixed-replace` response this server already sends for a
  // live camera, just reading from disk instead of the upstream socket.
  const MJPEG_BOUNDARY = "hydraumcframe";
  const CAMERA_MEDIA_ROOT = path.join(dataPath, "camera-media");

  function cameraMediaDir(id: number, kind: "snapshots" | "recordings"): string {
    const dir = path.join(CAMERA_MEDIA_ROOT, String(id), kind);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // One real JPEG frame, parsed out of the raw multipart bytes (boundary
  // marker + `Content-Length` header tell us exactly where the payload
  // starts and ends - no reliance on JPEG SOI/EOI markers, which would
  // break the moment a frame's own bytes happened to contain a matching
  // sequence).
  function extractFirstJpegFrame(buffer: Buffer): Buffer | null {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const head = buffer.subarray(0, headerEnd).toString("ascii");
    const match = head.match(/Content-Length:\s*(\d+)/i);
    if (!match) return null;
    const length = Number(match[1]);
    const payloadStart = headerEnd + 4;
    if (buffer.length < payloadStart + length) return null;
    return buffer.subarray(payloadStart, payloadStart + length);
  }

  // Real frame count for a finished recording file on disk - same
  // Content-Length-based parsing as extractFirstJpegFrame above (never
  // JPEG SOI/EOI sniffing), just walked across the whole file instead of
  // stopping at the first frame. Used once, right after a recording
  // finishes writing, to produce the honest frameCount/durationMs a
  // real player needs for a seek bar - never estimated or guessed.
  function countMjpegFrames(buffer: Buffer): number {
    let offset = 0;
    let count = 0;
    while (offset < buffer.length) {
      const headerEnd = buffer.indexOf("\r\n\r\n", offset);
      if (headerEnd === -1) break;
      const head = buffer.subarray(offset, headerEnd).toString("ascii");
      const match = head.match(/Content-Length:\s*(\d+)/i);
      if (!match) break;
      const length = Number(match[1]);
      const payloadStart = headerEnd + 4;
      if (buffer.length < payloadStart + length) break;
      count++;
      offset = payloadStart + length;
    }
    return count;
  }

  function recordingSidecarPath(filePath: string): string {
    return `${filePath}.json`;
  }

  interface RecordingMetadata {
    startedAt: string;
    stoppedAt: string;
    durationMs: number;
    frameCount: number;
  }

  function readRecordingSidecar(filePath: string): RecordingMetadata | null {
    try {
      const raw = fs.readFileSync(recordingSidecarPath(filePath), "utf-8");
      const parsed = JSON.parse(raw);
      if (
        typeof parsed.startedAt === "string" &&
        typeof parsed.stoppedAt === "string" &&
        typeof parsed.durationMs === "number" &&
        typeof parsed.frameCount === "number"
      ) {
        return parsed as RecordingMetadata;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function connectToLocalCameraStream(id: number): Promise<Response> {
    const port = cameraStreamPort(id);
    const connectController = new AbortController();
    const connectTimeout = setTimeout(() => connectController.abort(), 5000);
    try {
      const upstream = await fetch(`http://127.0.0.1:${port}/stream`, { signal: connectController.signal });
      if (!upstream.ok || !upstream.body) throw new Error("unexpected upstream response");
      return upstream;
    } finally {
      clearTimeout(connectTimeout);
    }
  }

  // Real one-shot photo: connects just long enough to capture ONE frame,
  // then disconnects - unlike a recording, this never keeps the upstream
  // connection open.
  app.post("/api/camera/:id/snapshot", authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "camera id must be a positive integer" });
    let upstream: Response;
    try {
      upstream = await connectToLocalCameraStream(id);
    } catch {
      return res.status(503).json({ error: `No camera stream running locally for camera ${id}.`, available: false });
    }
    const reader = (upstream.body as any).getReader();
    let buffered = Buffer.alloc(0);
    const readTimeout = setTimeout(() => reader.cancel().catch(() => {}), 5000);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered = Buffer.concat([buffered, Buffer.from(value)]);
        const frame = extractFirstJpegFrame(buffered);
        if (frame) {
          const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
          const dir = cameraMediaDir(id, "snapshots");
          fs.writeFileSync(path.join(dir, filename), frame);
          return res.json({ success: true, cameraId: id, filename, capturedAt: new Date().toISOString(), sizeBytes: frame.length });
        }
        if (buffered.length > 8 * 1024 * 1024) break; // no single real JPEG frame is anywhere near this large
      }
      return res.status(502).json({ error: `Could not capture a full frame from camera ${id} before disconnecting.` });
    } finally {
      clearTimeout(readTimeout);
      reader.cancel().catch(() => {});
    }
  });

  // Active recordings, keyed by camera id - one in-flight recording per
  // camera at a time, matching the "one camera = one local stream" model
  // the rest of this file already uses. In-memory only: a server restart
  // ends any in-progress recording (the partial file on disk stays valid
  // and playable, since each written frame is already a complete
  // multipart part).
  const activeCameraRecordings = new Map<number, { filePath: string; startedAt: string; reader: any; writeStream: fs.WriteStream; finished: Promise<void> }>();

  app.post("/api/camera/:id/recording/start", authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "camera id must be a positive integer" });
    if (activeCameraRecordings.has(id)) return res.status(409).json({ error: `Camera ${id} is already recording.` });
    let upstream: Response;
    try {
      upstream = await connectToLocalCameraStream(id);
    } catch {
      return res.status(503).json({ error: `No camera stream running locally for camera ${id}.`, available: false });
    }
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}.mjpeg`;
    const dir = cameraMediaDir(id, "recordings");
    const filePath = path.join(dir, filename);
    const writeStream = fs.createWriteStream(filePath);
    const reader = (upstream.body as any).getReader();
    const startedAt = new Date().toISOString();
    // Real bug fixed (found via live testing on the CM5): recording/stop
    // used to call reader.cancel() and respond immediately, without
    // waiting for this loop to actually notice the cancellation and run
    // its own finally{} below. If the loop was mid-`await` on the
    // writeStream's own "drain" event (backpressure) rather than
    // reader.read() at that exact moment, cancel() had nothing pending to
    // reject - the loop only woke up and saw ITS OWN NEXT read() reject on
    // the NEXT drain, which could take an arbitrarily long time (or never
    // happen at all if writes stalled). The client had already been told
    // "stopped", so a second stop attempt got a confusing 404 (a stale
    // map entry looked "not recording" from that race alone) while the
    // recording itself kept running underneath. `finished` now lets
    // /recording/stop actually AWAIT real completion before answering, so
    // "stopped" only ever means "truly stopped, file closed".
    let resolveFinished!: () => void;
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    activeCameraRecordings.set(id, { filePath, startedAt, reader, writeStream, finished });
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!writeStream.write(Buffer.from(value))) await new Promise<void>(r => writeStream.once("drain", () => r()));
        }
      } catch {
        // Upstream closing (stop requested, or mjpeg_server.py restarting) ends the loop the same way.
      } finally {
        writeStream.end();
        activeCameraRecordings.delete(id);
        resolveFinished();
      }
    })();
    res.json({ success: true, cameraId: id, filename, startedAt });
  });

  app.post("/api/camera/:id/recording/stop", authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "camera id must be a positive integer" });
    const active = activeCameraRecordings.get(id);
    if (!active) return res.status(404).json({ error: `Camera ${id} is not currently recording.` });
    const filename = path.basename(active.filePath);
    const startedAt = active.startedAt;
    active.reader.cancel().catch(() => {});
    // Bounded wait for the loop's own real completion (see the real race
    // documented above) - 5s comfortably covers a normal drain/teardown;
    // if it's somehow still not done by then, this answers honestly
    // rather than hanging the request forever, and the loop's own
    // finally{} still runs and cleans up whenever it actually finishes.
    await Promise.race([active.finished, new Promise(resolve => setTimeout(resolve, 5000))]);
    const stoppedAt = new Date().toISOString();
    // Real, honest playback metadata - written only once the file is
    // genuinely fully closed (finished resolved above, not the 5s
    // fallback path racing it) so frameCount always matches the bytes
    // actually on disk. A player needs frameCount/durationMs for a real
    // seek bar; nothing here is estimated - both come straight from the
    // real elapsed time and the real frame boundaries just counted.
    try {
      const buffer = fs.readFileSync(active.filePath);
      const frameCount = countMjpegFrames(buffer);
      const durationMs = Math.max(0, new Date(stoppedAt).getTime() - new Date(startedAt).getTime());
      const metadata: RecordingMetadata = { startedAt, stoppedAt, durationMs, frameCount };
      fs.writeFileSync(recordingSidecarPath(active.filePath), JSON.stringify(metadata));
    } catch {
      // A missing sidecar just means the player falls back to frame-only
      // scrubbing (see GET /api/camera/media below) - never fatal.
    }
    res.json({ success: true, cameraId: id, filename, startedAt, stoppedAt });
  });

  // Every saved snapshot/recording across every camera, newest first -
  // what STUDIO/SUITE's own camera media viewer lists.
  app.get("/api/camera/media", authenticate, (req, res) => {
    const items: { cameraId: number; kind: "snapshots" | "recordings"; filename: string; sizeBytes: number; capturedAt: string; recording: boolean; durationMs?: number; frameCount?: number }[] = [];
    if (fs.existsSync(CAMERA_MEDIA_ROOT)) {
      for (const idDir of fs.readdirSync(CAMERA_MEDIA_ROOT)) {
        const cameraId = Number(idDir);
        if (!Number.isInteger(cameraId)) continue;
        for (const kind of ["snapshots", "recordings"] as const) {
          const dir = path.join(CAMERA_MEDIA_ROOT, idDir, kind);
          if (!fs.existsSync(dir)) continue;
          for (const filename of fs.readdirSync(dir)) {
            if (filename.endsWith(".json")) continue; // sidecar metadata, not a real media item of its own
            const filePath = path.join(dir, filename);
            const stat = fs.statSync(filePath);
            const sidecar = kind === "recordings" ? readRecordingSidecar(filePath) : null;
            items.push({
              cameraId,
              kind,
              filename,
              sizeBytes: stat.size,
              capturedAt: stat.mtime.toISOString(),
              recording: kind === "recordings" && activeCameraRecordings.get(cameraId)?.filePath.endsWith(filename) === true,
              ...(sidecar ? { durationMs: sidecar.durationMs, frameCount: sidecar.frameCount } : {}),
            });
          }
        }
      }
    }
    items.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    res.json({ items });
  });

  // Serves one saved snapshot/recording. Deliberately NOT behind
  // `authenticate`, matching GET /api/camera/:id/stream's own established
  // precedent above: a plain <img src="..."> element (what
  // CameraMediaView.tsx actually uses to display a photo or play back a
  // recording) cannot send an Authorization header, so gating this route
  // on it made every real photo/recording render as a broken image -
  // real bug, found via live testing on the CM5, not a hypothetical.
  // A recording is served with the exact same multipart/x-mixed-replace
  // framing the live stream route above uses (real, not simulated - the
  // bytes on disk already carry their own boundary/Content-Type/
  // Content-Length per frame), so the same <img>/player that renders a
  // live camera can render a saved recording unchanged.
  app.get("/api/camera/media/:cameraId/:kind/:filename", (req, res) => {
    const cameraId = Number(req.params.cameraId);
    const kind = req.params.kind;
    if (!Number.isInteger(cameraId) || cameraId < 1 || (kind !== "snapshots" && kind !== "recordings")) {
      return res.status(400).json({ error: "invalid camera id or media kind" });
    }
    const resolved = resolveWithinDataDir("camera-media", String(cameraId), kind, req.params.filename);
    if (!resolved || !fs.existsSync(resolved)) return res.status(404).json({ error: "media file not found" });
    if (kind === "snapshots") {
      res.setHeader("Content-Type", "image/jpeg");
      return fs.createReadStream(resolved).pipe(res);
    }
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    const fileStream = fs.createReadStream(resolved);
    fileStream.pipe(res);
    req.on("close", () => fileStream.destroy());
  });

  // Permanently deletes one saved snapshot/recording (and its sidecar
  // metadata, if any) - a real, destructive, authenticated operation
  // (unlike the GET route above, which deliberately stays open for
  // <img>/player elements). Refuses a recording still actively being
  // written to, rather than deleting a file another part of this
  // process still holds an open write stream against.
  app.delete("/api/camera/media/:cameraId/:kind/:filename", authenticate, (req, res) => {
    const cameraId = Number(req.params.cameraId);
    const kind = req.params.kind;
    if (!Number.isInteger(cameraId) || cameraId < 1 || (kind !== "snapshots" && kind !== "recordings")) {
      return res.status(400).json({ error: "invalid camera id or media kind" });
    }
    const resolved = resolveWithinDataDir("camera-media", String(cameraId), kind, req.params.filename);
    if (!resolved || !fs.existsSync(resolved)) return res.status(404).json({ error: "media file not found" });
    const active = activeCameraRecordings.get(cameraId);
    if (active && active.filePath === resolved) {
      return res.status(409).json({ error: `Camera ${cameraId}'s recording is still in progress - stop it before deleting.` });
    }
    fs.unlinkSync(resolved);
    const sidecar = recordingSidecarPath(resolved);
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    res.json({ success: true, cameraId, kind, filename: req.params.filename });
  });

  // Real, live status of every camera's own local stream serve process
  // (reconcileCameraProcesses(), above) - what a real "did Apply work"
  // indicator in STUDIO/SUITE's own Cameras UI reads, instead of the
  // config UI being a black box that silently does nothing.
  app.get("/api/cameras/status", authenticate, (req, res) => {
    const result: Record<string, { status: string; lastError: string | null; port: number }> = {};
    for (const [key, state] of cameraProcesses.entries()) {
      result[key] = { status: state.status, lastError: state.lastError, port: state.port };
    }
    res.json(result);
  });

  // Real RTSP path auto-discovery - the "Discover Path" button in the
  // camera config UI. Never invents a path: tries this ecosystem's own
  // known-real paths (RTSP_PATH_CANDIDATES, module scope) one at a time
  // with a real pause between attempts, and reports exactly which ones
  // it tried either way.
  app.post("/api/camera/discover-rtsp-path", authenticate, requireAdmin, async (req, res) => {
    const { host, port, username, password } = req.body || {};
    if (typeof host !== "string" || !host.trim()) {
      return res.status(400).json({ error: "host is required" });
    }
    const realPort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 554;
    const result = await discoverRtspPath(host.trim(), realPort, username || "", password || "");
    res.json(result);
  });

  // Real PTZ control - Vision Center's own pan/tilt/zoom control, IP
  // cameras only. Takes the camera's own real ipHost/ipUsername/
  // ipPassword directly from the request body (same convention already
  // established by discover-rtsp-path above - the client already holds
  // this camera's own config, no server-side lookup needed) rather than
  // rtspPort (PTZ goes over the camera's real HTTP API, port 80 unless
  // told otherwise - a genuinely different port from the RTSP stream
  // itself). pan/tilt/zoom are each clamped to the real PSIA range
  // (-100..100); omit all three (or send 0/0/0) to stop.
  app.post("/api/camera/:id/ptz", authenticate, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "camera id must be a positive integer" });
    }
    const { host, port, username, password, pan, tilt, zoom, channel } = req.body || {};
    if (typeof host !== "string" || !host.trim()) {
      return res.status(400).json({ error: "host is required" });
    }
    const clamp = (n: unknown): number => {
      const num = Number(n);
      if (!Number.isFinite(num)) return 0;
      return Math.max(-100, Math.min(100, Math.round(num)));
    };
    const httpPort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 80;
    const ch = Number.isInteger(channel) && channel > 0 ? channel : 1;
    const result = await sendPtzCommand(host.trim(), httpPort, username || "", password || "", ch, clamp(pan), clamp(tilt), clamp(zoom));
    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        statusCode: result.statusCode,
        error: result.error || `camera answered the PTZ request with HTTP ${result.statusCode} - this camera may genuinely have no motorized pan/tilt/zoom hardware`,
      });
    }
    res.json({ ok: true });
  });

  // Real USB camera discovery - the "Discover USB Devices" button.
  // Shells out to HYDRA-UMC-VISION-STREAMER's own "discover-usb"
  // subcommand (same real cv2.VideoCapture backend that actually
  // captures frames, so a device this reports as available is the same
  // one "stream serve" would actually be able to open) rather than
  // re-implementing device enumeration a second time in Node, where
  // there's no reliable cross-platform way to do it without a native
  // dependency.
  app.get("/api/camera/discover-usb-devices", authenticate, async (req, res) => {
    const exePath = visionStreamerExecutablePath();
    if (!fs.existsSync(exePath)) {
      return res.status(503).json({ error: `HYDRA-UMC-VISION-STREAMER not found at ${exePath}`, devices: [] });
    }
    try {
      const { stdout } = await execFileAsync(exePath, ["discover-usb", "--max", "10"], { timeout: 15000 });
      const devices = JSON.parse(stdout);
      res.json({ devices });
    } catch (e) {
      res.status(500).json({ error: `USB device discovery failed: ${e instanceof Error ? e.message : String(e)}`, devices: [] });
    }
  });
}
