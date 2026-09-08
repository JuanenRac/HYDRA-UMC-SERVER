// =============================================================================
// HYDRA-UMC-SERVER - POST /api/voice/turn error-path contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// verify_voice_relay_contract.mjs already proves the real end-to-end happy
// path against the real Python Voice UI gateway (200 for status/motion
// intents, 401 anonymous, per-client remote-access gating). What that file
// does NOT cover is this route's own real error branches - the ones a
// flaky/misconfigured/rejecting upstream actually hits in production. This
// file proves each of those against a small local HTTP stub standing in for
// Voice UI (not the real Python service - deliberately, so every failure
// mode below is exactly controllable rather than incidentally reproduced).

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "voice-error-contract-admin", password: "voice-error-contract-admin-password" };
const VOICE_TOKEN = "voice-error-contract-token";
const TIMEOUT_MS = 500; // real, short - the point of the timeout test

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
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not become ready: ${lastError}`);
}

async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json().catch(() => null) };
}

async function stop(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function validTurn(requestId) {
  return { type: "voice_turn", requestId, transcript: "status", locale: "en-US" };
}

// A minimal, fully controllable stand-in for HYDRA-UMC-VOICE-UI's own real
// POST /v1/voice/turn - behavior is picked per test by `mode`.
function startVoiceUiStub(port, getMode) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const mode = getMode();
      if (mode === "hang") return; // never responds - exercises the real timeout
      if (mode === "reject") {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "voice-ui stub: deliberate rejection" }));
      }
      if (mode === "malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "assistant_reply", requestId: "wrong-id", text: "x", level: "info", speak: false, requiresConfirmation: false }));
      }
      // mode === "ok"
      const parsed = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        type: "assistant_reply", requestId: parsed.requestId, text: "All systems nominal.",
        level: "info", speak: false, requiresConfirmation: false,
      }));
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

async function withServer({ voiceUiUrl }, run) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-voice-turn-error-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await mkdir(path.join(temporaryDirectory, "data"), { recursive: true });
    await writeFile(path.join(temporaryDirectory, "data", "settings.json"), `${JSON.stringify({ settings: { serverName: "Voice Turn Error Contract" }, controllers: [] })}\n`, "utf8");
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        JWT_SECRET: "local-voice-turn-error-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        ...(voiceUiUrl ? { HYDRA_UMC_VOICE_UI_URL: voiceUiUrl, HYDRA_UMC_VOICE_UI_TOKEN: VOICE_TOKEN, HYDRA_UMC_VOICE_UI_TIMEOUT_MS: String(TIMEOUT_MS) } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    try {
      await waitForServer(port);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
    }
    const login = await request(port, "/api/login", { method: "POST", body: JSON.stringify(ADMIN) });
    assert.equal(login.response.status, 200, `admin login must succeed\n${logs}`);
    const authorization = { authorization: `Bearer ${login.body.token}` };
    await run(port, authorization);
  } finally {
    await stop(child);
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function main() {
  // --- 400s: validateVoiceTurnPayload's own real branches - no upstream
  // needed, these all fail before any fetch to Voice UI is attempted.
  await withServer({ voiceUiUrl: null }, async (port, authorization) => {
    const notObject = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify("status") });
    assert.equal(notObject.response.status, 400);

    const wrongType = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify({ ...validTurn("t1"), type: "not_voice_turn" }) });
    assert.equal(wrongType.response.status, 400);
    assert.match(wrongType.body.error, /type must be voice_turn/);

    const badRequestId = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify({ ...validTurn("bad id with spaces!"), }) });
    assert.equal(badRequestId.response.status, 400);
    assert.match(badRequestId.body.error, /requestId/);

    const emptyTranscript = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify({ ...validTurn("t2"), transcript: "   " }) });
    assert.equal(emptyTranscript.response.status, 400);
    assert.match(emptyTranscript.body.error, /transcript/);

    const shortLocale = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify({ ...validTurn("t3"), locale: "x" }) });
    assert.equal(shortLocale.response.status, 400);
    assert.match(shortLocale.body.error, /locale/);

    // --- 503: Voice UI not configured on this Server at all - reached only
    // once a payload is otherwise valid, proving the config check is real
    // and not just an early short-circuit that would also reject bad input.
    const notConfigured = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify(validTurn("t4")) });
    assert.equal(notConfigured.response.status, 503);
    assert.match(notConfigured.body.error, /not configured/);
  });

  // --- 502/503/200: real network conditions against a controllable stub.
  const stubPort = await reservePort();
  let stubMode = "ok";
  const stub = startVoiceUiStub(stubPort, () => stubMode);
  await once(stub, "listening");
  try {
    await withServer({ voiceUiUrl: `http://127.0.0.1:${stubPort}` }, async (port, authorization) => {
      stubMode = "ok";
      const ok = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify(validTurn("ok-1")) });
      assert.equal(ok.response.status, 200, "a well-formed upstream reply must relay through as 200");
      assert.equal(ok.body.requestId, "ok-1");
      assert.equal(ok.response.headers.get("cache-control"), "no-store");

      stubMode = "reject";
      const rejected = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify(validTurn("rej-1")) });
      assert.equal(rejected.response.status, 502, "a non-2xx upstream response must surface as a real 502, not a 200 or a hang");
      assert.match(rejected.body.error, /rejected the voice turn/);

      stubMode = "malformed";
      const malformed = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify(validTurn("mal-1")) });
      assert.equal(malformed.response.status, 502, "a 200 whose body fails isAssistantReplyForRequest's own contract must still surface as 502, never relayed as-is");
      assert.match(malformed.body.error, /invalid assistant reply/);

      stubMode = "hang";
      const started = Date.now();
      const timedOut = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify(validTurn("hang-1")) });
      const elapsedMs = Date.now() - started;
      assert.equal(timedOut.response.status, 503, "an upstream that never responds must time out as 503, not hang the request forever");
      assert.match(timedOut.body.error, /timed out/);
      assert.ok(elapsedMs < TIMEOUT_MS + 3000, `timeout must fire near the real configured ${TIMEOUT_MS}ms bound, took ${elapsedMs}ms`);
    });
  } finally {
    stub.close();
  }

  // --- 503: real connection failure (nothing listening on this port at all,
  // distinct from "hang" above - proves the catch-block's own two-branch
  // "timedOut ? ... : unavailable" split is real, not just the timeout half).
  const deadPort = await reservePort();
  await withServer({ voiceUiUrl: `http://127.0.0.1:${deadPort}` }, async (port, authorization) => {
    const unavailable = await request(port, "/api/voice/turn", { method: "POST", headers: authorization, body: JSON.stringify(validTurn("dead-1")) });
    assert.equal(unavailable.response.status, 503);
    assert.match(unavailable.body.error, /unavailable/);
  });

  console.log("SERVER_VOICE_TURN_ERROR_PATHS_CONTRACT=PASS validation=5 not-configured=1 upstream-reject=1 malformed-reply=1 timeout=1 connection-refused=1");
}

main().catch((error) => {
  console.error("SERVER_VOICE_TURN_ERROR_PATHS_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
