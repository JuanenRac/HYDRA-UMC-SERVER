// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the settings channel of the connector hub gate
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// GET and POST /api/connector-hub/gate/settings carry the administrator's own token to the hub (a stand-in here), check the shape of the
// request and the confirmation before anything leaves, and write the attempt and its outcome to the audit record.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { registerUpstreamRoutes } from "../src/routes/upstreamRoutes.ts";

type Handler = (req: any, res: any) => Promise<unknown> | unknown;

async function setup(hubStatus = 200, role = "admin") {
  const routes: Record<string, Handler[]> = {};
  const app: any = {
    get(path: string, ...handlers: Handler[]) { routes[`GET ${path}`] = handlers; },
    post(path: string, ...handlers: Handler[]) { routes[`POST ${path}`] = handlers; },
    put() {}, delete() {}, patch() {},
  };
  const seen: { method?: string; url?: string; authorization?: string; body?: string }[] = [];
  const hub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      res.writeHead(hubStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ allowLoopbackNoIdentity: false, changed: false }));
    });
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const events: any[] = [];
  const passAdmin: Handler = (req, _res, next?: any) => { req.user = { id: "u1", username: "root", role }; return next(); };
  const requireAdminFor = (): Handler => (req, res, next?: any) => {
    if (req.user?.role === "admin") return next();
    return res.status(403).json({ error: "administrator required" });
  };
  registerUpstreamRoutes(app, {
    authenticate: passAdmin as any,
    requireAdmin: requireAdminFor() as any,
    industrialLog: () => {},
    wsClients: [],
    DATALAKE_URL: "", DATALAKE_TIMEOUT_MS: 1000, CONNECTOR_HUB_URL: "", CONNECTOR_HUB_TIMEOUT_MS: 2000,
    SPI_BRIDGE_URL: "", SPI_BRIDGE_VERSION_TIMEOUT_MS: 1000, SPI_BRIDGE_FLASH_TIMEOUT_MS: 1000,
    CONNECTOR_HUB_GATE_URL: (hub.address() as any) ? `http://127.0.0.1:${(hub.address() as any).port}` : "",
    audit: { record: (event: any) => { events.push(event); return null as any; } },
  } as any);
  const call = async (key: string, req: any) => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.body = undefined;
    const done = new Promise<void>((resolve) => { res.once("finish", resolve); });
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; queueMicrotask(() => res.emit("finish")); return res; };
    const handlers = routes[key];
    assert.ok(handlers, `route ${key} is registered`);
    const chain = [...handlers];
    const run = async (index: number): Promise<unknown> => {
      if (index >= chain.length) return undefined;
      return chain[index](req, res, () => run(index + 1));
    };
    await run(0);
    await done;
    await new Promise((resolve) => setImmediate(resolve));
    return res;
  };
  const stop = () => new Promise<void>((resolve) => hub.close(() => resolve()));
  return { call, seen, events, stop };
}

const SETTINGS = "/api/connector-hub/gate/settings";
const bearer = { authorization: "Bearer admin-token-value" };

test("reading the settings carries the token of the caller to the hub", async () => {
  const t = await setup();
  try {
    const res = await t.call(`GET ${SETTINGS}`, { headers: bearer, ip: "10.0.0.5" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(t.seen.map((s) => [s.method, s.url, s.authorization]), [["GET", "/gate/settings", "Bearer admin-token-value"]]);
  } finally {
    await t.stop();
  }
});

test("a body of the wrong shape never leaves this server and is audited as refused", async () => {
  const t = await setup();
  try {
    for (const body of [undefined, [], {}, { allowLoopbackNoIdentity: "yes" }, { allowLoopbackNoIdentity: false, other: 1 }]) {
      const res = await t.call(`POST ${SETTINGS}`, { headers: bearer, body, ip: "10.0.0.5" });
      assert.equal(res.statusCode, 400);
    }
    assert.equal(t.seen.length, 0);
    assert.ok(t.events.length === 5 && t.events.every((e) => e.type === "connector-hub-gate-settings" && e.outcome === "refused"));
  } finally {
    await t.stop();
  }
});

test("turning the switch on needs a confirmation before anything leaves", async () => {
  const t = await setup();
  try {
    const res = await t.call(`POST ${SETTINGS}`, { headers: bearer, body: { allowLoopbackNoIdentity: true }, ip: "10.0.0.5" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "CONFIRMATION_REQUIRED");
    assert.equal(t.seen.length, 0);
    assert.equal(t.events[0].outcome, "refused");
    assert.equal(t.events[0].detail.allowLoopbackNoIdentity, true);
  } finally {
    await t.stop();
  }
});

test("a confirmed change goes to the hub with the same token and is audited with who asked", async () => {
  const t = await setup();
  try {
    const res = await t.call(`POST ${SETTINGS}`, { headers: bearer, body: { allowLoopbackNoIdentity: true, confirm: true }, ip: "10.0.0.5" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(t.seen.map((s) => [s.method, s.url, s.authorization]), [["POST", "/gate/settings", "Bearer admin-token-value"]]);
    assert.deepEqual(JSON.parse(t.seen[0].body!), { allowLoopbackNoIdentity: true, confirm: true });
    assert.equal(t.events.length, 1);
    assert.deepEqual(
      [t.events[0].type, t.events[0].outcome, t.events[0].username, t.events[0].ip, t.events[0].detail.allowLoopbackNoIdentity, t.events[0].detail.hubStatus],
      ["connector-hub-gate-settings", "ok", "root", "10.0.0.5", true, 200],
    );
  } finally {
    await t.stop();
  }
});

test("a refusal of the hub is passed on and audited as refused, not as a change", async () => {
  const t = await setup(409);
  try {
    const res = await t.call(`POST ${SETTINGS}`, { headers: bearer, body: { allowLoopbackNoIdentity: false }, ip: "10.0.0.5" });
    assert.equal(res.statusCode, 409);
    assert.equal(t.events[0].outcome, "refused");
    assert.equal(t.events[0].detail.hubStatus, 409);
  } finally {
    await t.stop();
  }
});

test("only an administrator reaches the change", async () => {
  const t = await setup(200, "viewer");
  try {
    const res = await t.call(`POST ${SETTINGS}`, { headers: bearer, body: { allowLoopbackNoIdentity: false }, ip: "10.0.0.5" });
    assert.equal(res.statusCode, 403);
    assert.equal(t.seen.length, 0);
    assert.equal(t.events.length, 0);
    // reading is open to any signed-in account
    assert.equal((await t.call(`GET ${SETTINGS}`, { headers: bearer, ip: "10.0.0.5" })).statusCode, 200);
  } finally {
    await t.stop();
  }
});
