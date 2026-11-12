import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { activeTwinRelaySessions, handleTwinRelay, normalizeTwinWsUrl, TWIN_RELAY_MAX_SESSIONS, type SessionCheck } from "../src/twinRelay.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const portOf = (server: http.Server) => (server.address() as AddressInfo).port;

/** A stand-in for the twin: it records the headers of every opening request and pushes `pushed` to each client. */
async function fakeTwin(pushed: string[], accept = true) {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { req: http.IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
      seen.push(info.req.headers);
      if (accept && /^Bearer \S+$/.test(String(info.req.headers.authorization ?? ""))) done(true);
      else done(false, 401, "Unauthorized");
    },
  });
  wss.on("connection", (ws) => { for (const text of pushed) ws.send(text); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    url: `ws://127.0.0.1:${portOf(server)}/twin/ws`,
    close: () => { for (const client of wss.clients) client.terminate(); wss.close(); server.close(); server.closeAllConnections?.(); },
  };
}

/** The Server side: a listener that hands every connection to the relay. */
async function relayServer(deps: { twinWsUrl: string; verify: (token: string) => Promise<SessionCheck>; heartbeatMs?: number }) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, handleProtocols: (protocols) => (protocols.has("hydra.bearer") ? "hydra.bearer" : false) });
  wss.on("connection", (ws, req) => handleTwinRelay(ws, req, { twinWsUrl: deps.twinWsUrl, verifySession: deps.verify, heartbeatMs: deps.heartbeatMs }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${portOf(server)}/api/twin/ws`,
    close: () => { for (const client of wss.clients) client.terminate(); wss.close(); server.close(); server.closeAllConnections?.(); },
  };
}

function listen(url: string, protocols: string[] = ["hydra.bearer", "good.token"], afterMs = 600) {
  return new Promise<{ heard: string[]; closeCode: number | null; accepted: string }>((resolve, reject) => {
    const socket = new WebSocket(url, protocols);
    const heard: string[] = [];
    let closeCode: number | null = null;
    socket.on("message", (raw) => heard.push(raw.toString()));
    socket.on("close", (code) => { closeCode = code; });
    socket.on("error", reject);
    setTimeout(() => { const accepted = socket.protocol; socket.terminate(); resolve({ heard, closeCode, accepted }); }, afterMs);
  });
}

const good = async (token: string): Promise<SessionCheck> => (token === "good.token" ? { ok: true, recheck: () => true } : { ok: false, reason: "Invalid token" });

test("the address of the twin must be ws or wss, with no credentials", () => {
  assert.equal(normalizeTwinWsUrl(""), null);
  assert.equal(normalizeTwinWsUrl(undefined), null);
  assert.equal(normalizeTwinWsUrl("http://127.0.0.1:8112/twin/ws"), null);
  assert.equal(normalizeTwinWsUrl("ws://user:pass@127.0.0.1:8112/twin/ws"), null);
  assert.equal(normalizeTwinWsUrl("not a url"), null);
  assert.equal(normalizeTwinWsUrl("ws://127.0.0.1:8112/twin/ws"), "ws://127.0.0.1:8112/twin/ws");
  assert.equal(normalizeTwinWsUrl(" wss://twin.local/twin/ws "), "wss://twin.local/twin/ws");
});

test("a panel hears what the twin pushes, and the twin gets the person's own token in the header and no Origin", async () => {
  const twin = await fakeTwin(['{"type":"state","j1":0.5}', '{"type":"state","j1":0.6}']);
  const relay = await relayServer({ twinWsUrl: twin.url, verify: good });
  try {
    const result = await listen(relay.url);
    assert.deepEqual(result.heard, ['{"type":"state","j1":0.5}', '{"type":"state","j1":0.6}']);
    assert.equal(result.accepted, "hydra.bearer");
    assert.equal(twin.seen.length, 1);
    assert.equal(twin.seen[0].authorization, "Bearer good.token");
    assert.equal(twin.seen[0].origin, undefined);
    await wait(100);
    assert.equal(activeTwinRelaySessions(), 0, "a closed panel frees its place");
  } finally {
    relay.close();
    twin.close();
  }
});

test("a missing or invalid token is refused with 1008 and never reaches the twin", async () => {
  const twin = await fakeTwin(["x"]);
  const relay = await relayServer({ twinWsUrl: twin.url, verify: good });
  try {
    const none = await listen(relay.url, [], 500);
    assert.ok(none.heard[0]?.includes("Access denied"), none.heard.join("|"));
    assert.equal(none.closeCode, 1008);
    const bad = await listen(relay.url, ["hydra.bearer", "other.token"], 500);
    assert.ok(bad.heard[0]?.includes("Invalid token"), bad.heard.join("|"));
    assert.equal(bad.closeCode, 1008);
    assert.equal(twin.seen.length, 0);
  } finally {
    relay.close();
    twin.close();
  }
});

test("with no address set the relay says so and closes with 1013", async () => {
  const relay = await relayServer({ twinWsUrl: "", verify: good });
  try {
    const result = await listen(relay.url, ["hydra.bearer", "good.token"], 500);
    assert.ok(result.heard[0]?.includes("not configured"), result.heard.join("|"));
    assert.equal(result.closeCode, 1013);
  } finally {
    relay.close();
  }
});

test("a twin that refuses the connection closes the panel with 1011", async () => {
  const twin = await fakeTwin([], false);
  const relay = await relayServer({ twinWsUrl: twin.url, verify: good });
  try {
    const result = await listen(relay.url);
    assert.equal(result.closeCode, 1011);
    assert.ok(result.heard.some((text) => text.includes("twin")), result.heard.join("|"));
    assert.equal(activeTwinRelaySessions(), 0);
  } finally {
    relay.close();
    twin.close();
  }
});

test("what a panel sends is never forwarded to the twin", async () => {
  const received: string[] = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => ws.on("message", (raw) => received.push(raw.toString())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const relay = await relayServer({ twinWsUrl: `ws://127.0.0.1:${portOf(server)}/twin/ws`, verify: good });
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(relay.url, ["hydra.bearer", "good.token"]);
      socket.on("open", () => { socket.send("move j1"); setTimeout(() => { socket.terminate(); resolve(); }, 400); });
      socket.on("error", reject);
    });
    assert.deepEqual(received, []);
  } finally {
    relay.close();
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.close();
    server.closeAllConnections?.();
  }
});

test("a session whose account changed is closed at the next check", async () => {
  const twin = await fakeTwin([]);
  let valid = true;
  const relay = await relayServer({
    twinWsUrl: twin.url,
    verify: async () => ({ ok: true, recheck: () => valid }),
    heartbeatMs: 80,
  });
  try {
    const closed = await new Promise<boolean>((resolve, reject) => {
      const socket = new WebSocket(relay.url, ["hydra.bearer", "good.token"]);
      socket.on("open", () => { valid = false; });
      socket.on("close", () => resolve(true));
      socket.on("error", reject);
      setTimeout(() => resolve(false), 1500);
    });
    assert.equal(closed, true);
  } finally {
    relay.close();
    twin.close();
  }
});

test("only a limited number of panels may watch at once", async () => {
  const twin = await fakeTwin([]);
  const relay = await relayServer({ twinWsUrl: twin.url, verify: good });
  const sockets: WebSocket[] = [];
  try {
    for (let i = 0; i < TWIN_RELAY_MAX_SESSIONS; i++) {
      sockets.push(await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(relay.url, ["hydra.bearer", "good.token"]);
        socket.on("open", () => resolve(socket));
        socket.on("error", reject);
      }));
    }
    await wait(300);
    assert.equal(activeTwinRelaySessions(), TWIN_RELAY_MAX_SESSIONS);
    const extra = await listen(relay.url, ["hydra.bearer", "good.token"], 500);
    assert.equal(extra.closeCode, 1013);
    assert.ok(extra.heard[0]?.includes("Too many"), extra.heard.join("|"));
  } finally {
    for (const socket of sockets) socket.terminate();
    relay.close();
    twin.close();
  }
});

test("the real endpoint serves /ws and /api/twin/ws on one listener and turns other paths away", async () => {
  const { default: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: jwt } = await import("jsonwebtoken");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-umc-twin-relay-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  const server = http.createServer();
  const twin = await fakeTwin(['{"type":"state"}']);
  let wss: WebSocketServer | undefined;
  try {
    const { createUser, findUser, effectiveTokenVersion, effectiveId } = await import("../src/users");
    const { attachWebSocketServer } = await import("../src/ws");
    const { JWT_SECRET } = await import("../src/auth");
    await createUser("watcher", "another-long-password", "operator");
    const user = findUser("watcher")!;
    const token = jwt.sign({ username: "watcher", role: "operator", tokenVersion: effectiveTokenVersion(user), id: effectiveId(user) }, JWT_SECRET, { expiresIn: "5m" });
    wss = attachWebSocketServer(server, {
      wsClients: new Set(),
      getSettings: () => ({ controllers: [] }),
      applySettingsUpdate: async () => undefined,
      WS_QUERY_TOKEN_ALLOWED: false,
      twinWsUrl: () => twin.url,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `ws://127.0.0.1:${portOf(server)}`;
    const viaTwin = await listen(`${base}/api/twin/ws`, ["hydra.bearer", token], 600);
    assert.deepEqual(viaTwin.heard, ['{"type":"state"}']);
    assert.equal(twin.seen[0].authorization, `Bearer ${token}`);
    const viaSettings = await listen(`${base}/ws`, ["hydra.bearer", token], 600);
    assert.ok(viaSettings.heard[0]?.includes('"type":"settings"'), viaSettings.heard.join("|"));
    await assert.rejects(listen(`${base}/elsewhere`, ["hydra.bearer", token], 600));
  } finally {
    for (const client of wss?.clients ?? []) client.terminate();
    wss?.close();
    twin.close();
    (await import("../src/runtime")).bonjour.destroy();
    server.close();
    server.closeAllConnections?.();
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
