import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, resolveAiAccess, resolveBleEncryption, resolveBleMode, resolveInfoAuth, resolveTls, resolveVoiceHeardText, resolveVoiceMinConfidence, type SecurityFile } from "../src/securityConfig.ts";

function makeConfig(env: any = {}, initial: SecurityFile = {}, tlsActive = false) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

function makeCertificate(dir: string): { cert: string; key: string } | null {
  const cert = path.join(dir, "cert.pem");
  const key = path.join(dir, "key.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=hydra-test"], { stdio: "ignore", env: { ...process.env, OPENSSL_CONF: "" } });
    return { cert, key };
  } catch {
    return null;
  }
}

test("the defaults are the behaviour the server always had", () => {
  assert.deepEqual(resolveAiAccess(undefined, {}), { value: "open", source: "default" });
  assert.deepEqual(resolveInfoAuth(undefined, {}), { value: false, source: "default" });
  assert.equal(resolveTls({}, {}).enabled, false);
});

test("the environment wins over what an administrator saved", () => {
  assert.deepEqual(resolveAiAccess("admin", { aiAccess: "open" }), { value: "admin", source: "env" });
  assert.deepEqual(resolveAiAccess(undefined, { aiAccess: "admin" }), { value: "admin", source: "config" });
  assert.deepEqual(resolveInfoAuth("required", { infoAuth: false }), { value: true, source: "env" });
  assert.deepEqual(resolveInfoAuth("off", { infoAuth: true }), { value: false, source: "env" });
  assert.equal(resolveTls({ tlsCertPath: "/a", tlsKeyPath: "/b" }, { tls: { enabled: false } }).source, "env");
  assert.equal(resolveTls({ tlsCertPath: "/a" }, {}).enabled, false);
});

test("an administrator can change the AI relay access and the change is live", () => {
  const { config, logs, stored } = makeConfig();
  assert.equal(config.aiAdminOnly(), false);
  config.update({ aiAccess: "admin" }, "root");
  assert.equal(config.aiAdminOnly(), true);
  assert.equal(stored().aiAccess, "admin");
  assert.match(logs[0], /root set the local AI relay access to admin/);
  config.update({ aiAccess: "open" }, "root");
  assert.equal(config.aiAdminOnly(), false);
});

test("turning the host information sign-in off warns and is logged; turning it on does not warn", () => {
  const { config, logs } = makeConfig({}, { infoAuth: true });
  assert.equal(config.infoAuthRequired(), true);
  const off = config.update({ infoAuth: false }, "root");
  assert.deepEqual(off.warnings, ["info_auth_off"]);
  assert.equal(config.infoAuthRequired(), false);
  assert.match(logs.at(-1)!, /OFF: it is readable by the whole network/);
  const on = config.update({ infoAuth: true }, "root");
  assert.deepEqual(on.warnings, []);
  assert.equal(config.infoAuthRequired(), true);
});

test("a value fixed by the environment cannot be changed from the app", () => {
  const { config } = makeConfig({ aiAccess: "admin", infoAuth: "required" });
  assert.throws(() => config.update({ aiAccess: "open" }, "root"), (error: any) => error instanceof SecurityConfigError && error.status === 409);
  assert.throws(() => config.update({ infoAuth: false }, "root"), (error: any) => error instanceof SecurityConfigError && error.status === 409);
});

test("bad values are refused and nothing is saved", () => {
  const { config, stored } = makeConfig();
  for (const bad of [{ aiAccess: "everyone" }, { infoAuth: "yes" }, { tls: "on" }, { tls: { enabled: "true" } }, { tls: { enabled: true } }]) {
    assert.throws(() => config.update(bad, "root"), (error: any) => error instanceof SecurityConfigError && error.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(stored(), {});
});

test("TLS needs a readable certificate and key that work together, and shows the fingerprint", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-tls-"));
  try {
    const pair = makeCertificate(dir);
    if (!pair) return t.skip("openssl is not available");
    const { config, stored } = makeConfig();
    assert.throws(() => config.update({ tls: { enabled: true, certPath: path.join(dir, "missing.pem"), keyPath: pair.key } }, "root"), (error: any) => error.status === 400);
    assert.throws(() => config.update({ tls: { enabled: true, certPath: pair.key, keyPath: pair.cert } }, "root"), (error: any) => error.status === 400);
    const result = config.update({ tls: { enabled: true, certPath: pair.cert, keyPath: pair.key } }, "root");
    assert.equal(result.appliesOnRestart, true);
    assert.equal(result.snapshot.tls.enabled, true);
    assert.equal(result.snapshot.tls.active, false);
    assert.equal(result.snapshot.tls.appliesOnRestart, true);
    assert.match(result.snapshot.tls.fingerprint256 ?? "", /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(stored().tls?.enabled, true);
    const off = config.update({ tls: { enabled: false } }, "root");
    assert.equal(off.snapshot.tls.enabled, false);
    assert.equal(off.snapshot.tls.fingerprint256, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the admin route reads and changes the options and maps errors to statuses", async () => {
  const { registerAdminRoutes } = await import("../src/routes/adminRoutes.ts");
  const handlers: Record<string, any> = {};
  const app: any = {};
  for (const method of ["get", "put", "post", "delete"]) {
    app[method] = (route: string, ...chain: any[]) => { handlers[`${method.toUpperCase()} ${route}`] = chain[chain.length - 1]; };
  }
  let saved: any = { port: 4000 };
  const { config } = makeConfig({ infoAuth: "required" });
  const security = new SecurityConfig({ env: { infoAuth: "required" }, load: () => ({ ...saved }), save: (f) => { saved = { ...saved, ...f }; }, tlsActive: false });
  void config;
  registerAdminRoutes(app, {
    authenticate: () => undefined, requireAdmin: () => undefined, asyncHandler: (h: any) => h, industrialLog: () => undefined,
    wsClients: new Set(), logFile: "x.log", getCurrentPort: () => 3000, loadServerConfig: () => ({ ...saved }), saveServerConfig: (c: any) => { saved = c; }, security,
  } as any);
  const call = (key: string, body: any) => {
    let status = 200; let payload: any;
    const res: any = { status(code: number) { status = code; return res; }, json(value: any) { payload = value; return res; } };
    handlers[key]({ body, user: { username: "root" } }, res);
    return { status, payload };
  };
  const got = call("GET /api/admin/server-config", undefined);
  assert.equal(got.payload.port, 3000);
  assert.equal(got.payload.pendingPort, 4000);
  assert.equal(got.payload.aiAccess.value, "open");
  assert.equal(got.payload.infoAuth.source, "env");
  const ok = call("PUT /api/admin/server-config", { aiAccess: "admin" });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.aiAccess.value, "admin");
  assert.equal(ok.payload.appliesOnRestart, false);
  assert.equal(saved.port, 4000); // the port kept by a security change
  assert.equal(call("PUT /api/admin/server-config", { infoAuth: false }).status, 409);
  assert.equal(call("PUT /api/admin/server-config", { aiAccess: "nobody" }).status, 400);
  assert.equal(call("PUT /api/admin/server-config", { port: 70000 }).status, 400);
  const port = call("PUT /api/admin/server-config", { port: 3100 });
  assert.equal(port.payload.appliesOnRestart, true);
  assert.equal(saved.aiAccess, "admin"); // the security choice kept by a port change
});

test("Bluetooth is off by default and asks for an encrypted link", () => {
  assert.deepEqual(resolveBleMode(undefined, {}), { value: "off", source: "default" });
  assert.deepEqual(resolveBleEncryption(undefined, {}), { value: true, source: "default" });
  assert.deepEqual(makeConfig().config.snapshot().ble, {
    mode: { value: "off", source: "default" }, requireEncryption: { value: true, source: "default" }, activeMode: "off", appliesOnRestart: false,
  });
});

test("the environment wins for Bluetooth and a word it does not know means off", () => {
  assert.deepEqual(resolveBleMode("commands", { ble: { mode: "off" } }), { value: "commands", source: "env" });
  assert.deepEqual(resolveBleMode("COMMANDS ", {}), { value: "commands", source: "env" });
  assert.deepEqual(resolveBleMode("yes", { ble: { mode: "commands" } }), { value: "off", source: "env" });
  assert.deepEqual(resolveBleMode(undefined, { ble: { mode: "state" } }), { value: "state", source: "config" });
  assert.deepEqual(resolveBleEncryption("off", { ble: { requireEncryption: true } }), { value: false, source: "env" });
  assert.deepEqual(resolveBleEncryption("anything", {}), { value: true, source: "env" });
  assert.deepEqual(resolveBleEncryption(undefined, { ble: { requireEncryption: false } }), { value: false, source: "config" });
});

test("an administrator can turn Bluetooth on from the app; it applies on the next start", () => {
  const { config, logs, stored } = makeConfig({}, { aiAccess: "admin" });
  const result = config.update({ ble: { mode: "state" } }, "root");
  assert.equal(result.appliesOnRestart, true);
  assert.equal(result.snapshot.ble.mode.value, "state");
  assert.equal(result.snapshot.ble.appliesOnRestart, true, "the running mode is still off");
  assert.deepEqual(stored().ble, { mode: "state" });
  assert.equal(stored().aiAccess, "admin", "the other options are kept");
  assert.match(logs.at(-1)!, /root set Bluetooth to state; it applies on the next start/);
  assert.deepEqual(result.warnings, []);
});

test("commands over Bluetooth without an encrypted link warn", () => {
  const { config, logs } = makeConfig();
  const result = config.update({ ble: { mode: "commands", requireEncryption: false } }, "root");
  assert.deepEqual(result.warnings, ["ble_commands_unencrypted"]);
  assert.match(logs.at(-1)!, /WITHOUT link encryption/);
  assert.deepEqual(config.update({ ble: { requireEncryption: true } }, "root").warnings, []);
  assert.deepEqual(config.ble().file, { mode: "commands", requireEncryption: true });
});

test("bad Bluetooth values are refused, and one fixed by the environment is locked", () => {
  const { config, stored } = makeConfig();
  for (const bad of [{ ble: "on" }, { ble: [] }, { ble: { mode: "all" } }, { ble: { requireEncryption: "yes" } }]) {
    assert.throws(() => config.update(bad, "root"), (error: any) => error instanceof SecurityConfigError && error.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(stored(), {});
  const locked = makeConfig({ bleGatt: "state", bleEncryption: "required" });
  assert.throws(() => locked.config.update({ ble: { mode: "off" } }, "root"), (error: any) => error instanceof SecurityConfigError && error.status === 409);
  assert.throws(() => locked.config.update({ ble: { requireEncryption: false } }, "root"), (error: any) => error instanceof SecurityConfigError && error.status === 409);
});

test("the tunables of the Bluetooth service stay in the saved file, untouched by a change of mode", () => {
  const { config, stored } = makeConfig({}, { ble: { name: "Cell 3", commandsPerSecond: 4, helperCommand: "python3" } });
  config.update({ ble: { mode: "state" } }, "root");
  assert.deepEqual(stored().ble, { name: "Cell 3", commandsPerSecond: 4, helperCommand: "python3", mode: "state" });
});

test("the MQTT bridge is off by default and an administrator can set it up without any secret in the file", () => {
  const { config, logs, stored } = makeConfig();
  assert.equal(config.snapshot().mqtt.mode.value, "off");
  assert.equal(config.snapshot().mqtt.mode.source, "default");
  const first = config.update({ mqtt: { mode: "state", url: "mqtts://broker.local:8883", prefix: "plant/cell1", username: "hydra" } }, "root");
  assert.equal(first.appliesOnRestart, true);
  assert.deepEqual(stored().mqtt, { mode: "state", url: "mqtts://broker.local:8883", prefix: "plant/cell1", username: "hydra" });
  assert.equal(config.snapshot().mqtt.prefix, "plant/cell1");
  assert.equal(config.snapshot().mqtt.activeMode, "off", "the running mode only changes on a restart");
  assert.equal(config.snapshot().mqtt.appliesOnRestart, true);
  assert.match(logs.at(-1)!, /root set the MQTT bridge to state/);
  assert.ok(!JSON.stringify(config.snapshot()).includes("password"));
});

test("the MQTT commands need the account that carries them out, and bad values are refused", () => {
  const { config } = makeConfig();
  assert.throws(() => config.update({ mqtt: { mode: "commands" } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 400 && /commandUser/.test(e.message));
  const on = config.update({ mqtt: { mode: "commands", commandUser: "mqtt-bridge" } }, "root");
  assert.deepEqual(on.warnings, ["mqtt_commands_on"]);
  for (const bad of [{ mode: "banana" }, { url: "http://x" }, { url: "file:///etc/passwd" }, { prefix: "a/#" }, { prefix: "../x" }, { username: 5 }, { commandUser: "a\nb" }]) {
    assert.throws(() => config.update({ mqtt: bad }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => config.update({ mqtt: "state" }, "root"), SecurityConfigError);
});

test("an MQTT setting fixed in the environment cannot be changed from the app, and the address shows no credentials", () => {
  const { config } = makeConfig({ mqtt: { mode: "state", url: "mqtt://user:secret@10.0.0.5:1883" } });
  assert.equal(config.snapshot().mqtt.mode.source, "env");
  assert.ok(!JSON.stringify(config.snapshot()).includes("secret"));
  assert.throws(() => config.update({ mqtt: { mode: "off" } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /HYDRA_UMC_MQTT_BRIDGE/.test(e.message));
  assert.throws(() => config.update({ mqtt: { url: "mqtt://other:1883" } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409);
});

test("the voice options default to the behaviour of the voice service and follow environment, then saved, then default", () => {
  const { config } = makeConfig();
  assert.deepEqual(config.voiceOptions(), { includeHeardText: false, minConfidence: 0.6 });
  assert.deepEqual(config.snapshot().voice, { includeHeardText: { value: false, source: "default" }, minConfidence: { value: 0.6, source: "default" } });
  assert.deepEqual(resolveVoiceHeardText("1", { voice: { includeHeardText: false } }), { value: true, source: "env" });
  assert.deepEqual(resolveVoiceHeardText("true", {}), { value: false, source: "env" }, "only the exact word 1 switches it on, as in the voice service");
  assert.deepEqual(resolveVoiceMinConfidence("0.8", { voice: { minConfidence: 0.2 } }), { value: 0.8, source: "env" });
  assert.deepEqual(resolveVoiceMinConfidence("banana", { voice: { minConfidence: 0.2 } }), { value: 0.2, source: "config" }, "a typing mistake in the environment is ignored");
  assert.deepEqual(resolveVoiceMinConfidence("7", {}), { value: 0.6, source: "default" });
});

test("an administrator changes the voice options, live, with warnings for the risky directions", () => {
  const { config, logs, stored } = makeConfig();
  const on = config.update({ voice: { includeHeardText: true, minConfidence: 0.9 } }, "root");
  assert.deepEqual(on.warnings, ["voice_heard_text_on"]);
  assert.equal(on.appliesOnRestart, false);
  assert.deepEqual(config.voiceOptions(), { includeHeardText: true, minConfidence: 0.9 });
  assert.deepEqual(stored().voice, { includeHeardText: true, minConfidence: 0.9 });
  assert.match(logs.at(-1)!, /root set the voice options: transcript in replies ON, minimum confidence 0.9/);
  const off = config.update({ voice: { minConfidence: 0 } }, "root");
  assert.deepEqual(off.warnings, ["voice_confidence_off"]);
  assert.deepEqual(config.voiceOptions(), { includeHeardText: true, minConfidence: 0 }, "a patch with one field keeps the other");
});

test("bad voice values are refused and a value fixed in the environment is locked", () => {
  const { config } = makeConfig();
  for (const bad of [{ includeHeardText: "yes" }, { includeHeardText: 1 }, { minConfidence: -0.1 }, { minConfidence: 1.1 }, { minConfidence: "0.5" }, { minConfidence: Number.NaN }, { minConfidence: null }]) {
    assert.throws(() => config.update({ voice: bad }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => config.update({ voice: [] }, "root"), SecurityConfigError);
  assert.deepEqual(config.voiceOptions(), { includeHeardText: false, minConfidence: 0.6 }, "nothing was saved");
  const locked = makeConfig({ voiceHeardText: "0", voiceMinConfidence: "0.7" }).config;
  assert.throws(() => locked.update({ voice: { includeHeardText: true } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /INCLUDE_HEARD_TEXT/.test(e.message));
  assert.throws(() => locked.update({ voice: { minConfidence: 0.1 } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /MIN_CONFIDENCE/.test(e.message));
  assert.deepEqual(locked.voiceOptions(), { includeHeardText: false, minConfidence: 0.7 });
});

test("MAVLink signing is off by default, checks the key file and never shows the key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-mav-"));
  try {
    const hexKey = path.join(dir, "hex.key");
    const rawKey = path.join(dir, "raw.key");
    const badKey = path.join(dir, "bad.key");
    fs.writeFileSync(hexKey, Buffer.alloc(32, 0xab).toString("hex") + "\n");
    fs.writeFileSync(rawKey, Buffer.alloc(32, 7));
    fs.writeFileSync(badKey, "secret-looking-text");
    const { config, logs, stored } = makeConfig();
    assert.equal(config.snapshot().mavlink.signing, false);
    assert.equal(config.snapshot().mavlink.signingAllowUnsigned.value, false);
    assert.equal(config.snapshot().mavlink.appliesOnRestart, false);
    const on = config.update({ mavlink: { signingKeyFile: hexKey } }, "root");
    assert.equal(on.appliesOnRestart, true);
    assert.deepEqual(on.warnings, []);
    assert.equal(config.snapshot().mavlink.signing, true);
    assert.equal(config.snapshot().mavlink.appliesOnRestart, true);
    assert.deepEqual(stored().mavlink, { signingKeyFile: hexKey });
    assert.ok(!JSON.stringify(config.snapshot()).includes(Buffer.alloc(32, 0xab).toString("hex")), "the key itself is never in the answer");
    assert.match(logs.at(-1)!, /MAVLink signing on/);
    config.update({ mavlink: { signingKeyFile: rawKey } }, "root");
    const unsigned = config.update({ mavlink: { signingAllowUnsigned: true } }, "root");
    assert.deepEqual(unsigned.warnings, ["mavlink_unsigned_allowed"]);
    assert.deepEqual(stored().mavlink, { signingKeyFile: rawKey, signingAllowUnsigned: true });
    for (const bad of [{ signingKeyFile: badKey }, { signingKeyFile: path.join(dir, "missing.key") }, { signingKeyFile: 5 }, { signingKeyFile: "a\nb" }, { signingKeyFile: "x".repeat(2000) }, { signingAllowUnsigned: "yes" }]) {
      assert.throws(() => config.update({ mavlink: bad }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 400 && !/secret-looking/.test(e.message), JSON.stringify(bad).slice(0, 80));
    }
    const off = config.update({ mavlink: { signingKeyFile: "" } }, "root");
    assert.deepEqual(off.warnings, ["mavlink_signing_off"]);
    assert.equal(config.snapshot().mavlink.signing, false);
    assert.match(logs.at(-1)!, /MAVLink signing OFF/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MAVLink signing fixed in the environment cannot be changed from the app", () => {
  const { config } = makeConfig({ mavlinkKeyFile: "/etc/uav.key", mavlinkAllowUnsigned: "1" });
  assert.deepEqual(config.snapshot().mavlink.signingKeyFile, { value: "/etc/uav.key", source: "env" });
  assert.deepEqual(config.snapshot().mavlink.signingAllowUnsigned, { value: true, source: "env" });
  assert.throws(() => config.update({ mavlink: { signingKeyFile: "" } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /SIGNING_KEY_FILE/.test(e.message));
  assert.throws(() => config.update({ mavlink: { signingAllowUnsigned: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /ALLOW_UNSIGNED/.test(e.message));
});

test("bringing a disabled robot back is off by default and only the exact word 1 switches it on from the environment", () => {
  const { config } = makeConfig();
  assert.equal(config.robotEnableAllowed(), false);
  assert.deepEqual(config.snapshot().robots.allowEnable, { value: false, source: "default" });
  assert.equal(makeConfig({ robotAllowEnable: "1" }).config.robotEnableAllowed(), true);
  for (const word of ["true", "yes", "on", "0", ""]) assert.equal(makeConfig({ robotAllowEnable: word }).config.robotEnableAllowed(), false, word);
});

test("an administrator can allow enabling robots; it warns, is logged and is saved", () => {
  const { config, logs, stored } = makeConfig();
  const result = config.update({ robots: { allowEnable: true } }, "root");
  assert.deepEqual(result.warnings, ["robot_enable_allowed"]);
  assert.equal(result.appliesOnRestart, false);
  assert.equal(config.robotEnableAllowed(), true);
  assert.deepEqual(stored().robots, { allowEnable: true });
  assert.match(logs.at(-1)!, /allowed bringing a disabled robot back/);
  const off = config.update({ robots: { allowEnable: false } }, "root");
  assert.deepEqual(off.warnings, []);
  assert.equal(config.robotEnableAllowed(), false);
  assert.match(logs.at(-1)!, /forbade/);
});

test("the option for enabling robots refuses a value that is not true or false and one fixed by the environment", () => {
  const { config } = makeConfig();
  for (const bad of [{ allowEnable: "yes" }, { allowEnable: 1 }]) {
    assert.throws(() => config.update({ robots: bad }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 400);
  }
  assert.throws(() => config.update({ robots: [] }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 400);
  const fixed = makeConfig({ robotAllowEnable: "1" }).config;
  assert.throws(() => fixed.update({ robots: { allowEnable: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /ROBOT_ALLOW_ENABLE/.test(e.message));
});

test("keeping the address of the clients in the history is off by default and only the exact word 1 switches it on from the environment", () => {
  const { config } = makeConfig();
  assert.equal(config.connectionAddressRecorded(), false);
  assert.deepEqual(config.snapshot().connections.recordAddress, { value: false, source: "default" });
  assert.equal(makeConfig({ connectionRecordAddress: "1" }).config.connectionAddressRecorded(), true);
  for (const word of ["true", "yes", "on", "0", ""]) assert.equal(makeConfig({ connectionRecordAddress: word }).config.connectionAddressRecorded(), false, word);
});

test("an administrator can allow keeping the address of the clients; it warns, is logged and is saved", () => {
  const { config, logs, stored } = makeConfig();
  const result = config.update({ connections: { recordAddress: true } }, "root");
  assert.deepEqual(result.warnings, ["connection_address_recorded"]);
  assert.equal(config.connectionAddressRecorded(), true);
  assert.deepEqual(stored().connections, { recordAddress: true });
  assert.match(logs.at(-1)!, /allowed keeping the address/);
  const off = config.update({ connections: { recordAddress: false } }, "root");
  assert.deepEqual(off.warnings, []);
  assert.equal(config.connectionAddressRecorded(), false);
  assert.match(logs.at(-1)!, /forbade/);
});

test("the option for the address of the clients refuses a value that is not true or false and one fixed by the environment", () => {
  const { config } = makeConfig();
  for (const bad of [{ recordAddress: "yes" }, { recordAddress: 1 }]) {
    assert.throws(() => config.update({ connections: bad }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 400);
  }
  assert.throws(() => config.update({ connections: [] }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 400);
  const fixed = makeConfig({ connectionRecordAddress: "1" }).config;
  assert.throws(() => fixed.update({ connections: { recordAddress: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /CONNECTION_RECORD_ADDRESS/.test(e.message));
});
