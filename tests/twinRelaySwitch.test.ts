import assert from "node:assert/strict";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, resolveTwinRelay, type SecurityFile } from "../src/securityConfig.ts";

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

test("the relay of the twin is off by default, only the exact word 1 turns it on from the environment, and the environment wins", () => {
  const { config } = makeConfig();
  assert.equal(config.twinRelayEnabled(), false);
  assert.deepEqual(config.snapshot().twinRelay.enabled, { value: false, source: "default" });
  assert.equal(makeConfig({ twinRelay: "1" }).config.twinRelayEnabled(), true);
  for (const word of ["true", "yes", "on", "0", ""]) assert.equal(makeConfig({ twinRelay: word }).config.twinRelayEnabled(), false, word);
  assert.deepEqual(resolveTwinRelay(undefined, { twinRelay: { enabled: true } }), { value: true, source: "config" });
  assert.equal(resolveTwinRelay("0", { twinRelay: { enabled: true } }).value, false);
});

test("an administrator can turn the relay of the twin on and off; it is logged, saved and locked by the environment", () => {
  const { config, logs, stored } = makeConfig();
  config.update({ twinRelay: { enabled: true } }, "root");
  assert.equal(config.twinRelayEnabled(), true);
  assert.deepEqual(stored().twinRelay, { enabled: true });
  assert.match(logs.at(-1)!, /relay of the live state of the twin.*on/);
  config.update({ twinRelay: { enabled: false } }, "root");
  assert.equal(config.twinRelayEnabled(), false);
  const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
  for (const value of ["yes", 1, null]) assert.throws(() => config.update({ twinRelay: { enabled: value } }, "root"), bad400);
  assert.throws(() => config.update({ twinRelay: [] }, "root"), bad400);
  assert.throws(() => makeConfig({ twinRelay: "1" }).config.update({ twinRelay: { enabled: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /TWIN_RELAY/.test(e.message));
});

test("saving another option keeps the switch of the twin relay", () => {
  const { config, stored } = makeConfig({}, { twinRelay: { enabled: true } });
  config.update({ ecosystemHealth: { enabled: true } }, "root");
  assert.deepEqual(stored().twinRelay, { enabled: true });
});
