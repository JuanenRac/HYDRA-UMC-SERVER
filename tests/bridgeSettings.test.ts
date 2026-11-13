import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { BridgeGateway, resolveGatewaySettings } from "../src/bridgeGateway.ts";
import { BRIDGE_SWITCHES, allSettingsMessages, applyBridgesPatch, resolveBridgeSettings, settingsMessage } from "../src/bridgeSettings.ts";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig.ts";
import { BridgeSettingsSigner } from "../src/bridgeSettingsSigning.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NOW = 1_800_000_000_000;
function makeSigner(): BridgeSettingsSigner {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-bridge-keys-"));
  return new BridgeSettingsSigner({ keyDir: dir, now: () => NOW });
}

function makeConfig(env: any = {}, initial: SecurityFile = {}, extra: Record<string, unknown> = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m), ...extra });
  return { config, logs, stored: () => stored };
}
const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;

test("every switch starts at its conservative value; what moves hardware is off", () => {
  const s = makeConfig().config.snapshot().bridges;
  assert.equal(s.delivery, "gateway_off");
  assert.deepEqual(s.uav.missionUploadEnabled, { value: false, source: "default", default: false, risky: [true], localName: "config/uav.json: mission.upload_enabled" });
  assert.equal(s.amr.publishState.value, false);
  assert.equal(s.amr.publishOpcua.value, false);
  assert.equal(s.amr.zoneInterlock.value, false);
  assert.equal(s.amr.zoneUnknown.value, "pause");
  assert.equal(s.droids.globalStop.value, false);
  assert.equal(s.droids.cutOnGlobalStop.value, true);
  assert.equal(s.openpnp.boardCode.value, "off");
  for (const sw of BRIDGE_SWITCHES) assert.equal(s[sw.bridge][sw.key].source, "default", `${sw.bridge}.${sw.key}`);
});

test("a saved value is used, an invalid one in the file is ignored", () => {
  const view = resolveBridgeSettings({ uav: { missionUploadEnabled: true }, amr: { zoneUnknown: "banana" as never, publishState: "yes" as never } });
  assert.deepEqual([view.uav.missionUploadEnabled.value, view.uav.missionUploadEnabled.source], [true, "config"]);
  assert.deepEqual([view.amr.zoneUnknown.value, view.amr.zoneUnknown.source], ["pause", "default"]);
  assert.deepEqual([view.amr.publishState.value, view.amr.publishState.source], [false, "default"]);
});

test("a change is validated, saved, logged and warned about when it turns on a risk or takes a protection away", () => {
  const { config, logs, stored } = makeConfig();
  const on = config.update({ bridges: { uav: { missionUploadEnabled: true } } }, "root");
  assert.deepEqual(on.warnings, ["bridge_uav_missionUploadEnabled"]);
  assert.deepEqual(stored().bridges, { uav: { missionUploadEnabled: true } });
  assert.match(logs.at(-1)!, /switches of the machine bridges \(uav\.missionUploadEnabled=true\).*gateway is off/);
  assert.deepEqual(config.update({ bridges: { amr: { zoneUnknown: "ignore" } } }, "root").warnings, ["bridge_amr_zoneUnknown"]);
  assert.deepEqual(config.update({ bridges: { droids: { cutOnGlobalStop: false } } }, "root").warnings, ["bridge_droids_cutOnGlobalStop"]);
  assert.deepEqual(config.update({ bridges: { uav: { missionUploadEnabled: false }, amr: { publishState: true } } }, "root").warnings, []);
  assert.deepEqual(stored().bridges, { uav: { missionUploadEnabled: false }, amr: { zoneUnknown: "ignore", publishState: true }, droids: { cutOnGlobalStop: false } });
  assert.equal(config.snapshot().bridges.amr.publishState.source, "config");
});

test("a bad body is refused with 400 and changes nothing", () => {
  const { config, stored } = makeConfig();
  for (const patch of [null, [], "x", { nobody: {} }, { uav: [] }, { uav: { nothing: true } }, { uav: { missionUploadEnabled: "true" } }, { amr: { zoneUnknown: "maybe" } }, { openpnp: { boardCode: true } }]) {
    assert.throws(() => config.update({ bridges: patch as never }, "root"), bad400, JSON.stringify(patch));
  }
  assert.equal(stored().bridges, undefined);
  assert.throws(() => applyBridgesPatch(undefined, { uav: { missionUploadEnabled: 1 } }), /must be true or false/);
});

test("the message of a bridge is signed and carries only its own switches, with the values in force", () => {
  const file = { uav: { missionUploadEnabled: true }, amr: { publishState: true } };
  const signer = makeSigner();
  const uav = JSON.parse(settingsMessage("uav", file, signer)!);
  assert.equal(uav.schema, 2);
  assert.deepEqual(uav.settings, { missionUploadEnabled: true, envelopeRequired: true, confirmationRequired: true, chainInFlight: false, uploadGeofence: false });
  assert.match(uav.signature, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(settingsMessage("amr", file, signer)!).settings, { publishState: true, publishOpcua: false, zoneInterlock: false, zoneUnknown: "pause" });
  assert.deepEqual(allSettingsMessages(undefined, signer).map((m) => m.name), ["droids", "uav", "amr", "openpnp"]);
});

class FakeClient extends EventEmitter {
  published: { topic: string; payload: string; options: any }[] = [];
  publish(topic: string, payload: string, options: any, callback?: (error?: Error | null) => void) { this.published.push({ topic, payload, options }); callback?.(null); }
  subscribe(_t: string, _o: any, callback?: (error: Error | null) => void) { callback?.(null); }
  end(_force?: boolean, callback?: () => void) { callback?.(); }
}

test("the gateway announces the settings retained on connect and again on request, and says nothing while it is not connected", () => {
  const client = new FakeClient();
  let file = { uav: { missionUploadEnabled: false } };
  const signer = makeSigner();
  const gateway = new BridgeGateway({
    getSettings: () => resolveGatewaySettings({}),
    url: "mqtt://127.0.0.1:1883",
    connect: () => client as never,
    log: () => undefined,
    settingsRefreshMs: 0,
    getBridgeSettings: (prefix) => allSettingsMessages(file, signer, prefix),
  });
  gateway.announceSettings();
  assert.equal(client.published.length, 0);
  gateway.ensureStarted();
  gateway.announceSettings();
  assert.equal(client.published.length, 0, "not connected yet");
  client.emit("connect");
  assert.deepEqual(client.published.map((p) => p.topic), ["hydra/bridges/droids/settings", "hydra/bridges/uav/settings", "hydra/bridges/amr/settings", "hydra/bridges/openpnp/settings"]);
  assert.ok(client.published.every((p) => p.options.retain === true && p.options.qos === 1));
  file = { uav: { missionUploadEnabled: true } };
  client.published.length = 0;
  gateway.announceSettings();
  assert.equal(JSON.parse(client.published[1].payload).settings.missionUploadEnabled, true);
});

test("saving the switches asks the gateway to announce them, and the delivery says whether the gateway is on", () => {
  let announced = 0;
  const { config } = makeConfig({ bridgeGateway: "1" }, {}, { afterBridgesWritten: () => { announced += 1; } });
  assert.equal(config.snapshot().bridges.delivery, "gateway_on");
  config.update({ bridges: { amr: { publishState: true } } }, "root");
  config.update({ aiAccess: "admin" }, "root");
  assert.equal(announced, 1);
});

test("the flight policy switches are conservative by default and the risky values ask for a confirmation", () => {
  const s = resolveBridgeSettings(undefined);
  assert.equal(s.uav.envelopeRequired.value, true);
  assert.equal(s.uav.confirmationRequired.value, true);
  assert.equal(s.uav.chainInFlight.value, false);
  assert.equal(s.uav.uploadGeofence.value, false);
  assert.equal(s.droids.confirmationRequired.value, true);
  assert.equal(s.droids.returnHomeAlways.value, true);
  assert.deepEqual(applyBridgesPatch(undefined, { uav: { envelopeRequired: false, chainInFlight: true } }).warnings, ["bridge_uav_envelopeRequired", "bridge_uav_chainInFlight"]);
  assert.deepEqual(applyBridgesPatch(undefined, { droids: { confirmationRequired: false } }).warnings, ["bridge_droids_confirmationRequired"]);
  assert.deepEqual(applyBridgesPatch(undefined, { uav: { envelopeRequired: true }, droids: { returnHomeAlways: false } }).warnings, []);
});
