// =============================================================================
// HYDRA-UMC-SERVER - Direct unit tests for src/serverPolicy.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Found while auditing the code: this whole
// repository had zero direct unit tests - only the real, valuable but
// end-to-end tools/verify_*_contract.mjs scripts, each spinning up a full
// server process. These are genuinely pure functions (moved out of
// server.ts into ./serverPolicy - see that module's own header comment),
// so they're tested directly here, in-process, with node's own built-in
// test runner (run via `tsx --test`, the same tsx already a devDependency
// - see package.json's "test:unit" script) - no new dependency, no server
// process, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  realSettings,
  remoteAccessAllowed,
  computeDeviceArg,
  cameraFingerprint,
  cameraStreamPort,
  hi3510Action,
  safeIdSegment,
  slugify,
} from "../src/serverPolicy";

test("realSettings", async (t) => {
  await t.test("unwraps the real { settings, controllers } wire shape", () => {
    assert.deepEqual(realSettings({ settings: { serverName: "X" }, controllers: [] }), { serverName: "X" });
  });
  await t.test("passes an already-unwrapped payload through unchanged", () => {
    assert.deepEqual(realSettings({ serverName: "X" }), { serverName: "X" });
  });
  await t.test("returns undefined/null as-is instead of throwing", () => {
    assert.equal(realSettings(undefined), undefined);
    assert.equal(realSettings(null), null);
  });
});

test("remoteAccessAllowed", async (t) => {
  await t.test("never gates an unrecognized/absent client type", () => {
    assert.equal(remoteAccessAllowed({ remoteAccess: { suite: false } }, undefined), true);
    assert.equal(remoteAccessAllowed({ remoteAccess: { suite: false } }, "curl"), true);
  });
  await t.test("defaults to allowed when no remoteAccess config was ever saved", () => {
    assert.equal(remoteAccessAllowed({}, "suite"), true);
    assert.equal(remoteAccessAllowed(undefined, "android"), true);
  });
  await t.test("honors a per-client explicit false", () => {
    assert.equal(remoteAccessAllowed({ remoteAccess: { suite: false } }, "suite"), false);
  });
  await t.test("honors a per-client explicit true even when the legacy toggle is off", () => {
    assert.equal(remoteAccessAllowed({ remoteAccess: { enabled: false, suite: true } }, "suite"), true);
  });
  await t.test("recognizes dsi as a gated client type - the real gap this function's own history fixed", () => {
    assert.equal(remoteAccessAllowed({ remoteAccess: { dsi: false } }, "dsi"), false);
    assert.equal(remoteAccessAllowed({ remoteAccess: {} }, "dsi"), true);
  });
  await t.test("falls back to the legacy singular toggle only when this client's own flag was never set", () => {
    assert.equal(remoteAccessAllowed({ remoteAccess: { enabled: false } }, "android"), false);
    assert.equal(remoteAccessAllowed({ remoteAccess: { enabled: false } }, "ios"), false);
  });
  await t.test("watch is gated independently of android, even though a phone carries both", () => {
    // android explicitly off, watch never set -> watch falls through to the
    // legacy toggle (undefined -> allowed), NOT to android's own false.
    assert.equal(remoteAccessAllowed({ remoteAccess: { android: false } }, "watch"), true);
    assert.equal(remoteAccessAllowed({ remoteAccess: { android: true, watch: false } }, "watch"), false);
  });
});

test("computeDeviceArg", async (t) => {
  await t.test("builds a real rtsp:// URL with credentials, matching this ecosystem's own verified camera recipe", () => {
    const arg = computeDeviceArg({
      sourceType: "ip",
      ipHost: "192.168.0.203",
      rtspPort: 8554,
      rtspPath: "/profile0",
      ipUsername: "admin",
      ipPassword: "admin123456",
    });
    assert.equal(arg, "rtsp://admin:admin123456@192.168.0.203:8554/profile0");
  });
  await t.test("omits the auth segment entirely when no credentials are set", () => {
    assert.equal(computeDeviceArg({ sourceType: "ip", ipHost: "10.0.0.5", rtspPort: 554, rtspPath: "/live" }), "rtsp://10.0.0.5:554/live");
  });
  await t.test("defaults the port to 554 when rtspPort is missing/invalid", () => {
    assert.equal(computeDeviceArg({ sourceType: "ip", ipHost: "10.0.0.5", rtspPort: 0 }), "rtsp://10.0.0.5:554/");
    assert.equal(computeDeviceArg({ sourceType: "ip", ipHost: "10.0.0.5" }), "rtsp://10.0.0.5:554/");
  });
  await t.test("adds a leading slash to a path that's missing one", () => {
    assert.equal(computeDeviceArg({ sourceType: "ip", ipHost: "10.0.0.5", rtspPath: "profile0" }), "rtsp://10.0.0.5:554/profile0");
  });
  await t.test("refuses an IP camera with no host, never guessing one", () => {
    assert.equal(computeDeviceArg({ sourceType: "ip", ipHost: "" }), null);
    assert.equal(computeDeviceArg({ sourceType: "ip" }), null);
  });
  await t.test("passes a real V4L2 device path through unchanged", () => {
    assert.equal(computeDeviceArg({ hardwareSource: "/dev/video0" }), "/dev/video0");
  });
  await t.test("passes a bare numeric device index through unchanged (Windows/OpenCV)", () => {
    assert.equal(computeDeviceArg({ sourceType: "usb", hardwareSource: "2" }), "2");
  });
  await t.test("extracts the real index from the legacy USB_DEV_N seed placeholder", () => {
    assert.equal(computeDeviceArg({ hardwareSource: "USB_DEV_3" }), "3");
  });
  await t.test("refuses to guess at an unrecognized hardwareSource format", () => {
    assert.equal(computeDeviceArg({ hardwareSource: "not-a-real-device" }), null);
    assert.equal(computeDeviceArg({ hardwareSource: "" }), null);
    assert.equal(computeDeviceArg({}), null);
  });
});

test("cameraFingerprint", async (t) => {
  await t.test("is stable across a connected toggle - connection identity, not on/off state", () => {
    const base = { sourceType: "ip" as const, ipHost: "10.0.0.5", rtspPort: 554, rtspPath: "/live" };
    assert.equal(cameraFingerprint({ ...base, connected: true }), cameraFingerprint({ ...base, connected: false }));
  });
  await t.test("changes when a real connection-relevant field changes", () => {
    const a = cameraFingerprint({ sourceType: "ip", ipHost: "10.0.0.5" });
    const b = cameraFingerprint({ sourceType: "ip", ipHost: "10.0.0.6" });
    assert.notEqual(a, b);
  });
});

test("cameraStreamPort", () => {
  assert.equal(cameraStreamPort(1), 8100);
  assert.equal(cameraStreamPort(2), 8101);
  assert.equal(cameraStreamPort(8), 8107);
});

test("hi3510Action", async (t) => {
  await t.test("prioritizes pan over tilt/zoom", () => {
    assert.equal(hi3510Action(-1, 5, 5), "left");
    assert.equal(hi3510Action(1, -5, -5), "right");
  });
  await t.test("prioritizes tilt over zoom when pan is neutral", () => {
    assert.equal(hi3510Action(0, 1, -5), "up");
    assert.equal(hi3510Action(0, -1, 5), "down");
  });
  await t.test("falls back to zoom when pan/tilt are both neutral", () => {
    assert.equal(hi3510Action(0, 0, 1), "zoomin");
    assert.equal(hi3510Action(0, 0, -1), "zoomout");
  });
  await t.test("reports stop only when every axis is neutral", () => {
    assert.equal(hi3510Action(0, 0, 0), "stop");
  });
});

test("safeIdSegment", async (t) => {
  await t.test("passes a normal id through unchanged", () => {
    assert.equal(safeIdSegment("192.168.0.10"), "192.168.0.10");
    assert.equal(safeIdSegment(42), "42");
  });
  await t.test("neutralizes a real path-traversal attempt", () => {
    assert.equal(safeIdSegment("../../etc/passwd"), ".._.._etc_passwd");
    assert.ok(!safeIdSegment("../../etc/passwd").includes("/"));
  });
  await t.test("never returns an empty segment", () => {
    assert.equal(safeIdSegment(""), "_");
    assert.equal(safeIdSegment(null), "_");
    assert.equal(safeIdSegment(undefined), "_");
  });
  await t.test("truncates an absurdly long id to 128 characters", () => {
    assert.equal(safeIdSegment("a".repeat(500)).length, 128);
  });
});

test("slugify", async (t) => {
  await t.test("lowercases and hyphenates a real model name", () => {
    assert.equal(slugify("My Robot!!"), "my-robot");
  });
  await t.test("trims leading/trailing hyphens", () => {
    assert.equal(slugify("--Parol6 v2--"), "parol6-v2");
  });
  await t.test("falls back to a real, non-empty default when nothing survives", () => {
    assert.equal(slugify("!!!"), "model");
    assert.equal(slugify(""), "model");
  });
});
