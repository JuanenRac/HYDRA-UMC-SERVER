// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the guards of the firmware flash and of the connection test
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// POST /api/hardware/canota/flash: with production.requireSignedFlash on, an image that does not say what it is (signature, target board, minimum
// bootloader) is refused before anything is sent; whatever the option, a flash waits while a robot is playing. POST /api/integrations/test-connection
// is for administrators and goes through the limiter of the sensitive routes. The spi_bridge is a stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { registerUpstreamRoutes } from "../src/routes/upstreamRoutes.ts";
import { anyRobotMovingOf } from "../src/atcReset.ts";
import { SecurityConfig, SecurityConfigError, resolveProductionRequireSignedFlash, type SecurityFile } from "../src/securityConfig.ts";

type Handler = (req: any, res: any, next?: any) => Promise<unknown> | unknown;

const SIGNATURE = "ab".repeat(64);
const GOOD_QUERY = { tier: "1", slot: "0", signature: SIGNATURE, target: "main-board", min_bootloader: "1.2.0" };

async function setup(opts: { required?: boolean; moving?: boolean; role?: string; limiter?: Handler } = {}) {
  const { required = false, moving = false, role = "admin" } = opts;
  const routes: Record<string, Handler[]> = {};
  const app: any = {
    get(path: string, ...handlers: Handler[]) { routes[`GET ${path}`] = handlers; },
    post(path: string, ...handlers: Handler[]) { routes[`POST ${path}`] = handlers; },
    put() {}, delete() {}, patch() {},
  };
  const seen: { method?: string; url?: string }[] = [];
  const bridge = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url });
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(JSON.stringify({ phase: "done", percent: 100 }) + "\n");
    });
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const passUser: Handler = (req, _res, next) => { req.user = { id: "u1", username: "root", role }; return next(); };
  const requireAdminFor: Handler = (req, res, next) => (req.user?.role === "admin" ? next() : res.status(403).json({ error: "administrator required" }));
  registerUpstreamRoutes(app, {
    authenticate: passUser as any,
    requireAdmin: requireAdminFor as any,
    industrialLog: () => {},
    wsClients: [],
    DATALAKE_URL: "", DATALAKE_TIMEOUT_MS: 1000, CONNECTOR_HUB_URL: "", CONNECTOR_HUB_TIMEOUT_MS: 2000,
    SPI_BRIDGE_URL: `http://127.0.0.1:${(bridge.address() as any).port}`, SPI_BRIDGE_VERSION_TIMEOUT_MS: 1000, SPI_BRIDGE_FLASH_TIMEOUT_MS: 1000,
    requireSignedFlash: () => required,
    anyRobotMoving: () => moving,
    ...(opts.limiter ? { sensitiveRateLimiter: opts.limiter as any } : {}),
  } as any);
  const call = async (key: string, req: any = {}) => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.body = undefined;
    const done = new Promise<void>((resolve) => { res.once("finish", resolve); });
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; queueMicrotask(() => res.emit("finish")); return res; };
    const handlers = routes[key];
    assert.ok(handlers, `route ${key} is registered`);
    const run = async (index: number): Promise<unknown> => (index >= handlers.length ? undefined : handlers[index](req, res, () => run(index + 1)));
    await run(0);
    await done;
    return res;
  };
  return { call, seen, stop: () => new Promise<void>((resolve) => bridge.close(() => resolve())) };
}

const FLASH = "POST /api/hardware/canota/flash";
// `_body: true` makes the body parser of the route step aside: the image is already there
const flashRequest = (query: Record<string, string>) => ({ query, body: Buffer.from([1, 2, 3, 4]), _body: true, headers: {} });

test("by default a flash that carries none of the signing fields still goes on, as before", async () => {
  const t = await setup();
  try {
    const res = await t.call(FLASH, flashRequest({ tier: "1", slot: "0" }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(t.seen.length, 1);
  } finally {
    await t.stop();
  }
});

test("with the option on, a flash missing the signature, the target or the minimum bootloader is refused before anything is sent", async () => {
  const t = await setup({ required: true });
  try {
    for (const missing of ["signature", "target", "min_bootloader"]) {
      const query: Record<string, string> = { ...GOOD_QUERY };
      delete query[missing];
      const res = await t.call(FLASH, flashRequest(query));
      assert.equal(res.statusCode, 400, missing);
      assert.equal(res.body.code, "flash-signature-required");
      assert.deepEqual(res.body.missing, [missing]);
    }
    const none = await t.call(FLASH, flashRequest({ tier: "1", slot: "0" }));
    assert.deepEqual(none.body.missing, ["signature", "target", "min_bootloader"]);
    assert.equal(t.seen.length, 0, "nothing left this server");
    // a malformed field is still the old refusal, whatever the option
    assert.equal((await t.call(FLASH, flashRequest({ ...GOOD_QUERY, signature: "zz" }))).body.code, "invalid-flash-signature");
    const ok = await t.call(FLASH, flashRequest(GOOD_QUERY));
    assert.equal(ok.statusCode, 200);
    assert.equal(t.seen.length, 1);
    assert.match(t.seen[0].url!, /signature=ab/);
    assert.match(t.seen[0].url!, /target=main-board/);
  } finally {
    await t.stop();
  }
});

test("a flash waits while a robot is playing or paused, with the option on or off, and nothing is sent", async () => {
  for (const required of [false, true]) {
    const t = await setup({ required, moving: true });
    try {
      const res = await t.call(FLASH, flashRequest(GOOD_QUERY));
      assert.equal(res.statusCode, 409, `required=${required}`);
      assert.equal(res.body.code, "flash-robots-moving");
      assert.equal(t.seen.length, 0);
    } finally {
      await t.stop();
    }
  }
});

test("anyRobotMovingOf reads the playback of every robot of every controller", () => {
  const tree = (playbackState?: any) => ({ controllers: [{ robots: [{ id: 1 }, { id: 2, playbackState }] }, { robots: [] }] });
  assert.equal(anyRobotMovingOf(() => tree())(), false);
  assert.equal(anyRobotMovingOf(() => tree({ isPlaying: false, isPaused: false }))(), false);
  for (const state of [{ isPlaying: true }, { playing: true }, { isPaused: true }, { paused: true }]) assert.equal(anyRobotMovingOf(() => tree(state))(), true, JSON.stringify(state));
  assert.equal(anyRobotMovingOf(() => ({}))(), false);
  assert.equal(anyRobotMovingOf(() => undefined)(), false);
});

test("the connection test is for administrators and goes through the limiter first", async () => {
  const order: string[] = [];
  const limiter: Handler = (_req, _res, next) => { order.push("limiter"); return next(); };
  const operator = await setup({ role: "operator", limiter });
  try {
    const refused = await operator.call("POST /api/integrations/test-connection", { body: { host: "127.0.0.1", port: 1 } });
    assert.equal(refused.statusCode, 403);
    assert.deepEqual(order, ["limiter"], "the limiter runs before the sign-in check");
  } finally {
    await operator.stop();
  }
  const admin = await setup({ role: "admin" });
  try {
    const bad = await admin.call("POST /api/integrations/test-connection", { body: { host: "not a host", port: 1 } });
    assert.equal(bad.statusCode, 400);
  } finally {
    await admin.stop();
  }
  // a limiter that says no stops the request before anything else
  const blocked = await setup({ role: "admin", limiter: ((_req: any, res: any) => res.status(429).json({ error: "slow down" })) as Handler });
  try {
    assert.equal((await blocked.call("POST /api/integrations/test-connection", { body: { host: "127.0.0.1", port: 1 } })).statusCode, 429);
  } finally {
    await blocked.stop();
  }
});

function makeConfig(env: Record<string, string | undefined> = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

test("the option is off by default and only the words 0 and 1 count in the environment", () => {
  const { config } = makeConfig();
  assert.equal(config.productionRequireSignedFlash(), false);
  assert.deepEqual(config.snapshot().production.requireSignedFlash, { value: false, source: "default" });
  assert.deepEqual(makeConfig({ productionRequireSignedFlash: "1" }).config.snapshot().production.requireSignedFlash, { value: true, source: "env" });
  assert.deepEqual(makeConfig({ productionRequireSignedFlash: "0" }, { production: { requireSignedFlash: true } }).config.snapshot().production.requireSignedFlash, { value: false, source: "env" });
  for (const word of ["2", "true", "yes", "on", ""]) assert.equal(makeConfig({ productionRequireSignedFlash: word }).config.productionRequireSignedFlash(), false, word);
  assert.equal(resolveProductionRequireSignedFlash(undefined, { production: { requireSignedFlash: true } }).value, true);
});

test("an administrator can turn the option on and off, it is logged and saved next to the other production setting, and the environment locks it", () => {
  const { config, logs, stored } = makeConfig();
  config.update({ production: { rdpLevel: 1 } }, "root");
  config.update({ production: { requireSignedFlash: true } }, "root");
  assert.equal(config.productionRequireSignedFlash(), true);
  assert.deepEqual(stored().production, { rdpLevel: 1, requireSignedFlash: true });
  assert.match(logs.at(-1)!, /now requires a signature/);
  config.update({ production: { requireSignedFlash: false } }, "root");
  assert.equal(config.productionRequireSignedFlash(), false);
  assert.match(logs.at(-1)!, /no longer requires/);
  for (const bad of [{ requireSignedFlash: "1" }, { requireSignedFlash: 1 }, { requireSignedFlash: null }]) {
    assert.throws(() => config.update({ production: bad }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 400);
  }
  const fixed = makeConfig({ productionRequireSignedFlash: "1" }).config;
  assert.throws(() => fixed.update({ production: { requireSignedFlash: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /REQUIRE_SIGNED_FLASH/.test(e.message));
});
