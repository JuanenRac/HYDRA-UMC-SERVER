import assert from "node:assert/strict";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceTokenStore, deviceTokenKey } from "../src/deviceTokens.ts";
import { deviceSessionEnded, messageSize, WS_MAX_ADMIN_BYTES, WS_MAX_MESSAGE_BYTES } from "../src/wsLimits.ts";

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: () => {} });
  return { config, stored: () => stored };
}

test("the size limit and the close at expiry start on, and are options of Server Admin", () => {
  const { config, stored } = makeConfig();
  assert.equal(config.wsLimitPayloadEnabled(), true);
  assert.equal(config.wsCloseOnExpiryEnabled(), true);
  const snapshot = config.snapshot();
  assert.deepEqual(snapshot.websocket.limitPayload, { value: true, source: "default" });
  assert.deepEqual(snapshot.websocket.closeOnExpiry, { value: true, source: "default" });
  assert.deepEqual(config.update({ websocket: { limitPayload: false } }, "root").warnings, ["ws_payload_unlimited"]);
  assert.equal(config.wsLimitPayloadEnabled(), false);
  assert.deepEqual(config.update({ websocket: { closeOnExpiry: false } }, "root").warnings, ["ws_expiry_not_enforced"]);
  assert.equal(config.wsCloseOnExpiryEnabled(), false);
  assert.deepEqual(stored().websocket, { limitPayload: false, closeOnExpiry: false });
  assert.deepEqual(config.update({ websocket: { limitPayload: true, closeOnExpiry: true } }, "root").warnings, []);
  assert.equal(config.wsLimitPayloadEnabled() && config.wsCloseOnExpiryEnabled(), true);
});

test("the two options refuse a value that is not true or false and one fixed by the environment", () => {
  const { config } = makeConfig();
  const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
  for (const value of ["yes", 1, null]) {
    assert.throws(() => config.update({ websocket: { limitPayload: value } }, "root"), bad400);
    assert.throws(() => config.update({ websocket: { closeOnExpiry: value } }, "root"), bad400);
  }
  const locked = (e: unknown) => e instanceof SecurityConfigError && e.status === 409;
  const fixed = makeConfig({ wsLimitPayload: "on", wsCloseOnExpiry: "off" });
  assert.throws(() => fixed.config.update({ websocket: { limitPayload: false } }, "root"), locked);
  assert.throws(() => fixed.config.update({ websocket: { closeOnExpiry: true } }, "root"), locked);
  assert.equal(fixed.config.wsLimitPayloadEnabled(), true);
  assert.equal(fixed.config.wsCloseOnExpiryEnabled(), false);
});

test("the size of what the library hands over is counted for a buffer, a list of buffers and an array buffer", () => {
  assert.equal(messageSize(Buffer.alloc(10)), 10);
  assert.equal(messageSize([Buffer.alloc(3), Buffer.alloc(4)]), 7);
  assert.equal(messageSize(new ArrayBuffer(5)), 5);
  assert.ok(WS_MAX_MESSAGE_BYTES < WS_MAX_ADMIN_BYTES);
});

test("a connection of a device token is closed once the token is revoked, and no other connection is", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-ws-device-"));
  const store = new DeviceTokenStore({ file: path.join(dir, "device-tokens.json"), key: deviceTokenKey("a-long-random-server-secret-for-the-tests-0123456789") });
  const { view } = store.issue({ name: "Bench screen", username: "panel", accountId: "acc-1", days: 30, createdBy: "root", maxDevices: 20 });
  const active = (id: string) => store.isActive(id);
  assert.equal(deviceSessionEnded(view.id, active), false);
  assert.equal(store.revoke(view.id), true);
  assert.equal(deviceSessionEnded(view.id, active), true);
  // an ordinary sign-in carries no device, and a server that cannot tell does not close anything
  assert.equal(deviceSessionEnded(undefined, active), false);
  assert.equal(deviceSessionEnded("", active), false);
  assert.equal(deviceSessionEnded(view.id, undefined), false);
  // switched off (the callback answers false for every id): the connection of a device goes too
  assert.equal(deviceSessionEnded("any-id", () => false), true);
});
