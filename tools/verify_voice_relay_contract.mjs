// =============================================================================
// HYDRA-UMC-SERVER - Authenticated Server-to-Voice-UI relay contract check
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts the real Python Voice UI gateway and the real Server on temporary
// localhost ports. It proves the authenticated, non-actuating chain without
// a watch, CM5, robot, persisted project data or mocked assistant response.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = path.resolve(ROOT, "..");
const VOICE_ROOT = path.join(WORKSPACE, "HYDRA-UMC-VOICE-UI");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "voice-contract-admin", password: "voice-contract-admin-password" };
const VOICE_TOKEN = "voice-relay-contract-token";

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address === "object");
  listener.close();
  await once(listener, "close");
  return address.port;
}

async function waitFor(url) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`service did not become ready: ${lastError}`);
}

async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-voice-relay-"));
  const voicePort = await reservePort();
  const serverPort = await reservePort();
  const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  let voice;
  let server;
  let logs = "";
  try {
    await mkdir(path.join(temporaryDirectory, "data"), { recursive: true });
    await writeFile(path.join(temporaryDirectory, "data", "settings.json"), "{}\n", "utf8");
    voice = spawn(python, ["-m", "hydra_umc_voice_ui.main", "serve", "--host", "127.0.0.1", "--port", String(voicePort)], {
      cwd: VOICE_ROOT,
      env: {
        ...process.env,
        PYTHONPATH: `${path.join(VOICE_ROOT, "src")}${pathSeparator}${process.env.PYTHONPATH || ""}`,
        HYDRA_UMC_VOICE_UI_TOKEN: VOICE_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    voice.stdout.on("data", (chunk) => { logs += chunk; });
    voice.stderr.on("data", (chunk) => { logs += chunk; });
    await waitFor(`http://127.0.0.1:${voicePort}/health`);

    server = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: {
        ...process.env,
        PORT: String(serverPort),
        NODE_ENV: "test",
        JWT_SECRET: "voice-relay-contract-server-secret-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        HYDRA_UMC_VOICE_UI_URL: `http://127.0.0.1:${voicePort}`,
        HYDRA_UMC_VOICE_UI_TOKEN: VOICE_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { logs += chunk; });
    server.stderr.on("data", (chunk) => { logs += chunk; });
    await waitFor(`http://127.0.0.1:${serverPort}/api/hydra-info`);

    const login = await request(serverPort, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    assert.equal(login.response.status, 200);
    const authorization = { authorization: `Bearer ${login.body.token}` };

    const anonymous = await request(serverPort, "/api/voice/turn", {
      method: "POST",
      body: JSON.stringify({ type: "voice_turn", requestId: "anonymous", transcript: "status", locale: "en-US" }),
    });
    assert.equal(anonymous.response.status, 401);

    const status = await request(serverPort, "/api/watch/system-status", { headers: authorization });
    assert.equal(status.response.status, 200);
    assert.equal(status.body.type, "system_status");
    assert.equal(status.body.level, "NOMINAL");

    const telemetry = await request(serverPort, "/api/voice/turn", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ type: "voice_turn", requestId: "voice-status-001", transcript: "status", locale: "en-US" }),
    });
    assert.equal(telemetry.response.status, 200);
    assert.equal(telemetry.body.type, "assistant_reply");
    assert.equal(telemetry.body.requestId, "voice-status-001");
    assert.equal(telemetry.body.requiresConfirmation, false);

    const motion = await request(serverPort, "/api/voice/turn", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ type: "voice_turn", requestId: "voice-motion-001", transcript: "start mission demo", locale: "en-US" }),
    });
    assert.equal(motion.response.status, 200);
    assert.equal(motion.body.requiresConfirmation, true);
    console.log("SERVER_VOICE_RELAY_CONTRACT=PASS auth=1 status=1 non_actuating_motion=1");
  } finally {
    await stop(server);
    await stop(voice);
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error("SERVER_VOICE_RELAY_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
