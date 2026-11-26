// =============================================================================
// HYDRA-UMC-SERVER - tests/globalStopSigningSwitch.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The switch of the signed release of the global stop and its key: off by default, the key goes in and never comes out.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig.ts";

const KEY = "k".repeat(40);

function make(env: any = {}, initial: SecurityFile = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "stop-key-"));
  const keyFile = path.join(folder, "global-stop.key");
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, managedStopKeyFile: keyFile, log: (m) => logs.push(m) });
  return { config, logs, keyFile, folder, stored: () => stored };
}

const status = (code: number) => (e: unknown) => e instanceof SecurityConfigError && e.status === code;

test("off by default, and it cannot be turned on without a key", () => {
  const { config, keyFile } = make();
  assert.deepEqual(config.snapshot().safety.globalStopSigning, { value: false, source: "default", keyStored: false, external: false });
  assert.equal(config.globalStopKeyFile(), undefined);
  assert.throws(() => config.update({ safety: { signGlobalStop: true } }, "root"), status(400));
  assert.equal(fs.existsSync(keyFile), false);
});

test("a stored key is written for the owner only and never comes back: not in the answer, the saved settings or the log", () => {
  const { config, logs, keyFile, folder, stored } = make();
  const result = config.update({ safety: { globalStopKey: KEY, signGlobalStop: true } }, "root");
  assert.deepEqual(result.snapshot.safety.globalStopSigning, { value: true, source: "config", keyStored: true, external: false });
  assert.equal(config.globalStopKeyFile(), keyFile);
  assert.equal(fs.readFileSync(keyFile, "latin1"), `${KEY}\n`);
  if (process.platform !== "win32") assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(folder), ["global-stop.key"]);
  for (const text of [JSON.stringify(result), JSON.stringify(stored()), logs.join("\n")]) assert.equal(text.includes(KEY), false);
  assert.equal(JSON.stringify(result).includes(keyFile), false);
});

test("turning it off keeps the key; removing the key needs it off", () => {
  const { config, keyFile } = make();
  config.update({ safety: { globalStopKey: KEY, signGlobalStop: true } }, "root");
  assert.throws(() => config.update({ safety: { globalStopKey: null } }, "root"), status(400));
  config.update({ safety: { signGlobalStop: false } }, "root");
  assert.equal(config.globalStopKeyFile(), undefined);
  assert.equal(config.snapshot().safety.globalStopSigning.keyStored, true);
  config.update({ safety: { globalStopKey: null } }, "root");
  assert.equal(fs.existsSync(keyFile), false);
});

test("a bad key is refused without being repeated, and nothing is written when another part of the patch is refused", () => {
  const { config, keyFile } = make();
  for (const bad of ["short", "x".repeat(257), `${KEY} with space`, 5, {}]) {
    assert.throws(() => config.update({ safety: { globalStopKey: bad } }, "root"), (e: unknown) => status(400)(e) && !(e as Error).message.includes(KEY), String(bad));
  }
  assert.throws(() => config.update({ safety: { globalStopKey: KEY }, infoAuth: "yes" }, "root"), status(400));
  assert.equal(fs.existsSync(keyFile), false);
});

test("a key file named in the environment or the security file decides and cannot be changed here", () => {
  for (const [env, initial, source] of [[{ globalStopKeyFile: "/etc/stop.key" }, {}, "env"], [{}, { safety: { globalStopKeyFile: "/etc/stop.key" } }, "config"]] as const) {
    const { config, keyFile } = make(env, initial as SecurityFile);
    assert.deepEqual(config.snapshot().safety.globalStopSigning, { value: true, source, keyStored: false, external: true });
    assert.equal(config.globalStopKeyFile(), "/etc/stop.key");
    assert.throws(() => config.update({ safety: { globalStopKey: KEY } }, "root"), status(409));
    assert.throws(() => config.update({ safety: { signGlobalStop: false } }, "root"), status(409));
    assert.equal(fs.existsSync(keyFile), false);
  }
});
