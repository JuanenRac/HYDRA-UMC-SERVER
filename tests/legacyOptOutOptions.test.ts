import assert from "node:assert/strict";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, securityEnvFrom, type SecurityFile } from "../src/securityConfig.ts";
import { requireSignature, setSignatureRequirement } from "../src/voiceConfirm.ts";

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

test("the four options start on the conservative side", () => {
  const { config } = makeConfig();
  assert.equal(config.cameraOpen(), false);
  assert.equal(config.wsQueryTokenAllowed(), false);
  assert.equal(config.logRedactionOn(), true);
  assert.equal(config.voiceSignatureRequired(), false);
  const snapshot = config.snapshot();
  assert.deepEqual(snapshot.camera.open, { value: false, source: "default" });
  assert.deepEqual(snapshot.websocket.allowQueryToken, { value: false, source: "default" });
  assert.deepEqual(snapshot.logging.redactSecrets, { value: true, source: "default" });
  assert.deepEqual(snapshot.voice.requireSignature, { value: false, source: "default" });
});

test("the environment words keep the meaning they always had", () => {
  for (const word of ["open", "off", "false", "0", "no", "allow", " OPEN "]) assert.equal(makeConfig({ cameraAuth: word }).config.cameraOpen(), true, word);
  for (const word of ["required", "on", "1", "x"]) assert.equal(makeConfig({ cameraAuth: word }).config.cameraOpen(), false, word);
  for (const word of ["allow", "true", "1", "yes", "on"]) assert.equal(makeConfig({ wsQueryToken: word }).config.wsQueryTokenAllowed(), true, word);
  for (const word of ["deny", "0", "no"]) assert.equal(makeConfig({ wsQueryToken: word }).config.wsQueryTokenAllowed(), false, word);
  assert.equal(makeConfig({ logRedaction: "off" }).config.logRedactionOn(), false);
  assert.equal(makeConfig({ logRedaction: "on" }).config.logRedactionOn(), true);
  assert.equal(makeConfig({ voiceRequireSignature: "1" }).config.voiceSignatureRequired(), true);
  assert.equal(makeConfig({ voiceRequireSignature: "true" }).config.voiceSignatureRequired(), false);
  const env = securityEnvFrom({ HYDRA_UMC_CAMERA_AUTH: "open", HYDRA_UMC_WS_QUERY_TOKEN: "allow", HYDRA_UMC_LOG_REDACTION: "off", HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE: "1" });
  assert.deepEqual([env.cameraAuth, env.wsQueryToken, env.logRedaction, env.voiceRequireSignature], ["open", "allow", "off", "1"]);
});

test("an administrator can loosen each option; it is saved, warned about for the three risky ones, and logged", () => {
  const { config, logs, stored } = makeConfig();
  assert.deepEqual(config.update({ camera: { open: true } }, "root").warnings, ["camera_open"]);
  assert.equal(config.cameraOpen(), true);
  assert.match(logs.at(-1)!, /OPENED the camera pictures/);
  assert.deepEqual(config.update({ websocket: { allowQueryToken: true } }, "root").warnings, ["ws_query_token_allowed"]);
  assert.equal(config.wsQueryTokenAllowed(), true);
  assert.deepEqual(config.update({ logging: { redactSecrets: false } }, "root").warnings, ["log_redaction_off"]);
  assert.equal(config.logRedactionOn(), false);
  assert.match(logs.at(-1)!, /OFF/);
  assert.deepEqual(config.update({ voice: { requireSignature: true } }, "root").warnings, []);
  assert.equal(config.voiceSignatureRequired(), true);
  assert.deepEqual(stored().camera, { open: true });
  assert.deepEqual(stored().websocket, { allowQueryToken: true });
  assert.deepEqual(stored().logging, { redactSecrets: false });
  assert.deepEqual(stored().voice, { requireSignature: true });
  // closing them again warns about nothing
  assert.deepEqual(config.update({ camera: { open: false } }, "root").warnings, []);
  assert.deepEqual(config.update({ websocket: { allowQueryToken: false } }, "root").warnings, []);
  assert.deepEqual(config.update({ logging: { redactSecrets: true } }, "root").warnings, []);
  assert.equal(config.cameraOpen(), false);
  assert.equal(config.logRedactionOn(), true);
});

test("the options refuse a value that is not true or false, a patch that is not an object, and a value fixed by the environment", () => {
  const { config } = makeConfig();
  const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
  for (const value of ["yes", 1, null]) {
    assert.throws(() => config.update({ camera: { open: value } }, "root"), bad400);
    assert.throws(() => config.update({ websocket: { allowQueryToken: value } }, "root"), bad400);
    assert.throws(() => config.update({ logging: { redactSecrets: value } }, "root"), bad400);
    assert.throws(() => config.update({ voice: { requireSignature: value } }, "root"), bad400);
  }
  for (const group of ["camera", "websocket", "logging"]) {
    assert.throws(() => config.update({ [group]: "x" }, "root"), bad400, group);
    assert.throws(() => config.update({ [group]: [] }, "root"), bad400, group);
  }
  const locked = (e: unknown) => e instanceof SecurityConfigError && e.status === 409;
  const fixed = makeConfig({ cameraAuth: "required", wsQueryToken: "deny", logRedaction: "on", voiceRequireSignature: "0" });
  assert.throws(() => fixed.config.update({ camera: { open: true } }, "root"), locked);
  assert.throws(() => fixed.config.update({ websocket: { allowQueryToken: true } }, "root"), locked);
  assert.throws(() => fixed.config.update({ logging: { redactSecrets: false } }, "root"), locked);
  assert.throws(() => fixed.config.update({ voice: { requireSignature: true } }, "root"), locked);
  assert.equal(fixed.config.cameraOpen(), false);
});

test("a saved value is read on the next start, and the environment still wins over it", () => {
  const saved: SecurityFile = { camera: { open: true }, websocket: { allowQueryToken: true }, logging: { redactSecrets: false }, voice: { requireSignature: true } };
  const fromFile = makeConfig({}, saved).config;
  assert.deepEqual([fromFile.cameraOpen(), fromFile.wsQueryTokenAllowed(), fromFile.logRedactionOn(), fromFile.voiceSignatureRequired()], [true, true, false, true]);
  assert.equal(fromFile.snapshot().camera.open.source, "config");
  const overruled = makeConfig({ cameraAuth: "required", wsQueryToken: "no", logRedaction: "on", voiceRequireSignature: "0" }, saved).config;
  assert.deepEqual([overruled.cameraOpen(), overruled.wsQueryTokenAllowed(), overruled.logRedactionOn(), overruled.voiceSignatureRequired()], [false, false, true, false]);
  assert.equal(overruled.snapshot().camera.open.source, "env");
});

test("the signature requirement of a confirmed spoken request follows the environment first and the saved option otherwise", () => {
  try {
    assert.equal(requireSignature({}), false);
    setSignatureRequirement(() => true);
    assert.equal(requireSignature({}), true);
    assert.equal(requireSignature({ HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE: "0" }), false);
    assert.equal(requireSignature({ HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE: "1" }), true);
  } finally {
    setSignatureRequirement(null);
  }
  assert.equal(requireSignature({}), false);
});
