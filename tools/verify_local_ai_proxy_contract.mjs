// =============================================================================
// HYDRA-UMC-SERVER - GET/POST/etc /api/ai/:service/* real relay verification
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Starts a real Server instance plus real, minimal HTTP stubs standing in
// for two of this cell's own local Hailo-accelerated AI services (same
// "real socket, no mocked client" standard as this project's other
// verify_*_contract.mjs scripts, e.g. verify_canota_relay_contract.mjs).
// Proves: an unknown service name is a clean 404; a real, running local
// service's own path/method/query/JSON body/status code are all forwarded
// unchanged in both directions (GET and POST); a real but NOT-running
// local service (its systemd unit down) is a clean 503, not a crash or a
// hang; and the route is admin/operator-authenticated like every other
// real proxy route in this Server, never reachable anonymously.

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "local-ai-proxy-contract-admin", password: "local-ai-proxy-contract-admin-password" };

// Mirrors LOCAL_AI_SERVICE_PORTS in src/server.ts exactly - a real fixture
// server is bound to two of these four real ports, the other two are
// deliberately left unbound to prove the "not running" path.
const COGNITIVE_NODE_PORT = 8096;
const VLA_ENGINE_PORT = 8098;
const DATALAKE_PORT = 8095;

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
}

async function waitFor(url, startupError = () => undefined) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const processError = startupError();
    if (processError) throw new Error(`service process could not start: ${processError.message}`);
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

// A real, tiny stand-in for one local AI service's own api.py - echoes
// back the real method/path/query/body it received so the test can prove
// the proxy forwarded them unchanged, not just returned something.
function startLocalAiStub(fixedResponse) {
  const seenRequests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      let parsedBody = null;
      if (chunks.length > 0) {
        try { parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { /* not JSON */ }
      }
      seenRequests.push({ method: req.method, pathname: url.pathname, search: url.search, body: parsedBody, authorization: req.headers.authorization ?? null });
      res.writeHead(fixedResponse.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(fixedResponse.body ?? {}));
    });
  });
  return { server, seenRequests };
}

async function main() {
  const workspace = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-local-ai-proxy-"));
  const cognitiveNodeStub = startLocalAiStub({ status: 200, body: { model: "cognitive-node-stub", ready: true } });
  const vlaEngineStub = startLocalAiStub({ status: 200, body: { tokens: [1, 2, 3] } });
  const datalakeStub = startLocalAiStub({ status: 200, body: [{ sourceId: "s", kind: "k", field: "f", timestamp: 1, value: 2 }] });
  cognitiveNodeStub.server.listen(COGNITIVE_NODE_PORT, "127.0.0.1");
  vlaEngineStub.server.listen(VLA_ENGINE_PORT, "127.0.0.1");
  datalakeStub.server.listen(DATALAKE_PORT, "127.0.0.1");
  await Promise.all([once(cognitiveNodeStub.server, "listening"), once(vlaEngineStub.server, "listening"), once(datalakeStub.server, "listening")]);

  const serverPort = await reservePort();
  // the tokens this server presents to the services: one in the environment, one in a file (the way the deployment keeps secrets)
  const COGNITIVE_TOKEN = "cognitive-node-token-for-the-contract";
  const VLA_TOKEN = "vla-engine-token-in-a-file-for-contract";
  const DATALAKE_READ_TOKEN = "datalake-read-token-for-the-contract";
  const vlaTokenFile = path.join(workspace, "vla-engine.token");
  await writeFile(vlaTokenFile, `${VLA_TOKEN}\n`);
  let child;
  let logs = "";

  try {
    let startupError;
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: workspace,
      env: {
        ...process.env,
        PORT: String(serverPort),
        NODE_ENV: "test",
        JWT_SECRET: "local-ai-proxy-contract-secret-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        HYDRA_UMC_COGNITIVE_NODE_TOKEN: COGNITIVE_TOKEN,
        HYDRA_UMC_VLA_ENGINE_TOKEN_FILE: vlaTokenFile,
        HYDRA_UMC_DATALAKE_READ_TOKEN: DATALAKE_READ_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("error", (error) => { startupError = error; });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    await waitFor(`http://127.0.0.1:${serverPort}/api/hydra-info`, () => startupError);

    // Anonymous request must be rejected before ever reaching a local service.
    const anonymous = await fetch(`http://127.0.0.1:${serverPort}/api/ai/cognitive-node/family-status`);
    assert.equal(anonymous.status, 401);

    const login = await fetch(`http://127.0.0.1:${serverPort}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADMIN),
    }).then((r) => r.json());
    const auth = { authorization: `Bearer ${login.token}` };

    // Unknown service name -> clean 404, never a crash or a silent proxy
    // to an arbitrary port.
    const unknown = await fetch(`http://127.0.0.1:${serverPort}/api/ai/not-a-real-service/status`, { headers: auth });
    assert.equal(unknown.status, 404);

    // A real running local service (GET, query string forwarded).
    const getResponse = await fetch(
      `http://127.0.0.1:${serverPort}/api/ai/cognitive-node/family-status?family=ur5`,
      { headers: auth },
    );
    assert.equal(getResponse.status, 200);
    const getBody = await getResponse.json();
    assert.equal(getBody.model, "cognitive-node-stub");
    assert.equal(cognitiveNodeStub.seenRequests.length, 1);
    assert.equal(cognitiveNodeStub.seenRequests[0].method, "GET");
    assert.equal(cognitiveNodeStub.seenRequests[0].pathname, "/family-status");
    assert.equal(cognitiveNodeStub.seenRequests[0].search, "?family=ur5");
    // the service's own Bearer token is presented by this server (from the environment), and the client's session token is not forwarded
    assert.equal(cognitiveNodeStub.seenRequests[0].authorization, `Bearer ${COGNITIVE_TOKEN}`);
    assert.notEqual(cognitiveNodeStub.seenRequests[0].authorization, auth.authorization);

    // A real running local service (POST, real JSON body forwarded).
    const postResponse = await fetch(
      `http://127.0.0.1:${serverPort}/api/ai/vla-engine/tokens/encode`,
      { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ action: "grip" }) },
    );
    assert.equal(postResponse.status, 200);
    const postBody = await postResponse.json();
    assert.deepEqual(postBody.tokens, [1, 2, 3]);
    assert.equal(vlaEngineStub.seenRequests.length, 1);
    assert.equal(vlaEngineStub.seenRequests[0].method, "POST");
    assert.equal(vlaEngineStub.seenRequests[0].pathname, "/tokens/encode");
    assert.deepEqual(vlaEngineStub.seenRequests[0].body, { action: "grip" });
    // ...and the one kept in a file
    assert.equal(vlaEngineStub.seenRequests[0].authorization, `Bearer ${VLA_TOKEN}`);

    // The data lake is reached read-only (the dashboard of the AI summaries reads it through here): a query goes through with the
    // read token of this server, and anything that would write, delete or reconfigure is refused before it is forwarded.
    const lakeRead = await fetch(`http://127.0.0.1:${serverPort}/api/ai/datalake/query?sourceId=s&limit=10`, { headers: auth });
    assert.equal(lakeRead.status, 200);
    assert.equal((await lakeRead.json())[0].sourceId, "s");
    assert.equal(datalakeStub.seenRequests.length, 1);
    assert.equal(datalakeStub.seenRequests[0].pathname, "/query");
    assert.equal(datalakeStub.seenRequests[0].search, "?sourceId=s&limit=10");
    assert.equal(datalakeStub.seenRequests[0].authorization, `Bearer ${DATALAKE_READ_TOKEN}`);
    for (const [method, route] of [["POST", "/ingest"], ["POST", "/retention/apply"], ["DELETE", "/query"], ["GET", "/retention"], ["GET", "/query/../retention"]]) {
      const refused = await fetch(`http://127.0.0.1:${serverPort}/api/ai/datalake${route}`, { method, headers: { "content-type": "application/json", ...auth }, body: method === "GET" ? undefined : "{}" });
      assert.equal(refused.status, 403, `${method} ${route}`);
    }
    assert.equal(datalakeStub.seenRequests.length, 1, "nothing but the read reached the data lake");

    // A real, known service whose own systemd unit simply isn't running
    // right now (nothing bound on its port) - a clean 503, not a hang or
    // an unhandled rejection.
    const notRunning = await fetch(
      `http://127.0.0.1:${serverPort}/api/ai/detection-hef/stats`,
      { headers: auth },
    );
    assert.equal(notRunning.status, 503);
    const notRunningBody = await notRunning.json();
    assert.equal(notRunningBody.available, false);

    console.log("SERVER_LOCAL_AI_PROXY_CONTRACT=PASS auth=1 unknown_service=1 get_forward=1 post_forward=1 not_running=1 service_tokens=2 datalake_read_only=1");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
  } finally {
    cognitiveNodeStub.server.close();
    vlaEngineStub.server.close();
    datalakeStub.server.close();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error("SERVER_LOCAL_AI_PROXY_CONTRACT=FAIL", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
