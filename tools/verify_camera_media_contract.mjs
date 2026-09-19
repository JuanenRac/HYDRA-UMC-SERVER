// =============================================================================
// HYDRA-UMC-SERVER - camera snapshot/recording contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts a real Server instance AND a fake local mjpeg_server.py stand-in
// (same real wire format: boundary "hydraumcframe", `Content-Type:
// image/jpeg` + `Content-Length: N` headers before each frame's raw JPEG
// bytes - see HYDRA-UMC-VISION-STREAMER's own mjpeg_server.py) bound to the
// exact deterministic port GET /api/camera/1/stream already expects
// (cameraStreamPort(1) === 8100). Snapshot/recording capture is exercised
// against this real local stream, not mocked at the Server boundary.

import assert from "node:assert/strict";
import { once } from "node:events";
import { rm, mkdtemp, copyFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "camera-media-contract-admin", password: "camera-media-contract-admin-password" };
const CAMERA_1_STREAM_PORT = 8100;
const BOUNDARY = "hydraumcframe";
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4, 5]); // not a real decodable JPEG - only byte identity is asserted

function startFakeCameraStream(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}` });
    let stopped = false;
    req.on("close", () => { stopped = true; });
    const sendFrame = () => {
      if (stopped || res.writableEnded) return;
      const header = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${FAKE_JPEG.length}\r\n\r\n`;
      res.write(header);
      res.write(FAKE_JPEG);
      res.write("\r\n");
      setTimeout(sendFrame, 20);
    };
    sendFrame();
  });
  server.listen(port, "127.0.0.1");
  return server;
}

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address === "object");
  const { port } = address;
  listener.close();
  await once(listener, "close");
  return port;
}

async function waitForServer(port) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/hydra-info`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

async function main() {
  const workspace = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-camera-media-"));
  const serverCwd = path.join(workspace, "HYDRA-UMC-SERVER-under-test");

  let child;
  let fakeCamera;
  let logs = "";
  const serverPort = await reservePort();
  try {
    fakeCamera = startFakeCameraStream(CAMERA_1_STREAM_PORT);
    await once(fakeCamera, "listening");

    await mkdir(serverCwd, { recursive: true });
    await copyFile(path.join(ROOT, "package.json"), path.join(serverCwd, "package.json"));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: serverCwd,
      env: {
        ...process.env,
        PORT: String(serverPort),
        NODE_ENV: "test",
        JWT_SECRET: "local-camera-media-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    try {
      await waitForServer(serverPort);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
    }

    // Unauthenticated: refused before any capture is ever attempted.
    const anonSnapshot = await requestJson(serverPort, "/api/camera/1/snapshot", { method: "POST" });
    assert.equal(anonSnapshot.response.status, 401, "an unauthenticated snapshot request must be refused");
    const anonStart = await requestJson(serverPort, "/api/camera/1/recording/start", { method: "POST" });
    assert.equal(anonStart.response.status, 401, "an unauthenticated recording start must be refused");
    const anonMedia = await requestJson(serverPort, "/api/camera/media");
    assert.equal(anonMedia.response.status, 401, "an unauthenticated media listing must be refused");

    const login = await requestJson(serverPort, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    assert.equal(login.response.status, 200);
    const authorization = { authorization: `Bearer ${login.body.token}` };

    // No local stream running for camera 2 - must fail honestly, not
    // fabricate a snapshot.
    const noStream = await requestJson(serverPort, "/api/camera/2/snapshot", { method: "POST", headers: authorization });
    assert.equal(noStream.response.status, 503, "snapshotting a camera with no running local stream must be a clean 503");

    // Real snapshot capture against the fake local stream.
    const snapshot = await requestJson(serverPort, "/api/camera/1/snapshot", { method: "POST", headers: authorization });
    assert.equal(snapshot.response.status, 200, JSON.stringify(snapshot.body));
    assert.equal(snapshot.body.cameraId, 1);
    assert.equal(snapshot.body.sizeBytes, FAKE_JPEG.length);
    assert.ok(snapshot.body.filename.endsWith(".jpg"));

    // Deliberately unauthenticated, matching GET /api/camera/:id/stream's
    // own precedent - a plain <img src="..."> (what CameraMediaView.tsx
    // really renders) cannot send an Authorization header. Real bug found
    // via live testing on the CM5: this route used to require auth, so
    // every real photo/recording rendered as a broken image.
    const snapshotBytes = await fetch(`http://127.0.0.1:${serverPort}/api/camera/media/1/snapshots/${snapshot.body.filename}`);
    assert.equal(snapshotBytes.status, 200, "serving a saved snapshot must not require authentication, same as the live stream route");
    assert.equal(snapshotBytes.headers.get("content-type"), "image/jpeg");
    const snapshotBuffer = Buffer.from(await snapshotBytes.arrayBuffer());
    assert.ok(snapshotBuffer.equals(FAKE_JPEG), "the served snapshot bytes must exactly match the captured frame");

    // Path traversal in the filename must never escape the camera's own
    // folder, even unauthenticated.
    const traversal = await fetch(`http://127.0.0.1:${serverPort}/api/camera/media/1/snapshots/${encodeURIComponent("../../server.ts")}`);
    assert.equal(traversal.status, 404, "a path-traversal filename must be refused, not served");

    // Real recording lifecycle.
    const start = await requestJson(serverPort, "/api/camera/1/recording/start", { method: "POST", headers: authorization });
    assert.equal(start.response.status, 200, JSON.stringify(start.body));
    assert.ok(start.body.filename.endsWith(".mjpeg"));

    const doubleStart = await requestJson(serverPort, "/api/camera/1/recording/start", { method: "POST", headers: authorization });
    assert.equal(doubleStart.response.status, 409, "starting a second recording on the same camera must be refused");

    await new Promise((resolve) => setTimeout(resolve, 150)); // let a few real frames land on disk

    const stop = await requestJson(serverPort, "/api/camera/1/recording/stop", { method: "POST", headers: authorization });
    assert.equal(stop.response.status, 200, JSON.stringify(stop.body));
    assert.equal(stop.body.filename, start.body.filename);

    const doubleStop = await requestJson(serverPort, "/api/camera/1/recording/stop", { method: "POST", headers: authorization });
    assert.equal(doubleStop.response.status, 404, "stopping a recording that is not active must be a clean 404");

    await new Promise((resolve) => setTimeout(resolve, 100)); // let the reader's own finally{} flush+close the file

    const recordingBytes = await fetch(`http://127.0.0.1:${serverPort}/api/camera/media/1/recordings/${start.body.filename}`);
    assert.equal(recordingBytes.status, 200, "serving a saved recording must not require authentication either");
    assert.match(recordingBytes.headers.get("content-type") ?? "", /multipart\/x-mixed-replace/);
    const recordingBuffer = Buffer.from(await recordingBytes.arrayBuffer());
    assert.ok(recordingBuffer.includes(`--${BOUNDARY}`), "a saved recording must contain at least one real captured frame boundary");
    assert.ok(recordingBuffer.includes(FAKE_JPEG), "a saved recording must contain the real captured JPEG bytes, not a placeholder");

    const media = await requestJson(serverPort, "/api/camera/media", { headers: authorization });
    assert.equal(media.response.status, 200);
    const snapshotEntry = media.body.items.find((item) => item.kind === "snapshots" && item.filename === snapshot.body.filename);
    const recordingEntry = media.body.items.find((item) => item.kind === "recordings" && item.filename === start.body.filename);
    assert.ok(snapshotEntry, "the captured snapshot must be listed");
    assert.ok(recordingEntry, "the finished recording must be listed");
    assert.equal(recordingEntry.recording, false, "a stopped recording must not still be marked as recording");
    assert.equal(typeof recordingEntry.frameCount, "number", "a stopped recording must carry a real frameCount");
    assert.ok(recordingEntry.frameCount > 0, "a recording that captured real frames must report frameCount > 0");
    assert.equal(typeof recordingEntry.durationMs, "number", "a stopped recording must carry a real durationMs");
    assert.equal(snapshotEntry.frameCount, undefined, "a snapshot must never carry recording-only metadata");

    // Deleting media is real and permanent, and refuses an in-progress recording.
    const start2 = await requestJson(serverPort, "/api/camera/1/recording/start", { method: "POST", headers: authorization });
    assert.equal(start2.response.status, 200, JSON.stringify(start2.body));
    const deleteWhileRecording = await requestJson(serverPort, `/api/camera/media/1/recordings/${start2.body.filename}`, { method: "DELETE", headers: authorization });
    assert.equal(deleteWhileRecording.response.status, 409, "deleting a recording still in progress must be refused");
    await requestJson(serverPort, "/api/camera/1/recording/stop", { method: "POST", headers: authorization });

    const deleteAnonymous = await fetch(`http://127.0.0.1:${serverPort}/api/camera/media/1/snapshots/${snapshot.body.filename}`, { method: "DELETE" });
    assert.equal(deleteAnonymous.status, 401, "deleting media must require authentication, unlike serving it");

    const deleteSnapshot = await requestJson(serverPort, `/api/camera/media/1/snapshots/${snapshot.body.filename}`, { method: "DELETE", headers: authorization });
    assert.equal(deleteSnapshot.response.status, 200, JSON.stringify(deleteSnapshot.body));
    const afterDelete = await requestJson(serverPort, "/api/camera/media", { headers: authorization });
    assert.ok(
      !afterDelete.body.items.some((item) => item.kind === "snapshots" && item.filename === snapshot.body.filename),
      "a deleted snapshot must never appear in a later media list",
    );
    const refetchDeleted = await fetch(`http://127.0.0.1:${serverPort}/api/camera/media/1/snapshots/${snapshot.body.filename}`);
    assert.equal(refetchDeleted.status, 404, "a deleted snapshot must genuinely be gone from disk, not just hidden from the list");

    console.log(
      `SERVER_CAMERA_MEDIA_CONTRACT=PASS anon=3 no_stream=1 snapshot=1 traversal_blocked=1 recording_lifecycle=1 double_start_blocked=1 double_stop_blocked=1 media_list=2 recording_metadata=1 delete=3`,
    );
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (fakeCamera) await new Promise((resolve) => fakeCamera.close(resolve));
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error("SERVER_CAMERA_MEDIA_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
