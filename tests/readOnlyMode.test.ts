// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for src/readOnlyMode.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Read-only mode: off unless asked for, nothing that writes gets through except STOP and the safe-mode disable, and a refused request is told why.
import test from "node:test";
import assert from "node:assert/strict";
import { READ_ONLY_REFUSAL, makeReadOnlyGate, readOnlyAllows, readOnlyEnabled } from "../src/readOnlyMode";

test("readOnlyEnabled: off by default, on only for a plain yes", () => {
  for (const value of [undefined, "", "0", "off", "no", "2", "enable", "yes please"]) assert.equal(readOnlyEnabled(value), false, String(value));
  for (const value of ["1", "true", "TRUE", " on ", "Yes"]) assert.equal(readOnlyEnabled(value), true, value);
});

test("readOnlyAllows: reading, the session, the tickets, STOP and the safe-mode disable go on", () => {
  for (const method of ["GET", "get", "HEAD", "OPTIONS"]) assert.equal(readOnlyAllows(method, "/api/settings"), true, method);
  for (const path of ["/api/login", "/api/refresh", "/api/logout", "/api/camera/ticket", "/api/info/ticket", "/api/stop-all", "/api/stop-all/"]) {
    assert.equal(readOnlyAllows("POST", path), true, path);
  }
  for (const command of ["stop", "disable"]) assert.equal(readOnlyAllows("POST", "/api/robot/3/command", command), true, command);
});

test("readOnlyAllows: every other write is refused", () => {
  const writes: [string, string][] = [
    ["POST", "/api/settings"], ["PUT", "/api/settings"], ["POST", "/api/users"], ["DELETE", "/api/users/bob"], ["PATCH", "/api/users/bob"],
    ["POST", "/api/system/reboot"], ["POST", "/api/admin/safety-limits"], ["POST", "/api/camera/1/recording/start"], ["PUT", "/WORKS/a.json"], ["POST", "/api/upload-work"],
    ["POST", "/api/totp/disable"], ["POST", "/elsewhere"], ["POST", "/api/loginx"], ["POST", "/api/stop-all/extra"],
  ];
  for (const [method, path] of writes) assert.equal(readOnlyAllows(method, path), false, `${method} ${path}`);
  for (const command of ["jog", "play", "pause", "reset", "enable", "tool", "valve", "pump", "speed", "vision", undefined, null, 5, ""]) {
    assert.equal(readOnlyAllows("POST", "/api/robot/3/command", command), false, String(command));
  }
  assert.equal(readOnlyAllows(undefined, undefined), false);
  assert.equal(readOnlyAllows("DELETE", "/api/robot/3/command", "stop"), false);
});

function run(on: boolean, req: Record<string, unknown>) {
  const answer: { status?: number; body?: unknown; passed: boolean } = { passed: false };
  const res = { status(code: number) { answer.status = code; return this; }, json(body: unknown) { answer.body = body; return this; } };
  makeReadOnlyGate(() => on)(req, res, () => { answer.passed = true; });
  return answer;
}

test("the gate does nothing while read-only mode is off", () => {
  assert.equal(run(false, { method: "POST", path: "/api/settings", body: {} }).passed, true);
});

test("the gate answers 423 with the code and lets STOP and reads through while it is on", () => {
  const refused = run(true, { method: "POST", path: "/api/robot/1/command", body: { command: "jog" } });
  assert.equal(refused.passed, false);
  assert.equal(refused.status, 423);
  assert.deepEqual(refused.body, READ_ONLY_REFUSAL);
  assert.equal(run(true, { method: "POST", path: "/api/robot/1/command", body: { command: "stop" } }).passed, true);
  assert.equal(run(true, { method: "GET", path: "/api/robot/1" }).passed, true);
  assert.equal(run(true, { method: "POST", path: "/api/stop-all", body: undefined }).passed, true);
  assert.equal(run(true, { method: "POST", path: "/api/robot/1/command" }).status, 423);
});

test("an audit that throws never turns the refusal into a pass", () => {
  const answer: { status?: number; passed: boolean } = { passed: false };
  const res = { status(code: number) { answer.status = code; return this; }, json() { return this; } };
  makeReadOnlyGate(() => true, { record() { throw new Error("disk full"); } })({ method: "POST", path: "/api/settings" }, res, () => { answer.passed = true; });
  assert.equal(answer.passed, false);
  assert.equal(answer.status, 423);
});
