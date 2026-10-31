// =============================================================================
// HYDRA-UMC-SERVER - Legacy client opt-out contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Against a real running server: by default the camera pictures demand a ticket or a token and /ws?token= is refused; the two documented opt-outs
// (HYDRA_UMC_CAMERA_AUTH=open, HYDRA_UMC_WS_QUERY_TOKEN=allow) bring back what the clients that have not moved yet need, each one on its own, and a ticket still works
// when the pictures are required.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "optout-contract-admin", password: "optout-contract-admin-password" };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

async function withServer(env, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-optout-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await mkdir(path.join(directory, "data"), { recursive: true });
    await writeFile(path.join(directory, "data", "settings.json"), JSON.stringify({ settings: { serverName: "opt-out" }, controllers: [{ id: "c", name: "C", cameras: [], robots: [] }] }));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: directory,
      env: {
        ...process.env, PORT: String(port), NODE_ENV: "test", JWT_SECRET: "local-opt-out-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username, HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password, HYDRA_UMC_CAMERA_AUTH: "", HYDRA_UMC_WS_QUERY_TOKEN: "", ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    const deadline = Date.now() + 15000;
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/hydra-info`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server did not start\n${logs}`);
      await wait(100);
    }
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ADMIN) });
    const token = (await login.json()).token;
    assert.equal(typeof token, "string");
    await run(port, token, () => logs);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once("exit", resolve)); }
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }).catch(() => undefined);
  }
}

const status = async (port, route, headers = {}) => (await fetch(`http://127.0.0.1:${port}${route}`, { headers })).status;

/** Opens /ws with the given URL and subprotocols; resolves to the close code and the messages that arrived. */
const openSocket = (port, query, protocols) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, protocols);
  const messages = [];
  const timer = setTimeout(() => { socket.terminate(); resolve({ code: null, messages }); }, 2500);
  socket.on("message", (data) => { messages.push(data.toString()); if (messages.some((m) => m.includes('"type":"settings"'))) { clearTimeout(timer); socket.close(); } });
  socket.on("close", (code) => { clearTimeout(timer); resolve({ code, messages }); });
  socket.on("error", (error) => { clearTimeout(timer); reject(error); });
});
const gotSettings = (result) => result.messages.some((m) => m.includes('"type":"settings"'));

async function main() {
  // --- defaults: pictures need a ticket or a token, a token in the address is refused, the subprotocol works
  await withServer({}, async (port, token, logs) => {
    assert.equal(await status(port, "/api/camera/1/stream"), 401, "a live picture without a ticket is refused by default");
    assert.equal(await status(port, "/api/camera/media/1/snapshots/none.jpg"), 401, "a saved photo without a ticket is refused by default");
    assert.equal(await status(port, "/api/camera/1/stream", { authorization: `Bearer ${token}` }) === 401, false, "a Bearer header opens the picture");
    const ticket = (await (await fetch(`http://127.0.0.1:${port}/api/camera/ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()).ticket;
    assert.equal(await status(port, `/api/camera/media/1/snapshots/none.jpg?ticket=${encodeURIComponent(ticket)}`), 404, "a ticket gets through to the file lookup");
    const query = await openSocket(port, `?token=${encodeURIComponent(token)}`, undefined);
    assert.equal(gotSettings(query), false, "/ws?token= receives nothing by default");
    assert.equal(query.code, 1008);
    assert.equal(gotSettings(await openSocket(port, "", ["hydra.bearer", token])), true, "the subprotocol opens the connection");
    assert.equal(gotSettings(await openSocket(port, "?remoteApiVersion=2", ["hydra.bearer", token])), true);
    const noToken = await openSocket(port, "", undefined);
    assert.equal(noToken.code, 1008, "no token at all is still refused");
    assert.equal(/HYDRA_UMC_(CAMERA_AUTH=open|WS_QUERY_TOKEN=allow)/.test(logs()), false, "no opt-out warning by default");
  });

  // --- the camera opt-out on its own
  await withServer({ HYDRA_UMC_CAMERA_AUTH: "open" }, async (port, token, logs) => {
    assert.notEqual(await status(port, "/api/camera/media/1/snapshots/none.jpg"), 401, "HYDRA_UMC_CAMERA_AUTH=open opens the pictures again");
    assert.equal(gotSettings(await openSocket(port, `?token=${encodeURIComponent(token)}`, undefined)), false, "and does not open /ws?token=");
    assert.match(logs(), /HYDRA_UMC_CAMERA_AUTH=open/, "the server says it runs with the opt-out");
  });

  // --- the WebSocket opt-out on its own
  await withServer({ HYDRA_UMC_WS_QUERY_TOKEN: "allow" }, async (port, token, logs) => {
    assert.equal(gotSettings(await openSocket(port, `?token=${encodeURIComponent(token)}`, undefined)), true, "HYDRA_UMC_WS_QUERY_TOKEN=allow accepts /ws?token=");
    assert.equal(gotSettings(await openSocket(port, "?token=garbage", undefined)), false, "and still checks the token");
    assert.equal(await status(port, "/api/camera/media/1/snapshots/none.jpg"), 401, "and does not open the pictures");
    assert.match(logs(), /HYDRA_UMC_WS_QUERY_TOKEN=allow/);
  });

  // --- the same two options saved from Server Admin (no variable), applied on the next request and closed again
  await withServer({}, async (port, token) => {
    const put = (patch) => fetch(`http://127.0.0.1:${port}/api/admin/server-config`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(patch) });
    assert.equal(await status(port, "/api/camera/media/1/snapshots/none.jpg"), 401);
    assert.equal((await put({ camera: { open: true } })).status, 200);
    assert.notEqual(await status(port, "/api/camera/media/1/snapshots/none.jpg"), 401, "an administrator can open the pictures from Server Admin");
    assert.equal((await put({ camera: { open: false } })).status, 200);
    assert.equal(await status(port, "/api/camera/media/1/snapshots/none.jpg"), 401, "and close them again without a restart");
    assert.equal(gotSettings(await openSocket(port, `?token=${encodeURIComponent(token)}`, undefined)), false);
    assert.equal((await put({ websocket: { allowQueryToken: true } })).status, 200);
    assert.equal(gotSettings(await openSocket(port, `?token=${encodeURIComponent(token)}`, undefined)), true, "an administrator can allow /ws?token= from Server Admin");
    assert.equal((await put({ websocket: { allowQueryToken: false } })).status, 200);
    assert.equal(gotSettings(await openSocket(port, `?token=${encodeURIComponent(token)}`, undefined)), false);
  });

  // --- the password of an IP camera and the TLS of a new installation: conservative by default, loosened from Server Admin with a warning, locked by the environment
  await withServer({}, async (port, token) => {
    const put = async (patch) => { const response = await fetch(`http://127.0.0.1:${port}/api/admin/server-config`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(patch) }); return { status: response.status, body: await response.json() }; };
    const before = (await (await fetch(`http://127.0.0.1:${port}/api/admin/server-config`, { headers: { authorization: `Bearer ${token}` } })).json());
    assert.deepEqual(before.camera.credentialsViaEnv, { value: true, source: "default" });
    assert.deepEqual(before.install.newInstallTls, { value: true, source: "default" });
    const loosened = await put({ camera: { credentialsViaEnv: false }, install: { newInstallTls: false } });
    assert.equal(loosened.status, 200);
    assert.deepEqual(loosened.body.warnings.sort(), ["camera_credentials_in_arguments", "new_install_tls_off"]);
    assert.deepEqual(loosened.body.camera.credentialsViaEnv, { value: false, source: "config" });
    assert.equal((await put({ camera: { credentialsViaEnv: "off" } })).status, 400);
    assert.equal((await put({ install: [] })).status, 400);
    const closed = await put({ camera: { credentialsViaEnv: true }, install: { newInstallTls: true } });
    assert.deepEqual(closed.body.warnings, []);
  });
  await withServer({ HYDRA_UMC_CAMERA_CREDENTIALS_VIA_ENV: "off", HYDRA_UMC_NEW_INSTALL_TLS: "off" }, async (port, token) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/server-config`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ camera: { credentialsViaEnv: true } }) });
    assert.equal(response.status, 409, "the environment locks the option");
    const config = await (await fetch(`http://127.0.0.1:${port}/api/admin/server-config`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(config.camera.credentialsViaEnv, { value: false, source: "env" });
    assert.deepEqual(config.install.newInstallTls, { value: false, source: "env" });
  });

  console.log("SERVER_LEGACY_OPT_OUT_CONTRACT=PASS defaults=8 camera_opt_out=3 ws_query_opt_out=4 saved_options=6 access_options=10");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
