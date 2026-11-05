import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { allSettingsMessages } from "../src/bridgeSettings.ts";
import { BridgeSettingsSigner, canonicalJson, signSettings, verifySettings } from "../src/bridgeSettingsSigning.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;
const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), "hydra-bridge-keys-"));

test("the signature is the one the SDK makes for the same message (vectors made with hydra_umc_sdk.signed_commands)", () => {
  const body = { schema: 2, settings: { zoneUnknown: "pause", publishState: true, zoneInterlock: false } };
  const signed = signSettings("hydra/bridges/amr/settings", body, KEY, 1_800_000_000_007, NOW, 120_000);
  assert.equal(signed.signature, "b62f83f0a2cb5825ba1fce32294accf28146eaffc85997734d9d6ff55f4cd820");
  const escaped = signSettings("hydra/bridges/droids/settings", { settings: { note: "caf\u00e9 \"q\" \\ \n \u4e2d" } }, KEY, 5, NOW, 120_000);
  assert.equal(escaped.signature, "3bce95080e550efaaeccd196e861845794835bf916beef065cc22e5543489c11");
});

test("the canonical JSON has sorted keys, no spaces and ASCII escapes, and refuses what cannot be written the same everywhere", () => {
  assert.equal(canonicalJson({ b: [true, null, 1], a: "\u00e9\n" }), '{"a":"\\u00e9\\n","b":[true,null,1]}');
  assert.throws(() => canonicalJson({ a: 1.5 }));
  assert.throws(() => canonicalJson({ a: undefined }));
});

test("a valid message is accepted; another key, another topic, an altered switch or a missing signature is refused", () => {
  const topic = "hydra/bridges/amr/settings";
  const message = signSettings(topic, { settings: { zoneInterlock: true } }, KEY, 10, NOW);
  assert.deepEqual(verifySettings(topic, message, KEY, NOW + 1000), { ok: true, reason: "signed and current" });
  assert.equal(verifySettings(topic, message, "f".repeat(64), NOW).ok, false);
  assert.equal(verifySettings("hydra/bridges/droids/settings", message, KEY, NOW).ok, false);
  assert.equal(verifySettings(topic, { ...message, settings: { zoneInterlock: false } }, KEY, NOW).ok, false);
  const { signature: _s, ...unsigned } = message;
  void _s;
  assert.equal(verifySettings(topic, unsigned, KEY, NOW).ok, false);
  assert.equal(verifySettings(topic, { schema: 1, settings: {} }, KEY, NOW).ok, false);
  assert.equal(verifySettings(topic, "x", KEY, NOW).ok, false);
});

test("an expired message, one from the future and one that asks too long a life are refused", () => {
  const topic = "hydra/bridges/amr/settings";
  const message = signSettings(topic, { settings: {} }, KEY, 10, NOW, 60_000);
  assert.equal(verifySettings(topic, message, KEY, NOW + 59_000).ok, true);
  assert.deepEqual(verifySettings(topic, message, KEY, NOW + 61_000), { ok: false, reason: "expired" });
  assert.deepEqual(verifySettings(topic, message, KEY, NOW - 60_000), { ok: false, reason: "issued in the future" });
  assert.deepEqual(verifySettings(topic, signSettings(topic, { settings: {} }, KEY, 10, NOW, 3_600_000), KEY, NOW), { ok: false, reason: "asks too long a life" });
});

test("an older counter is a replay; the same message again is harmless", () => {
  const topic = "hydra/bridges/amr/settings";
  const older = signSettings(topic, { settings: { zoneInterlock: false } }, KEY, 9, NOW);
  const newer = signSettings(topic, { settings: { zoneInterlock: true } }, KEY, 10, NOW);
  assert.equal(verifySettings(topic, newer, KEY, NOW, 9).ok, true);
  assert.equal(verifySettings(topic, newer, KEY, NOW, 10).ok, true);
  assert.deepEqual(verifySettings(topic, older, KEY, NOW, 10), { ok: false, reason: "replay" });
});

test("the signer makes a key once (mode 600 where the system has modes), never prints it, and the counter only goes up even if the clock goes back", () => {
  const dir = folder();
  const logs: string[] = [];
  let now = NOW;
  const signer = new BridgeSettingsSigner({ keyDir: dir, now: () => now, log: (m) => logs.push(m) });
  const topic = "hydra/bridges/droids/settings";
  const first = signer.sign(topic, "droids", { settings: { globalStop: false } })!;
  const keyFile = path.join(dir, "droids.key");
  const key = fs.readFileSync(keyFile, "utf8").trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(keyFile).mode & 0o077, 0);
  assert.ok(logs.every((line) => !line.includes(key)), "the key is never logged");
  assert.deepEqual(verifySettings(topic, first, key, NOW), { ok: true, reason: "signed and current" });
  now = NOW - 10_000;
  const second = signer.sign(topic, "droids", { settings: { globalStop: true } })!;
  assert.ok((second.seq as number) > (first.seq as number));
  assert.equal(fs.readFileSync(keyFile, "utf8").trim(), key, "the key is not made again");
  const status = signer.status(["droids", "amr"]);
  assert.equal(status.droids.key, "present");
  assert.equal(status.amr.key, "missing");
  assert.equal(JSON.stringify(status).includes(key), false);
});

test("a key that is too short or unreadable means nothing is published for that bridge", () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, "amr.key"), "short\n");
  const signer = new BridgeSettingsSigner({ keyDir: dir, now: () => NOW });
  assert.equal(signer.sign("hydra/bridges/amr/settings", "amr", { settings: {} }), null);
  assert.equal(signer.status(["amr"]).amr.key, "unusable");
  assert.deepEqual(allSettingsMessages(undefined, signer).map((m) => m.name).sort(), ["droids", "openpnp", "uav"]);
});
