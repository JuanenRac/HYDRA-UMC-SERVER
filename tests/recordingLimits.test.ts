import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { test } from "node:test";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig.ts";
import { DEFAULT_RECORDING_LIMITS, directorySize, MjpegFrameCounter, recordingStopReason } from "../src/recordingLimits.ts";

function part(payload: string): Buffer {
  return Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${payload.length}\r\n\r\n${payload}\r\n`, "latin1");
}

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: () => {} });
  return { config, stored: () => stored };
}

test("a recording stops at its time, its size and the quota, and goes on below them", () => {
  const limits = { ...DEFAULT_RECORDING_LIMITS, maxSeconds: 10, maxBytes: 1000, quotaBytes: 5000 };
  assert.equal(recordingStopReason(limits, 9_999, 999, 3000), "");
  assert.equal(recordingStopReason(limits, 10_000, 0, 0), "duration");
  assert.equal(recordingStopReason(limits, 0, 1000, 0), "size");
  assert.equal(recordingStopReason(limits, 0, 500, 4500), "quota");
  assert.equal(recordingStopReason({ ...limits, enabled: false }, 1e9, 1e12, 1e12), "");
  assert.deepEqual(DEFAULT_RECORDING_LIMITS, { enabled: true, maxSeconds: 600, maxBytes: 500_000_000, quotaBytes: 5_000_000_000 });
});

test("the frames are counted while the bytes arrive, even when a frame is cut between two chunks", () => {
  const stream = Buffer.concat([part("aaaa"), part("bb"), part("cccccc")]);
  const counter = new MjpegFrameCounter();
  for (let i = 0; i < stream.length; i += 7) counter.push(stream.subarray(i, i + 7));
  assert.equal(counter.frames, 3);
  assert.equal(counter.broken, false);
  const whole = new MjpegFrameCounter();
  whole.push(stream);
  assert.equal(whole.frames, 3);
});

test("a part without a Content-Length makes the count untrusted and nothing is counted after it", () => {
  const counter = new MjpegFrameCounter();
  counter.push(part("aa"));
  counter.push(Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\nxx", "latin1"));
  counter.push(part("bb"));
  assert.equal(counter.broken, true);
  assert.equal(counter.frames, 1);
});

test("the size of a folder counts the files below it and is 0 for a folder that is not there", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  try {
    fs.mkdirSync(path.join(root, "1", "recordings"), { recursive: true });
    fs.writeFileSync(path.join(root, "1", "recordings", "a.mjpeg"), Buffer.alloc(100));
    fs.writeFileSync(path.join(root, "b.jpg"), Buffer.alloc(23));
    assert.equal(directorySize(root), 123);
    assert.equal(directorySize(path.join(root, "nothing")), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the limits are an option of Server Admin, on by default, with whole-number values checked and defaults used for a value that is off", () => {
  const { config, stored } = makeConfig();
  assert.deepEqual(config.cameraRecordingLimits(), DEFAULT_RECORDING_LIMITS);
  assert.deepEqual(config.snapshot().camera.limitRecordings, { value: true, source: "default" });
  assert.deepEqual(config.update({ camera: { limitRecordings: false } }, "root").warnings, ["camera_recordings_unlimited"]);
  assert.equal(config.cameraRecordingLimits().enabled, false);
  config.update({ camera: { limitRecordings: true, recordingMaxSeconds: 60, recordingMaxBytes: 2_000_000, recordingQuotaBytes: 50_000_000 } }, "root");
  assert.deepEqual(config.cameraRecordingLimits(), { enabled: true, maxSeconds: 60, maxBytes: 2_000_000, quotaBytes: 50_000_000 });
  assert.deepEqual(stored().camera, { limitRecordings: true, recordingMaxSeconds: 60, recordingMaxBytes: 2_000_000, recordingQuotaBytes: 50_000_000 });
  const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
  for (const value of [0, -5, 1.5, "600", null, 1e15]) assert.throws(() => config.update({ camera: { recordingMaxSeconds: value } }, "root"), bad400);
  assert.throws(() => config.update({ camera: { limitRecordings: "no" } }, "root"), bad400);
  const fromFile = makeConfig({}, { camera: { recordingMaxSeconds: 5 as number, recordingMaxBytes: -1 as number } });
  assert.equal(fromFile.config.cameraRecordingLimits().maxSeconds, 5);
  assert.equal(fromFile.config.cameraRecordingLimits().maxBytes, 500_000_000, "a value in the file that is out of range falls back to the default");
  const locked = makeConfig({ cameraLimitRecordings: "off" });
  assert.equal(locked.config.cameraRecordingLimits().enabled, false);
  assert.throws(() => locked.config.update({ camera: { limitRecordings: true } }, "root"), (e) => e instanceof SecurityConfigError && e.status === 409);
});
