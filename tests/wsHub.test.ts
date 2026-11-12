// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the live connection hub and the WebSocket endpoint
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// src/ws.ts: what each kind of client hears on a settings write, a robot delta, a claim change and a command event (the credentials of the cameras only for an
// administrator, the small patch only for a client that declared schema 2), the faults that must never reach the write, and the endpoint itself: no token, a token in the
// address, a bad token, a revoked session, the first push, the admin-only settings message, a malformed message and the heartbeat that drops dead or revoked sockets.
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import { WebSocket } from "ws";

type Sent = string[];

const originalCwd = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-umc-wshub-"));
let mods: {
  createWsHub: typeof import("../src/ws.ts").createWsHub;
  attachWebSocketServer: typeof import("../src/ws.ts").attachWebSocketServer;
  users: typeof import("../src/users.ts");
  JWT_SECRET: string;
  RobotIdDuplicatedError: typeof import("../src/robotIds.ts").RobotIdDuplicatedError;
  bonjour: { destroy: () => void };
};

before(async () => {
  process.chdir(dir);
  const ws = await import("../src/ws.ts");
  const users = await import("../src/users.ts");
  const auth = await import("../src/auth.ts");
  const ids = await import("../src/robotIds.ts");
  const runtime = await import("../src/runtime.ts");
  mods = {
    createWsHub: ws.createWsHub, attachWebSocketServer: ws.attachWebSocketServer, users, JWT_SECRET: auth.JWT_SECRET,
    RobotIdDuplicatedError: ids.RobotIdDuplicatedError, bonjour: runtime.bonjour,
  };
  assert.deepEqual(await users.createUser("boss", "a-long-enough-password", "admin"), { ok: true });
  assert.deepEqual(await users.createUser("oper", "a-long-enough-password", "operator"), { ok: true });
  assert.deepEqual(await users.createUser("watcher", "a-long-enough-password", "viewer"), { ok: true });
  assert.deepEqual(await users.createUser("leaver", "a-long-enough-password", "operator"), { ok: true });
});

after(() => {
  // importing the server modules starts the discovery announcer (a UDP socket); it would keep this process alive
  mods?.bonjour.destroy();
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A stand-in for one connected client: it records what it was sent. */
function fakeClient(options: { role?: string; schema?: number; open?: boolean } = {}) {
  const sent: Sent = [];
  const client: any = {
    readyState: options.open === false ? WebSocket.CLOSED : WebSocket.OPEN,
    schema: options.schema ?? 1,
    meta: { role: options.role ?? "operator" },
    send: (text: string) => { sent.push(text); },
  };
  return { client, sent };
}

const CAMERA_TREE = { controllers: [{ id: "c1", cameras: [{ id: 1, name: "bench", ipUsername: "cam-user", ipPassword: "cam-pass" }] }] };

function newHub(extra: { onRobotDelta?: (d: any[]) => void; onStateChanged?: () => void } = {}) {
  const stored: unknown[] = [];
  const hub = mods.createWsHub({ setSettings: (payload) => { stored.push(payload); }, ...extra });
  return { hub, stored };
}

test("a settings write is stored, and an administrator hears the credentials of the cameras that an operator does not", () => {
  const { hub, stored } = newHub();
  const admin = fakeClient({ role: "admin" });
  const operator = fakeClient({ role: "operator" });
  const viewer = fakeClient({ role: "viewer" });
  const anonymous = fakeClient({ role: undefined });
  anonymous.client.meta = undefined;
  for (const c of [admin, operator, viewer, anonymous]) hub.wsClients.add(c.client);
  hub.broadcastSettings(CAMERA_TREE);
  assert.deepEqual(stored, [CAMERA_TREE]);
  assert.match(admin.sent[0], /cam-pass/);
  for (const c of [operator, viewer, anonymous]) {
    assert.equal(c.sent.length, 1);
    assert.doesNotMatch(c.sent[0], /cam-pass|cam-user/);
    assert.match(c.sent[0], /"name":"bench"/);
  }
  assert.deepEqual(JSON.parse(admin.sent[0]), { type: "settings", payload: CAMERA_TREE, schema: 1 });
});

test("a delta-only settings write says delta, skips the connection that made it and the connections that are not open", () => {
  const { hub } = newHub();
  const origin = fakeClient({ role: "admin" });
  const other = fakeClient({ role: "admin" });
  const closed = fakeClient({ role: "admin", open: false });
  for (const c of [origin, other, closed]) hub.wsClients.add(c.client);
  hub.broadcastSettings({ controllers: [] }, true, origin.client);
  assert.equal(origin.sent.length, 0, "no echo to the originator");
  assert.equal(closed.sent.length, 0, "nothing sent to a socket that is closing");
  assert.equal(JSON.parse(other.sent[0]).type, "delta");
});

test("a failing state-changed callback never breaks a settings write", () => {
  let calls = 0;
  const { hub } = newHub({ onStateChanged: () => { calls++; throw new Error("phone gateway down"); } });
  const c = fakeClient({ role: "admin" });
  hub.wsClients.add(c.client);
  assert.doesNotThrow(() => hub.broadcastSettings({ controllers: [] }));
  assert.equal(calls, 1);
  assert.equal(c.sent.length, 1);
});

test("a robot delta is a small patch for a schema 2 client and the whole tree, redacted for an operator, for a schema 1 client", () => {
  const seen: any[] = [];
  const { hub, stored } = newHub({ onRobotDelta: (d) => { seen.push(d); } });
  const modern = fakeClient({ role: "operator", schema: 2 });
  const legacyAdmin = fakeClient({ role: "admin", schema: 1 });
  const legacyOperator = fakeClient({ role: "operator", schema: 1 });
  const closed = fakeClient({ schema: 2, open: false });
  for (const c of [modern, legacyAdmin, legacyOperator, closed]) hub.wsClients.add(c.client);
  const deltas = [
    { controllerId: "c1", robotId: 1, patch: { speed: 5 } },
    { controllerId: "c1", robotId: 2, patch: { speed: 6 }, cameraId: 1, cameraPatch: { zoom: 2 } },
  ];
  hub.broadcastRobotDelta(deltas, CAMERA_TREE);
  assert.deepEqual(stored, [CAMERA_TREE]);
  assert.equal(modern.sent.length, 2, "one message per affected robot");
  assert.deepEqual(JSON.parse(modern.sent[0]), { type: "delta", schema: 2, controllerId: "c1", robotId: 1, patch: { speed: 5 } });
  assert.deepEqual(JSON.parse(modern.sent[1]), { type: "delta", schema: 2, controllerId: "c1", robotId: 2, patch: { speed: 6 }, cameraId: 1, cameraPatch: { zoom: 2 } });
  assert.equal(legacyAdmin.sent.length, 1);
  assert.match(legacyAdmin.sent[0], /cam-pass/);
  assert.equal(JSON.parse(legacyAdmin.sent[0]).schema, 1);
  assert.doesNotMatch(legacyOperator.sent[0], /cam-pass/);
  assert.equal(closed.sent.length, 0);
  assert.deepEqual(seen, [deltas]);
});

test("a failing telemetry callback or state-changed callback never breaks a robot command", () => {
  const order: string[] = [];
  const { hub } = newHub({
    onRobotDelta: () => { order.push("delta"); throw new Error("telemetry full"); },
    onStateChanged: () => { order.push("state"); throw new Error("phones gone"); },
  });
  const c = fakeClient({ schema: 2 });
  hub.wsClients.add(c.client);
  assert.doesNotThrow(() => hub.broadcastRobotDelta([{ controllerId: "c1", robotId: 1, patch: {} }], { controllers: [] }));
  assert.deepEqual(order, ["delta", "state"], "both ran although the first threw");
  assert.equal(c.sent.length, 1);
});

test("a delta without any affected robot sends nothing to a schema 2 client", () => {
  const { hub } = newHub();
  const modern = fakeClient({ schema: 2 });
  hub.wsClients.add(modern.client);
  hub.broadcastRobotDelta([], { controllers: [] });
  assert.equal(modern.sent.length, 0);
});

test("claims and command events only reach the clients that declared schema 2", () => {
  let states = 0;
  const { hub } = newHub({ onStateChanged: () => { states++; throw new Error("ignored"); } });
  const modern = fakeClient({ schema: 2 });
  const legacy = fakeClient({ schema: 1 });
  const closedModern = fakeClient({ schema: 2, open: false });
  for (const c of [modern, legacy, closedModern]) hub.wsClients.add(c.client);
  hub.broadcastClaims([{ robotId: 1, by: "oper" }]);
  assert.deepEqual(JSON.parse(modern.sent[0]), { type: "claims", schema: 2, claims: [{ robotId: 1, by: "oper" }] });
  assert.equal(states, 1, "a claim change tells the phones, and a fault there is swallowed");
  hub.broadcastCommandLifecycle({ commandId: "x", state: "accepted" });
  assert.deepEqual(JSON.parse(modern.sent[1]), { type: "command-lifecycle", schema: 2, event: { commandId: "x", state: "accepted" } });
  assert.equal(legacy.sent.length, 0);
  assert.equal(closedModern.sent.length, 0);
  assert.equal(states, 1, "a command event is not a state change");
});

test("the one stop state only reaches the clients that declared schema 2, and a closed client is skipped", () => {
  const { hub } = newHub();
  const modern = fakeClient({ schema: 2 });
  const legacy = fakeClient({ schema: 1 });
  const closedModern = fakeClient({ schema: 2, open: false });
  for (const c of [modern, legacy, closedModern]) hub.wsClients.add(c.client);
  hub.broadcastStopState({ schema: 1, state: "STOPPED", physical: "latched", software: "ready" });
  assert.deepEqual(JSON.parse(modern.sent[0]), { type: "stop-state", schema: 2, state: { schema: 1, state: "STOPPED", physical: "latched", software: "ready" } });
  assert.equal(legacy.sent.length, 0);
  assert.equal(closedModern.sent.length, 0);
});

// ---- the endpoint ---------------------------------------------------------------------------------------------------------------------------

function tokenFor(username: string, overrides: Record<string, unknown> = {}): string {
  const user = mods.users.findUser(username)!;
  return jwt.sign(
    { username, role: user.role, tokenVersion: mods.users.effectiveTokenVersion(user), id: mods.users.effectiveId(user), ...overrides },
    mods.JWT_SECRET,
    { expiresIn: "5m" },
  );
}

async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function withEndpoint(
  deps: { queryAllowed?: boolean | (() => boolean); adminWriteAllowed?: (address: string | undefined) => boolean; applied?: unknown[]; applyError?: Error; getSettings?: () => any },
  body: (ctx: { connect: (protocols?: string[], query?: string) => { socket: WebSocket; messages: string[]; closed: { code?: number } }; hub: ReturnType<typeof mods.createWsHub>; port: number }) => Promise<void>,
): Promise<void> {
  const server = http.createServer();
  const { hub } = newHub();
  const wss = mods.attachWebSocketServer(server, {
    wsClients: hub.wsClients,
    getSettings: deps.getSettings ?? (() => CAMERA_TREE),
    applySettingsUpdate: async (payload, originator) => {
      if (deps.applyError) throw deps.applyError;
      deps.applied?.push({ payload, viaSocket: Boolean(originator) });
    },
    WS_QUERY_TOKEN_ALLOWED: deps.queryAllowed ?? false,
    adminWriteAllowed: deps.adminWriteAllowed,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const sockets: WebSocket[] = [];
  const connect = (protocols?: string[], query = "") => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, protocols);
    const messages: string[] = [];
    const closed: { code?: number } = {};
    socket.on("message", (raw) => messages.push(raw.toString()));
    socket.on("close", (code) => { closed.code = code; });
    socket.on("error", () => { /* a refused handshake is checked through the close code */ });
    sockets.push(socket);
    return { socket, messages, closed };
  };
  try {
    await body({ connect, hub, port });
  } finally {
    for (const s of sockets) s.terminate();
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.close();
    server.closeAllConnections?.();
  }
}

test("a connection without any token hears an error and is closed with 1008", async () => {
  await withEndpoint({}, async ({ connect }) => {
    const c = connect();
    await until(() => c.closed.code !== undefined, "the close");
    assert.equal(c.closed.code, 1008);
    assert.match(c.messages[0], /No token provided/);
  });
});

test("a token in the address is refused unless the installation opted back in", async () => {
  const token = tokenFor("boss");
  await withEndpoint({ queryAllowed: false }, async ({ connect }) => {
    const c = connect(undefined, `?token=${token}`);
    await until(() => c.closed.code !== undefined, "the close");
    assert.equal(c.closed.code, 1008);
    assert.match(c.messages[0], /a token in the address is not accepted/);
  });
  let allowed = true;
  await withEndpoint({ queryAllowed: () => allowed }, async ({ connect, hub }) => {
    const c = connect(undefined, `?token=${token}`);
    await until(() => c.messages.length > 0, "the first push");
    assert.equal(JSON.parse(c.messages[0]).type, "settings");
    assert.equal(hub.wsClients.size, 1);
    allowed = false;
    const refused = connect(undefined, `?token=${token}`);
    await until(() => refused.closed.code !== undefined, "the second close");
    assert.equal(refused.closed.code, 1008, "the option is read at every connection");
  });
});

test("the subprotocol wins over a token in the address, and an empty or malformed one counts as no token", async () => {
  await withEndpoint({ queryAllowed: false }, async ({ connect }) => {
    const mixed = connect(["hydra.bearer", tokenFor("boss")], `?token=${tokenFor("oper")}`);
    await until(() => mixed.messages.length > 0, "the first push");
    assert.equal(JSON.parse(mixed.messages[0]).type, "settings");
    assert.match(mixed.messages[0], /cam-pass/, "the administrator's token, not the operator's, was used");
    const marker = connect(["hydra.bearer"]);
    await until(() => marker.closed.code !== undefined, "the close");
    assert.match(marker.messages[0], /No token provided/);
  });
});

test("a token that does not verify, and one signed with another secret, are refused", async () => {
  await withEndpoint({}, async ({ connect }) => {
    const garbage = connect(["hydra.bearer", "not.a.jwt"]);
    const foreign = connect(["hydra.bearer", jwt.sign({ username: "boss", tokenVersion: 1 }, "some-other-secret")]);
    const expired = connect(["hydra.bearer", jwt.sign({ username: "boss", tokenVersion: 1 }, mods.JWT_SECRET, { expiresIn: -10 })]);
    for (const c of [garbage, foreign, expired]) {
      await until(() => c.closed.code !== undefined, "the close");
      assert.equal(c.closed.code, 1008);
      assert.match(c.messages[0], /Invalid token/);
    }
  });
});

test("a valid signature is not enough: an unknown account, an old session generation and another identity are refused", async () => {
  await withEndpoint({}, async ({ connect, hub }) => {
    const ghost = connect(["hydra.bearer", jwt.sign({ username: "nobody", tokenVersion: 1, id: "nobody" }, mods.JWT_SECRET)]);
    const stale = connect(["hydra.bearer", tokenFor("boss", { tokenVersion: 999 })]);
    const impostor = connect(["hydra.bearer", tokenFor("boss", { id: "someone-else" })]);
    const noUsername = connect(["hydra.bearer", jwt.sign({ tokenVersion: 1 }, mods.JWT_SECRET)]);
    for (const c of [ghost, stale, impostor, noUsername]) {
      await until(() => c.closed.code !== undefined, "the close");
      assert.equal(c.closed.code, 1008);
      assert.match(c.messages[0], /no longer valid/);
    }
    assert.equal(hub.wsClients.size, 0, "none of them was ever registered");
  });
});

test("the first push is the whole tree for an administrator and the redacted tree for everyone else, and the client leaves the hub on closing", async () => {
  await withEndpoint({}, async ({ connect, hub }) => {
    const boss = connect(["hydra.bearer", tokenFor("boss")]);
    const oper = connect(["hydra.bearer", tokenFor("oper")]);
    const watcher = connect(["hydra.bearer", tokenFor("watcher")]);
    await until(() => [boss, oper, watcher].every((c) => c.messages.length > 0), "three first pushes");
    assert.match(boss.messages[0], /cam-pass/);
    assert.doesNotMatch(oper.messages[0], /cam-pass|cam-user/);
    assert.doesNotMatch(watcher.messages[0], /cam-pass|cam-user/);
    assert.equal(hub.wsClients.size, 3);
    const roles = [...hub.wsClients].map((c: any) => c.meta.role).sort();
    assert.deepEqual(roles, ["admin", "operator", "viewer"]);
    const sample: any = [...hub.wsClients][0];
    assert.equal(sample.meta.remoteAddress.includes("127.0.0.1"), true);
    assert.ok(!Number.isNaN(Date.parse(sample.meta.connectedAt)));
    oper.socket.close();
    await until(() => hub.wsClients.size === 2, "the client to leave");
  });
});

test("the role in the connection is the account's current one, not the token's stale claim", async () => {
  await withEndpoint({}, async ({ connect }) => {
    const claimsAdmin = connect(["hydra.bearer", tokenFor("oper", { role: "admin" })]);
    await until(() => claimsAdmin.messages.length > 0, "the first push");
    assert.doesNotMatch(claimsAdmin.messages[0], /cam-pass/, "an operator that claims to be an administrator still hears the redacted tree");
  });
});

test("the schema a client declares is read once at connection: 2 or more means 2, anything else means 1", async () => {
  await withEndpoint({}, async ({ connect, hub }) => {
    const token = tokenFor("boss");
    const want: Record<string, number> = { "?remoteApiVersion=2": 2, "?remoteApiVersion=7": 2, "?remoteApiVersion=1": 1, "?remoteApiVersion=abc": 1, "": 1, "?remoteApiVersion=": 1 };
    for (const [query, schema] of Object.entries(want)) {
      const before = hub.wsClients.size;
      const c = connect(["hydra.bearer", token], query);
      await until(() => hub.wsClients.size === before + 1 && c.messages.length > 0, `a connection for ${query || "no query"}`);
      const newest: any = [...hub.wsClients].at(-1);
      assert.equal(newest.schema, schema, query || "no query");
      assert.equal(newest.meta.remoteApiVersion, schema);
    }
    hub.broadcastClaims([]);
    const heard = [...hub.wsClients].filter((c: any) => c.schema === 2).length;
    assert.equal(heard, 2);
  });
});

test("only an administrator's settings message overwrites the settings, and a demotion takes effect on the next message", async () => {
  const applied: any[] = [];
  await withEndpoint({ applied }, async ({ connect }) => {
    const boss = connect(["hydra.bearer", tokenFor("boss")]);
    const oper = connect(["hydra.bearer", tokenFor("oper")]);
    const watcher = connect(["hydra.bearer", tokenFor("watcher")]);
    await until(() => [boss, oper, watcher].every((c) => c.messages.length > 0), "first pushes");
    boss.socket.send(JSON.stringify({ type: "settings", payload: { controllers: [{ id: "new" }] } }));
    await until(() => applied.length === 1, "the administrator's write");
    assert.deepEqual(applied[0], { payload: { controllers: [{ id: "new" }] }, viaSocket: true });
    for (const c of [oper, watcher]) {
      c.socket.send(JSON.stringify({ type: "settings", payload: { controllers: [] } }));
      await until(() => c.messages.length > 1, "the refusal");
      assert.match(c.messages[1], /admin privileges required/);
    }
    assert.equal(applied.length, 1);
    // a live lookup: the account that was an administrator when it connected is an operator now
    const demoted = await mods.users.createUser("temp-boss", "a-long-enough-password", "admin");
    assert.equal(demoted.ok, true);
    const temp = connect(["hydra.bearer", tokenFor("temp-boss")]);
    await until(() => temp.messages.length > 0, "temp first push");
    assert.deepEqual(await mods.users.updateUser("temp-boss", { role: "operator" } as any), { ok: true });
    temp.socket.send(JSON.stringify({ type: "settings", payload: { controllers: [] } }));
    await until(() => temp.messages.length > 1 || temp.closed.code !== undefined, "the answer to the demoted account");
    assert.equal(applied.length, 1, "the demoted account wrote nothing");
  });
});

test("messages that are not a settings write do nothing: wrong type, no payload, other JSON, not JSON", async () => {
  const applied: any[] = [];
  const logged = mock.method(console, "error", () => {});
  try {
    await withEndpoint({ applied }, async ({ connect }) => {
      const boss = connect(["hydra.bearer", tokenFor("boss")]);
      await until(() => boss.messages.length > 0, "the first push");
      for (const text of [JSON.stringify({ type: "ping" }), JSON.stringify({ type: "settings" }), JSON.stringify({ type: "settings", payload: null }), "null", "42", "[]", "{not json"]) {
        boss.socket.send(text);
      }
      await until(() => logged.mock.callCount() >= 1, "the malformed message to be logged");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(applied.length, 0);
      assert.equal(boss.closed.code, undefined, "the connection survived all of them");
      assert.equal(boss.messages.length, 1);
    });
  } finally {
    logged.mock.restore();
  }
});

test("the trusted networks keep the settings write for the house, and the check gets the address of the client", async () => {
  const applied: any[] = [];
  const asked: Array<string | undefined> = [];
  let inside = false;
  await withEndpoint({ applied, adminWriteAllowed: (address) => { asked.push(address); return inside; } }, async ({ connect }) => {
    const boss = connect(["hydra.bearer", tokenFor("boss")]);
    await until(() => boss.messages.length > 0, "the first push");
    boss.socket.send(JSON.stringify({ type: "settings", payload: { controllers: [] } }));
    await until(() => boss.messages.length > 1, "the refusal");
    const refusal = JSON.parse(boss.messages[1]);
    assert.equal(refusal.code, "remote-policy");
    assert.equal(refusal.needs, "vpn");
    assert.equal(applied.length, 0);
    inside = true;
    boss.socket.send(JSON.stringify({ type: "settings", payload: { controllers: [] } }));
    await until(() => applied.length === 1, "the write from the house");
    assert.ok(asked.length === 2 && asked.every((a) => typeof a === "string" && a.includes("127.0.0.1")), asked.join(","));
  });
});

test("a write that would duplicate a robot id is answered with the 409 body over the socket, and any other failure is only logged", async () => {
  const conflicts = [{ robotId: 3, controllers: ["c1", "c2"] }];
  await withEndpoint({ applyError: new mods.RobotIdDuplicatedError(conflicts) }, async ({ connect }) => {
    const boss = connect(["hydra.bearer", tokenFor("boss")]);
    await until(() => boss.messages.length > 0, "the first push");
    boss.socket.send(JSON.stringify({ type: "settings", payload: { controllers: [] } }));
    await until(() => boss.messages.length > 1, "the duplicated-id answer");
    const body = JSON.parse(boss.messages[1]);
    assert.equal(body.code, "robot_id_duplicated");
    assert.deepEqual(body.conflicts, conflicts);
    assert.match(body.error, /unique across all controllers/);
  });
  const logged = mock.method(console, "error", () => {});
  try {
    await withEndpoint({ applyError: new Error("disk full") }, async ({ connect }) => {
      const boss = connect(["hydra.bearer", tokenFor("boss")]);
      await until(() => boss.messages.length > 0, "the first push");
      boss.socket.send(JSON.stringify({ type: "settings", payload: { controllers: [] } }));
      await until(() => logged.mock.callCount() >= 1, "the failure to be logged");
      assert.equal(boss.messages.length, 1, "nothing leaks to the client");
    });
  } finally {
    logged.mock.restore();
  }
});

test("the heartbeat drops a socket that never answered, closes a revoked session and pings the others", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const server = http.createServer();
  const { hub } = newHub();
  const wss = mods.attachWebSocketServer(server, { wsClients: hub.wsClients, getSettings: () => ({}), applySettingsUpdate: async () => {}, WS_QUERY_TOKEN_ALLOWED: false });
  try {
    const boss = mods.users.findUser("boss")!;
    const leaver = mods.users.findUser("leaver")!;
    const calls: string[] = [];
    const make = (name: string, state: Record<string, unknown>) => {
      const client: any = {
        ...state,
        terminate: () => calls.push(`${name}:terminate`),
        close: (code: number, why: string) => calls.push(`${name}:close:${code}:${why}`),
        ping: () => calls.push(`${name}:ping`),
      };
      hub.wsClients.add(client);
      return client;
    };
    const dead = make("dead", { isAlive: false, meta: { username: "boss" } });
    const alive = make("alive", { isAlive: true, meta: { username: "boss" }, authTokenVersion: mods.users.effectiveTokenVersion(boss), authUserId: mods.users.effectiveId(boss) });
    const revoked = make("revoked", { isAlive: true, meta: { username: "leaver" }, authTokenVersion: mods.users.effectiveTokenVersion(leaver) + 5, authUserId: mods.users.effectiveId(leaver) });
    const wrongId = make("wrong-id", { isAlive: true, meta: { username: "leaver" }, authTokenVersion: mods.users.effectiveTokenVersion(leaver), authUserId: "other" });
    const gone = make("gone", { isAlive: true, meta: { username: "deleted-account" }, authTokenVersion: 1, authUserId: "x" });
    const anonymous = make("anonymous", { isAlive: true, meta: {} });
    mock.timers.tick(29999);
    assert.deepEqual(calls, [], "nothing happens before the interval");
    mock.timers.tick(1);
    assert.deepEqual(calls.sort(), [
      "alive:ping",
      "anonymous:ping",
      "dead:terminate",
      "gone:close:1008:Access denied: session revoked",
      "revoked:close:1008:Access denied: session revoked",
      "wrong-id:close:1008:Access denied: session revoked",
    ]);
    assert.equal(alive.isAlive, false, "waiting for the answer");
    assert.equal(anonymous.isAlive, false);
    assert.ok(hub.wsClients.has(alive) && hub.wsClients.has(anonymous));
    for (const out of [dead, revoked, wrongId, gone]) assert.equal(hub.wsClients.has(out), false);
    // the next tick: nobody answered, so the two that were pinged are dropped now
    calls.length = 0;
    mock.timers.tick(30000);
    assert.deepEqual(calls.sort(), ["alive:terminate", "anonymous:terminate"]);
    assert.equal(hub.wsClients.size, 0);
  } finally {
    mock.timers.reset();
    wss.close();
    server.close();
  }
});
