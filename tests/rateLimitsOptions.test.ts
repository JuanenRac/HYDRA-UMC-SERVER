import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { RATE_LIMIT_BOUNDS, RATE_LIMIT_KEYS, SecurityConfig, SecurityConfigError, rateLimitSettings, securityEnvFrom, type SecurityFile } from "../src/securityConfig.ts";
import { apiRateLimiter, setRateLimitSettingsProvider, stopAllRateLimiter } from "../src/auth.ts";

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}
const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
const locked409 = (e: unknown) => e instanceof SecurityConfigError && e.status === 409;

test("the limiters start on and with the defaults the server always had", () => {
  const { config } = makeConfig();
  const snapshot = config.snapshot().rateLimits;
  assert.deepEqual(snapshot.enabled, { value: true, source: "default" });
  for (const key of RATE_LIMIT_KEYS) assert.deepEqual(snapshot[key], { value: RATE_LIMIT_BOUNDS[key].def, source: "default", min: RATE_LIMIT_BOUNDS[key].min, max: RATE_LIMIT_BOUNDS[key].max }, key);
  assert.deepEqual(
    [snapshot.loginMax.value, snapshot.loginWindowSeconds.value, snapshot.refreshMax.value, snapshot.apiMax.value, snapshot.sensitiveMax.value, snapshot.apiWindowSeconds.value, snapshot.stopAllMax.value, snapshot.stopAllWindowSeconds.value],
    [5, 900, 120, 600, 30, 60, 60, 60],
  );
  assert.equal(config.rateLimits().enabled, true);
  assert.equal(config.rateLimits().loginWindowMs, 900000);
});

test("the environment wins: the old variables keep their meaning (windows in milliseconds) and only off turns the switch off", () => {
  const env = securityEnvFrom({ HYDRA_UMC_RATE_LIMITS: "off", LOGIN_RATE_LIMIT_MAX: "7", LOGIN_RATE_LIMIT_WINDOW_MS: "120000", API_RATE_LIMIT_MAX: "5" } as any);
  const { config } = makeConfig(env);
  const s = config.snapshot().rateLimits;
  assert.deepEqual(s.enabled, { value: false, source: "env" });
  assert.equal(s.loginMax.value, 7);
  assert.equal(s.loginMax.source, "env");
  assert.equal(s.loginWindowSeconds.value, 120);
  // 5 is below the range of apiMax: the variable is ignored, not clamped
  assert.deepEqual([s.apiMax.value, s.apiMax.source], [600, "default"]);
  for (const word of ["on", "yes", "1", "x"]) assert.equal(makeConfig({ rateLimits: word }).config.rateLimits().enabled, true, word);
  for (const word of ["off", " OFF ", "false", "0", "no"]) assert.equal(makeConfig({ rateLimits: word }).config.rateLimits().enabled, false, word);
});

test("an administrator can change the switch and the numbers: saved, warned about, logged; closing it again warns of nothing", () => {
  const { config, logs, stored } = makeConfig();
  const off = config.update({ rateLimits: { enabled: false } }, "root");
  assert.deepEqual(off.warnings, ["rate_limits_off"]);
  assert.equal(config.rateLimits().enabled, false);
  assert.match(logs.at(-1)!, /request limits per address: OFF/);
  assert.deepEqual(stored().rateLimits, { enabled: false });
  assert.deepEqual(config.update({ rateLimits: { enabled: true, loginMax: 10, apiMax: 1200, stopAllWindowSeconds: 120 } }, "root").warnings, []);
  assert.deepEqual(stored().rateLimits, { enabled: true, loginMax: 10, apiMax: 1200, stopAllWindowSeconds: 120 });
  assert.match(logs.at(-1)!, /sign-in 10 failed per 900 s.*API 1200.*global stop 60 per 120 s/);
  const s = config.snapshot().rateLimits;
  assert.deepEqual([s.loginMax.value, s.loginMax.source, s.apiMax.value, s.stopAllWindowSeconds.value, s.sensitiveMax.source], [10, "config", 1200, 120, "default"]);
  const live = config.rateLimits();
  assert.deepEqual([live.loginMax, live.apiMax, live.stopAllWindowMs], [10, 1200, 120000]);
});

test("a very loose number raises a warning and a patch of the limits leaves the other options alone", () => {
  const { config } = makeConfig({}, { camera: { open: true } });
  assert.deepEqual(config.update({ rateLimits: { loginMax: 50 } }, "root").warnings, ["rate_limits_loose"]);
  assert.deepEqual(config.update({ rateLimits: { loginMax: 5, sensitiveMax: 400 } }, "root").warnings, ["rate_limits_loose"]);
  assert.deepEqual(config.update({ rateLimits: { sensitiveMax: 30 } }, "root").warnings, []);
  assert.deepEqual(config.snapshot().camera.open, { value: true, source: "config" });
});

test("the ranges are enforced on both ends and a bad value changes nothing", () => {
  const { config, stored } = makeConfig();
  for (const key of RATE_LIMIT_KEYS) {
    const { min, max } = RATE_LIMIT_BOUNDS[key];
    for (const value of [min - 1, max + 1, 0, -1, 1.5, "10", null, NaN, Infinity]) {
      assert.throws(() => config.update({ rateLimits: { [key]: value } }, "root"), bad400, `${key}=${String(value)}`);
    }
    assert.doesNotThrow(() => config.update({ rateLimits: { [key]: min } }, "root"), `${key} min`);
    assert.doesNotThrow(() => config.update({ rateLimits: { [key]: max } }, "root"), `${key} max`);
  }
  const before = JSON.stringify(stored());
  for (const bad of ["x", 1, null, ["a"]]) assert.throws(() => config.update({ rateLimits: bad }, "root"), bad400);
  for (const value of ["no", 0, null]) assert.throws(() => config.update({ rateLimits: { enabled: value } }, "root"), bad400);
  assert.throws(() => config.update({ rateLimits: { unknownLimit: 5 } }, "root"), bad400);
  assert.equal(JSON.stringify(stored()), before);
});

test("a value fixed by the environment cannot be changed from Server Admin", () => {
  const { config } = makeConfig(securityEnvFrom({ HYDRA_UMC_RATE_LIMITS: "on", API_RATE_LIMIT_MAX: "900" } as any));
  assert.throws(() => config.update({ rateLimits: { enabled: false } }, "root"), locked409);
  assert.throws(() => config.update({ rateLimits: { apiMax: 700 } }, "root"), locked409);
  assert.doesNotThrow(() => config.update({ rateLimits: { loginMax: 8 } }, "root"));
});

test("a saved file is read back, and a damaged number in it falls back to the default", () => {
  const { config } = makeConfig({}, { rateLimits: { enabled: false, loginMax: 12, apiMax: 3 as number, refreshMax: 1.5 as number } });
  const s = config.snapshot().rateLimits;
  assert.deepEqual(s.enabled, { value: false, source: "config" });
  assert.deepEqual([s.loginMax.value, s.loginMax.source], [12, "config"]);
  assert.deepEqual([s.apiMax.value, s.apiMax.source, s.refreshMax.value, s.refreshMax.source], [600, "default", 120, "default"]);
  assert.equal(rateLimitSettings({}, {}).enabled, true);
});

async function withApp(run: (call: (path: string) => Promise<number>) => Promise<void>) {
  const app = express();
  app.get("/api", apiRateLimiter, (_req, res) => { res.json({ ok: true }); });
  app.post("/stop", stopAllRateLimiter, (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(async (path) => (await fetch(`http://127.0.0.1:${port}${path}`, { method: path === "/stop" ? "POST" : "GET" })).status);
  } finally {
    setRateLimitSettingsProvider(null);
    server.close();
    server.closeAllConnections();
  }
}

test("the limiters follow the configuration live: a lower number limits at once and the switch turns them off", async () => {
  const { config } = makeConfig();
  setRateLimitSettingsProvider(() => config.rateLimits());
  await withApp(async (call) => {
    for (let i = 0; i < 5; i++) assert.equal(await call("/api"), 200);
    config.update({ rateLimits: { apiMax: RATE_LIMIT_BOUNDS.apiMax.min } }, "root");
    // the budget of the new number starts fresh: 60 pass, the next is refused with 429
    let refusedAt = -1;
    for (let i = 0; i < 70; i++) if ((await call("/api")) === 429) { refusedAt = i; break; }
    assert.equal(refusedAt, 60);
    config.update({ rateLimits: { enabled: false } }, "root");
    for (let i = 0; i < 5; i++) assert.equal(await call("/api"), 200);
    config.update({ rateLimits: { enabled: true } }, "root");
    assert.equal(await call("/api"), 429);
    config.update({ rateLimits: { apiMax: 100000 } }, "root");
    assert.equal(await call("/api"), 200);
  });
});
