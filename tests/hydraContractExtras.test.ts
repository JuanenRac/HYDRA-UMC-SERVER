// =============================================================================
// HYDRA-UMC-SERVER - tests/hydraContractExtras.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The header of format 2 on the way to the flashing service, the signature of the global stop (the vectors of the SDK) and the watch release notice.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flashSigningQuery, viewerMayCall } from "../src/serverPolicy.ts";
import { announcementFor, signAnnouncement } from "../src/globalStopSigning.ts";
import { parseWatchNotice, WatchReleaseNotices, MAX_NOTICE_DEVICES } from "../src/watchReleaseNotice.ts";

const HEADER = "AB".repeat(64);

test("the header of format 2, or the counter and the key id, reach the flashing service and nothing half given does", () => {
  assert.deepEqual(flashSigningQuery({ header: HEADER }), { ok: true, params: { header: HEADER.toLowerCase() } });
  assert.deepEqual(flashSigningQuery({ rollback_counter: "3", key_id: "00112233445566AA" }), { ok: true, params: { rollback_counter: "3", key_id: "00112233445566aa" } });
  for (const bad of [{ header: "ab" }, { rollback_counter: "1" }, { key_id: "0".repeat(16) }, { rollback_counter: "4294967296", key_id: "0".repeat(16) }, { header: HEADER, rollback_counter: "1", key_id: "0".repeat(16) }, { header: [HEADER] }]) {
    assert.equal(flashSigningQuery(bad as Record<string, unknown>).ok, false, JSON.stringify(bad));
  }
});

// The same bytes as hydra_umc_sdk.global_stop (conformance/fixtures/v1/global-stop-signing-vectors.json of the SDK).
const vectorsFile = path.join(process.env.HYDRA_UMC_SDK_ROOT ?? path.join(process.cwd(), "..", "HYDRA-UMC-SDK"), "conformance", "fixtures", "v1", "global-stop-signing-vectors.json");

test("the announcement of the global stop is signed as the bridges check it", { skip: !fs.existsSync(vectorsFile) }, () => {
  const data = JSON.parse(fs.readFileSync(vectorsFile, "utf8"));
  for (const vector of data.vectors) {
    assert.deepEqual(signAnnouncement(data.topic, vector.payload, Buffer.from(data.key), vector.issued_at_ms), vector.signed, vector.name);
  }
});

test("without a key nothing is signed; with a key that cannot be read a SAFE_STOP still goes out and a READY does not", () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const stop = { state: "SAFE_STOP" };
  assert.deepEqual(announcementFor("t", stop, undefined, 1, log), stop);
  assert.deepEqual(announcementFor("t", stop, "/no/such/key", 1, log), stop);
  assert.equal(announcementFor("t", { state: "READY" }, "/no/such/key", 1, log), null);
  assert.equal(lines.length, 2);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "stop-key-"));
  const file = path.join(folder, "stop.key");
  fs.writeFileSync(file, `${"k".repeat(32)}\n`, { mode: 0o600 });
  const signed = announcementFor("t", { state: "READY" }, file, 7, log);
  assert.equal(signed?.issued_at_ms, 7);
  assert.match(String(signed?.signature), /^[0-9a-f]{64}$/);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("the watch release notice is validated, kept per account and phone, bounded and read again", () => {
  assert.equal(parseWatchNotice({ device_id: "a b", platform: "android", notifies_watch: true }).ok, false);
  assert.equal(parseWatchNotice({ device_id: "p1", platform: "windows", notifies_watch: true }).ok, false);
  assert.equal(parseWatchNotice({ device_id: "p1", platform: "ios", notifies_watch: "yes" }).ok, false);
  assert.equal(parseWatchNotice(undefined).ok, false);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "watch-notice-"));
  const file = path.join(folder, "notice.json");
  const notices = new WatchReleaseNotices(file, () => 0);
  for (let i = 0; i <= MAX_NOTICE_DEVICES; i += 1) notices.record("ana", { device_id: `p${i}`, platform: "android", notifies_watch: true });
  notices.record("ana", { device_id: "p5", platform: "android", notifies_watch: false });
  const again = new WatchReleaseNotices(file).list();
  assert.equal(again.length, MAX_NOTICE_DEVICES);
  assert.equal(again[0].device_id, "p5");
  assert.equal(again[0].notifies_watch, false);
  assert.equal(viewerMayCall("POST", "/api/watch/release-notice"), true);
  assert.equal(viewerMayCall("GET", "/api/admin/watch/release-notice"), true);
  fs.writeFileSync(file, "not json");
  assert.deepEqual(new WatchReleaseNotices(file).list(), []);
  fs.rmSync(folder, { recursive: true, force: true });
});
