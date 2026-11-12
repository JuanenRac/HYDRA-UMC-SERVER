// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the relay of the F-RAM erase and self-test of the kinematic brain
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// POST /api/hardware/fram/erase and /selftest are off by default (safety.framErase), administrators only, and an erase needs the word ERASE. The bridge is a
// stand-in here. The same file covers the two options of the safety block: framErase and the interval of the emergency stop watch.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { registerUpstreamRoutes, withFramCapability } from "../src/routes/upstreamRoutes.ts";
import { SecurityConfig, SecurityConfigError, resolveEstopWatchMs, resolveFramErase, validEstopWatchMs, type SecurityFile } from "../src/securityConfig.ts";

type Handler = (req: any, res: any) => Promise<unknown> | unknown;

async function setup(opts: { enabled?: boolean; bridgeStatus?: number; bridgeBody?: unknown; configured?: boolean; role?: string } = {}) {
  const { enabled = true, bridgeStatus = 200, configured = true, role = "admin" } = opts;
  const bridgeBody = opts.bridgeBody ?? { operation: "erase", status: "ok", ok: true, board_id: 0, value: 8192 };
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
      res.writeHead(bridgeStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(bridgeBody));
    });
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const events: any[] = [];
  const passUser: Handler = (req, _res, next?: any) => { req.user = { id: "u1", username: "root", role }; return next(); };
  const requireAdminFor: Handler = (req, res, next?: any) => (req.user?.role === "admin" ? next() : res.status(403).json({ error: "administrator required" }));
  registerUpstreamRoutes(app, {
    authenticate: passUser as any,
    requireAdmin: requireAdminFor as any,
    industrialLog: () => {},
    wsClients: [],
    DATALAKE_URL: "", DATALAKE_TIMEOUT_MS: 1000, CONNECTOR_HUB_URL: "", CONNECTOR_HUB_TIMEOUT_MS: 2000,
    SPI_BRIDGE_URL: configured ? `http://127.0.0.1:${(bridge.address() as any).port}` : "", SPI_BRIDGE_VERSION_TIMEOUT_MS: 1000, SPI_BRIDGE_FLASH_TIMEOUT_MS: 1000,
    framEraseEnabled: () => enabled,
    audit: { record: (event: any) => { events.push(event); return null as any; } },
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
  return { call, seen, events, routes, stop: () => new Promise<void>((resolve) => bridge.close(() => resolve())) };
}

const ERASE = "POST /api/hardware/fram/erase";
const SELFTEST = "POST /api/hardware/fram/selftest";

test("off by default: both routes answer 403, nothing leaves and the refusal is audited", async () => {
  const t = await setup({ enabled: false });
  try {
    for (const key of [ERASE, SELFTEST]) {
      const res = await t.call(key, { body: { confirm: "ERASE" }, ip: "10.0.0.5" });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.code, "FRAM_ERASE_DISABLED");
    }
    assert.equal(t.seen.length, 0);
    assert.deepEqual(t.events.map((e) => [e.type, e.outcome]), [["fram-erase", "refused"], ["fram-selftest", "refused"]]);
  } finally {
    await t.stop();
  }
});

test("only an administrator reaches the routes", async () => {
  const t = await setup({ role: "operator" });
  try {
    for (const key of [ERASE, SELFTEST]) assert.equal((await t.call(key, { body: { confirm: "ERASE" } })).statusCode, 403);
    assert.equal(t.seen.length, 0);
    assert.equal(t.events.length, 0);
  } finally {
    await t.stop();
  }
});

test("an erase needs the exact word ERASE before anything leaves", async () => {
  const t = await setup();
  try {
    for (const body of [undefined, {}, { confirm: true }, { confirm: "erase" }, { confirm: "ERASE " }, "ERASE"]) {
      const res = await t.call(ERASE, { body, ip: "10.0.0.5" });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, "CONFIRMATION_REQUIRED");
    }
    assert.equal(t.seen.length, 0);
    assert.ok(t.events.every((e) => e.outcome === "refused"));
  } finally {
    await t.stop();
  }
});

test("a confirmed erase goes to the bridge with the word and comes back as the bridge answered, audited with who asked", async () => {
  const t = await setup();
  try {
    const res = await t.call(ERASE, { body: { confirm: "ERASE" }, ip: "10.0.0.5" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { operation: "erase", status: "ok", ok: true, board_id: 0, value: 8192 });
    assert.deepEqual(t.seen, [{ method: "POST", url: "/fram/erase?confirm=ERASE" }]);
    assert.deepEqual([t.events[0].type, t.events[0].outcome, t.events[0].username, t.events[0].ip, t.events[0].detail.bridgeStatus], ["fram-erase", "ok", "root", "10.0.0.5", 200]);
  } finally {
    await t.stop();
  }
});

test("the self-test needs no word and goes to its own route of the bridge", async () => {
  const t = await setup({ bridgeBody: { operation: "selftest", status: "ok", ok: true, board_id: 0, value: 0 } });
  try {
    const res = await t.call(SELFTEST, { ip: "10.0.0.5" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(t.seen, [{ method: "POST", url: "/fram/selftest" }]);
    assert.equal(t.events[0].type, "fram-selftest");
  } finally {
    await t.stop();
  }
});

test("a refusal of the brain (disabled, no chip) is passed on as it is and audited as refused, not as done", async () => {
  const t = await setup({ bridgeBody: { operation: "erase", status: "disabled", ok: false, board_id: 0, value: 0 } });
  try {
    const res = await t.call(ERASE, { body: { confirm: "ERASE" } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "disabled");
    assert.equal(t.events[0].outcome, "refused");
    assert.equal(t.events[0].detail.status, "disabled");
  } finally {
    await t.stop();
  }
});

test("a refusal of the bridge keeps its status and body; a silent bridge is a 503", async () => {
  const off = await setup({ bridgeStatus: 403, bridgeBody: { error: "the F-RAM operations are switched off in this service" } });
  try {
    const res = await off.call(ERASE, { body: { confirm: "ERASE" } });
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /switched off/);
    assert.equal(off.events[0].outcome, "refused");
  } finally {
    await off.stop();
  }
  const busy = await setup({ bridgeStatus: 504, bridgeBody: { error: "the board did not answer" } });
  try {
    const res = await busy.call(SELFTEST);
    assert.equal(res.statusCode, 504);
    assert.equal(busy.events[0].outcome, "failed");
  } finally {
    await busy.stop();
  }
  const none = await setup({ configured: false });
  try {
    const res = await none.call(SELFTEST);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.available, false);
    assert.equal(none.events[0].outcome, "failed");
  } finally {
    await none.stop();
  }
});

test("a server built without the dependency keeps the routes off", async () => {
  const t = await setup();
  try {
    // framEraseEnabled absent: nothing is on
    const routes = t.routes;
    assert.ok(routes[ERASE] && routes[SELFTEST]);
  } finally {
    await t.stop();
  }
});

test("the capability the apps read is true only when the bridge offers it and this server does too", () => {
  const bridge = { online: true, capabilities: { fram_erase: true } };
  assert.deepEqual((withFramCapability(bridge, true) as any).capabilities, { fram_erase: true });
  assert.deepEqual((withFramCapability(bridge, false) as any).capabilities, { fram_erase: false });
  assert.deepEqual((withFramCapability({ online: true, capabilities: { fram_erase: false } }, true) as any).capabilities, { fram_erase: false });
  assert.deepEqual((withFramCapability({ online: true }, true) as any).capabilities, { fram_erase: false });
  assert.deepEqual((withFramCapability({ capabilities: { other: 1, fram_erase: true } }, true) as any).capabilities, { other: 1, fram_erase: true });
  assert.equal(withFramCapability(null, true), null);
  assert.deepEqual(withFramCapability([1], true), [1]);
});

// ---- the two options of the safety block ----------------------------------------------------------------------------------------------------------

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}
const status = (e: unknown, code: number) => e instanceof SecurityConfigError && e.status === code;

test("both options are off by default and the environment decides and locks them", () => {
  const { config } = makeConfig();
  assert.equal(config.framEraseEnabled(), false);
  assert.equal(config.estopWatchMs(), 0);
  assert.deepEqual(config.snapshot().safety.framErase, { value: false, source: "default" });
  assert.deepEqual(config.snapshot().safety.estopWatchMs, { value: 0, source: "default" });
  assert.equal(makeConfig({ framErase: "1" }).config.framEraseEnabled(), true);
  for (const word of ["true", "yes", "0", "on"]) assert.equal(makeConfig({ framErase: word }).config.framEraseEnabled(), false, word);
  assert.deepEqual(resolveFramErase("1", {}), { value: true, source: "env" });
  assert.equal(makeConfig({ estopWatch: "2000" }).config.estopWatchMs(), 2000);
  for (const word of ["499", "60001", "1e3", "-5", "abc"]) {
    const resolved = resolveEstopWatchMs(word, {});
    assert.deepEqual(resolved, { value: 0, source: "env" }, word);
  }
  assert.deepEqual(resolveEstopWatchMs("500", { safety: { estopWatchMs: 9000 } }), { value: 500, source: "env" });
});

test("the interval is 0 or a whole number from 500 to 60000", () => {
  for (const ok of [0, 500, 2000, 60000]) assert.equal(validEstopWatchMs(ok), true, String(ok));
  for (const bad of [-1, 1, 499, 60001, 1.5, NaN, "500", null, undefined]) assert.equal(validEstopWatchMs(bad), false, String(bad));
});

test("turning the erase on needs the confirmation, is saved, warned about and logged; turning it off needs none", () => {
  const { config, logs, stored } = makeConfig();
  assert.throws(() => config.update({ safety: { framErase: true } }, "root"), (e) => status(e, 400) && /confirm: true/.test((e as Error).message));
  assert.throws(() => config.update({ safety: { framErase: true, confirm: false } }, "root"), (e) => status(e, 400));
  assert.equal(config.framEraseEnabled(), false);
  const on = config.update({ safety: { framErase: true, confirm: true } }, "root");
  assert.ok(on.warnings.includes("fram_erase_on"));
  assert.equal(config.framEraseEnabled(), true);
  assert.deepEqual(stored().safety, { framErase: true });
  assert.match(logs.at(-1)!, /F-RAM erase of the brain is on/);
  config.update({ safety: { framErase: false } }, "root");
  assert.equal(config.framEraseEnabled(), false);
  assert.throws(() => config.update({ safety: { framErase: "yes" } }, "root"), (e) => status(e, 400));
});

test("the interval of the watch is validated, saved, applies on restart and is locked by the environment", () => {
  const { config, stored } = makeConfig();
  for (const bad of [100, 70000, "1000", 1.5, -2]) assert.throws(() => config.update({ safety: { estopWatchMs: bad } }, "root"), (e) => status(e, 400), String(bad));
  const set = config.update({ safety: { estopWatchMs: 1500 } }, "root");
  assert.equal(set.appliesOnRestart, true);
  assert.equal(config.estopWatchMs(), 1500);
  assert.deepEqual(stored().safety, { estopWatchMs: 1500 });
  config.update({ safety: { estopWatchMs: 0 } }, "root");
  assert.equal(config.estopWatchMs(), 0);
  const locked = makeConfig({ estopWatch: "3000", framErase: "1" });
  assert.throws(() => locked.config.update({ safety: { estopWatchMs: 1000 } }, "root"), (e) => status(e, 409) || status(e, 400) || status(e, 403));
  assert.throws(() => locked.config.update({ safety: { framErase: false } }, "root"), (e) => e instanceof SecurityConfigError);
  assert.equal(locked.config.estopWatchMs(), 3000);
});

test("the other option of the block still works next to the new ones", () => {
  const { config, stored } = makeConfig();
  config.update({ safety: { publishGlobalStop: true } }, "root");
  config.update({ safety: { estopWatchMs: 800 } }, "root");
  assert.deepEqual(stored().safety, { publishGlobalStop: true, estopWatchMs: 800 });
});
