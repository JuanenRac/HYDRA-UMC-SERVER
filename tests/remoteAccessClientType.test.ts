import assert from "node:assert/strict";
import { test } from "node:test";
import { clientTypeOfHeader, remoteAccessAllowed } from "../src/serverPolicy.ts";
import { identify } from "../src/connections.ts";

const TYPES = ["suite", "android", "ios", "watch", "dsi"];
const VERSIONS = [
  "0.7.5", "0.8.0.5", "1", "x", "", "0.7.5/extra", "../../etc", "0.7.5 ", " 0.7.5", "0.7.5\r\nx-other: 1", "0.7.5\u0000", "‮android", "%2f", "a b c", "ü", "0.7.5;suite",
  "9".repeat(30), "9".repeat(300), "9".repeat(5000),
];

const settingsClosing = (type: string) => ({ remoteAccess: { [type]: false } });
const settingsOpening = (type: string) => ({ remoteAccess: { enabled: false, [type]: true } });

test("a version after the slash neither opens nor closes the access of a client type", () => {
  for (const type of TYPES) {
    for (const settings of [undefined, {}, { remoteAccess: {} }, settingsClosing(type), settingsOpening(type), { remoteAccess: { enabled: false } }, { remoteAccess: { enabled: true } }]) {
      const bare = remoteAccessAllowed(settings, type);
      for (const version of VERSIONS) {
        assert.equal(remoteAccessAllowed(settings, `${type}/${version}`), bare, `${type}/${JSON.stringify(version).slice(0, 40)}`);
      }
    }
  }
});

test("the concrete cases of each type with a version", () => {
  for (const type of TYPES) {
    assert.equal(remoteAccessAllowed(settingsClosing(type), `${type}/0.7.5`), false, type);
    assert.equal(remoteAccessAllowed(settingsOpening(type), `${type}/0.7.5`), true, type);
    assert.equal(remoteAccessAllowed({ remoteAccess: { enabled: false } }, `${type}/0.7.5`), false, type);
  }
  // a toggle of one type does not touch another
  assert.equal(remoteAccessAllowed(settingsClosing("android"), "suite/0.7.4"), true);
  assert.equal(remoteAccessAllowed(settingsClosing("android"), "android/0.7.5"), false);
});

test("the type is read without regard to case or surrounding spaces; unknown or missing types are not gated", () => {
  assert.equal(remoteAccessAllowed(settingsClosing("android"), "Android/0.7.5"), false);
  assert.equal(remoteAccessAllowed(settingsClosing("android"), "  android  "), false);
  for (const header of [undefined, "", "/", "/0.7.5", "curl", "curl/8.1", "androidx/1", "admin/1.0", "android-x/1", "xandroid"]) {
    assert.equal(remoteAccessAllowed({ remoteAccess: { enabled: false, android: false, suite: false, ios: false, watch: false, dsi: false } }, header), true, String(header));
  }
});

test("a header with several values is allowed only when every one is", () => {
  const closed = settingsClosing("android");
  assert.equal(remoteAccessAllowed(closed, "suite/0.7.4, android/0.7.5"), false);
  assert.equal(remoteAccessAllowed(closed, "android/0.7.5, suite"), false);
  assert.equal(remoteAccessAllowed(closed, "suite, studio"), true);
  assert.equal(remoteAccessAllowed(closed, ["android/0.7.5", "suite"]), false);
});

test("clientTypeOfHeader keeps only the type", () => {
  assert.equal(clientTypeOfHeader("android/0.7.5"), "android");
  assert.equal(clientTypeOfHeader("Studio/0.8.0.5"), "studio");
  assert.equal(clientTypeOfHeader("/1"), undefined);
  assert.equal(clientTypeOfHeader(undefined), undefined);
  assert.equal(clientTypeOfHeader("android" + "/".repeat(10) + "9".repeat(9000)), "android");
});

test("the history still gets the version apart from the type, and a strange version is not kept", () => {
  const header = (value: string) => ({ header: (name: string) => (name === "x-hydra-client" ? value : name === "user-agent" ? "okhttp/4.12" : undefined) });
  assert.deepEqual([identify(header("android/0.7.5")).kind, identify(header("android/0.7.5")).version], ["android", "0.7.5"]);
  assert.deepEqual([identify(header("android")).kind, identify(header("android")).version], ["android", undefined]);
  // a manipulated version never reaches the history as a version; the type is then taken from the user agent
  for (const version of ["9".repeat(300), "a b", "0.7.5\r\nx: 1", "%2f..", "ü"]) {
    assert.equal(identify(header(`suite/${version}`)).version, undefined, version.slice(0, 20));
  }
});
