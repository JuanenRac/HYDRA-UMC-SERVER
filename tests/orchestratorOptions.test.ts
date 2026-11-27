// =============================================================================
// HYDRA-UMC-SERVER - tests/orchestratorOptions.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig.ts";
import { readRetryServer, writeRetryServer } from "../src/orchestratorConfigFile.ts";

const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orch-options-")), "orchestrator.json");

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: () => {} });
  return { config, stored: () => stored };
}

const refused = (action: () => unknown, status: number) => assert.throws(action, (error: unknown) => error instanceof SecurityConfigError && error.status === status);

test("the retry of the global stop is on by default and cannot be changed without the file of the orchestrator", () => {
  const { config } = makeConfig();
  assert.deepEqual(config.snapshot().orchestrator, { retryServer: { value: true, source: "default" }, editable: false });
  refused(() => config.update({ orchestrator: { retryServer: false } }, "root"), 409);
  refused(() => config.update({ orchestrator: { configFile: "/etc/passwd" } }, "root"), 400);
  refused(() => config.update({ orchestrator: { retryServer: "no" } }, "root"), 400);
});

test("switching it off writes only that key, warns, and applies on a restart", () => {
  const file = temp();
  fs.writeFileSync(file, JSON.stringify({ estop: { retry_max_seconds: 60 }, metrics: { enabled: true } }));
  const { config, stored } = makeConfig({ orchestratorConfig: file });
  const result = config.update({ orchestrator: { retryServer: false } }, "root");
  assert.deepEqual(result.snapshot.orchestrator.retryServer, { value: false, source: "config" });
  assert.equal(result.appliesOnRestart, true);
  assert.ok(result.warnings.includes("orchestrator_stop_retry_off"));
  assert.equal(stored().orchestrator?.retryServer, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { estop: { retry_max_seconds: 60, retry_server: false }, metrics: { enabled: true } });
});

test("a file that is not a JSON object is never overwritten", () => {
  const file = temp();
  fs.writeFileSync(file, "[1]");
  assert.throws(() => writeRetryServer(file, true));
  assert.throws(() => readRetryServer(file));
  const { config } = makeConfig({ orchestratorConfig: file });
  assert.equal(config.snapshot().orchestrator.editable, false);
  refused(() => config.update({ orchestrator: { retryServer: false } }, "root"), 409);
  assert.equal(fs.readFileSync(file, "utf-8"), "[1]");
});
