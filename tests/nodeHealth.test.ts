import assert from "node:assert/strict";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig";
import { bridgeNodeHealthFetcher, parseNodeHealth, parseSlot, type NodeHealth } from "../src/nodeHealth";
import { makeNodeHealthGate, registerNodeHealthRoutes } from "../src/routes/nodeHealthRoutes";

// The health of the controller boards as the brain heard it, read from the SPI bridge: the shape, the fetch, the route behind its switch and the switch itself.

const HEARD = { online: true, slot: 2, heard: true, age_ms: 2500, sequence: 7, flags: 17, flag_names: ["estop_latched", "application_confirmed"], tx_errors: 1, rx_errors: 2, stalls: 0, uptime_s: 48, source: "brain-health", extra: "dropped" };

test("an answer of the bridge is passed on in a fixed shape, and a damaged one is not", () => {
  assert.deepEqual(parseNodeHealth(HEARD, 2), {
    online: true, slot: 2, heard: true, ageMs: 2500, sequence: 7, flags: 17, flagNames: ["estop_latched", "application_confirmed"], txErrors: 1, rxErrors: 2, stalls: 0, uptimeS: 48, source: "brain-health",
  });
  assert.deepEqual(parseNodeHealth({ online: true, slot: 5, heard: false, age_ms: null }, 5), { online: true, slot: 5, heard: false, source: "brain-health" });
  assert.deepEqual(parseNodeHealth({ online: false, slot: 3, heard: null }, 3), { online: false, slot: 3, heard: null, source: "brain-health" });
  for (const bad of [null, 5, "x", {}, { online: "yes" }, { ...HEARD, slot: 3 }, { ...HEARD, heard: "maybe" }, { ...HEARD, age_ms: -1 }, { ...HEARD, age_ms: 25_401 }, { ...HEARD, sequence: 256 },
    { ...HEARD, flags: 1.5 }, { ...HEARD, flag_names: "x" }, { ...HEARD, flag_names: [1] }, { ...HEARD, uptime_s: 4081 }, { ...HEARD, tx_errors: undefined }]) {
    assert.equal(parseNodeHealth(bad, 2), null, JSON.stringify(bad));
  }
});

test("the slot of a request is a single digit from 0 to 7", () => {
  for (const good of ["0", "3", "7"]) assert.equal(parseSlot(good), Number(good));
  for (const bad of ["8", "9", "-1", "", "01", "1.5", "a", undefined, 3, ["1"], null]) assert.equal(parseSlot(bad), null, String(bad));
});

test("the fetch asks the bridge for the slot with the identity headers and gives null on any failure", async () => {
  const calls: { url: string; headers: unknown }[] = [];
  const ok = bridgeNodeHealthFetcher("http://127.0.0.1:8765/", () => ({ "X-Test": "1" }), 500, (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers });
    return { ok: true, json: async () => HEARD };
  }) as any);
  assert.equal((await ok(2))?.sequence, 7);
  assert.equal(calls[0].url, "http://127.0.0.1:8765/node-health?slot=2");
  assert.deepEqual(calls[0].headers, { "X-Test": "1" });
  assert.equal(await bridgeNodeHealthFetcher("", () => ({}), 500)(2), null, "no address");
  assert.equal(await bridgeNodeHealthFetcher("http://x", () => ({}), 500, (async () => ({ ok: false, json: async () => ({}) })) as any)(2), null, "a refusal");
  assert.equal(await bridgeNodeHealthFetcher("http://x", () => ({}), 500, (async () => { throw new Error("down"); }) as any)(2), null, "a failure");
  assert.equal(await bridgeNodeHealthFetcher("http://x", () => ({}), 500, (async () => ({ ok: true, json: async () => ({ online: true, slot: 9 }) })) as any)(2), null, "another slot");
});

function harness(enabled: boolean, answer: NodeHealth | null) {
  let handlers: ((req: any, res: any, next: any) => unknown)[] = [];
  const app: any = { get: (_path: string, ...list: any[]) => { handlers = list; } };
  registerNodeHealthRoutes(app, {
    authenticate: (_req, _res, next) => next(),
    requireOperator: (_req, _res, next) => next(),
    nodeHealthGate: makeNodeHealthGate(() => enabled),
    fetchSlot: async () => answer,
  });
  return async (query: unknown) => {
    const out: { status: number; body: unknown } = { status: 200, body: undefined };
    const res: any = { status(code: number) { out.status = code; return res; }, json(body: unknown) { out.body = body; return res; }, end() { return res; } };
    let index = 0;
    const next = async (): Promise<void> => { const handler = handlers[index++]; if (handler) await handler({ query: { slot: query } }, res, next); };
    await next();
    return out;
  };
}

test("the route is off (404) unless the switch is on, refuses a wrong slot (400), says 503 when the bridge is silent and otherwise answers", async () => {
  const health = parseNodeHealth(HEARD, 2)!;
  assert.deepEqual(await harness(false, health)("2"), { status: 404, body: undefined });
  assert.equal((await harness(true, health)("8")).status, 400);
  assert.equal((await harness(true, health)(undefined)).status, 400);
  assert.equal((await harness(true, null)("2")).status, 503);
  assert.deepEqual(await harness(true, health)("2"), { status: 200, body: health });
});

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false });
  return { config, stored: () => stored };
}

test("the switch is off by default, only the exact word 1 in the environment turns it on and locks it, and an administrator can set it", () => {
  const { config, stored } = makeConfig();
  assert.deepEqual(config.snapshot().nodeHealth.enabled, { value: false, source: "default" });
  assert.equal(config.nodeHealthEnabled(), false);
  for (const word of ["true", "yes", "0", ""]) assert.equal(makeConfig({ nodeHealth: word }).config.nodeHealthEnabled(), false, word);
  const locked = makeConfig({ nodeHealth: "1" });
  assert.deepEqual(locked.config.snapshot().nodeHealth.enabled, { value: true, source: "env" });
  assert.throws(() => locked.config.update({ nodeHealth: { enabled: false } }, "root"), (error: unknown) => error instanceof SecurityConfigError && error.status === 409 && /HYDRA_UMC_NODE_HEALTH/.test(error.message));
  const result = config.update({ nodeHealth: { enabled: true } }, "root");
  assert.deepEqual(result.snapshot.nodeHealth.enabled, { value: true, source: "config" });
  assert.equal(config.nodeHealthEnabled(), true);
  assert.equal(stored().nodeHealth?.enabled, true);
  assert.throws(() => config.update({ nodeHealth: { enabled: "yes" } } as any, "root"), (error: unknown) => error instanceof SecurityConfigError && error.status === 400);
  assert.throws(() => config.update({ nodeHealth: [] } as any, "root"), (error: unknown) => error instanceof SecurityConfigError && error.status === 400);
});
