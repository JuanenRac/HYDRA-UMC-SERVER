import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveLogKeep, resolveLogMaxBytes, rotateLogFiles } from "../src/logRotation.ts";

test("rotation settings fall back to the single-file behaviour", () => {
  assert.equal(resolveLogKeep(undefined), 1);
  assert.equal(resolveLogKeep(""), 1);
  assert.equal(resolveLogKeep("0"), 1);
  assert.equal(resolveLogKeep("abc"), 1);
  assert.equal(resolveLogKeep("5"), 5);
  assert.equal(resolveLogKeep("5000"), 50);
  assert.equal(resolveLogMaxBytes(undefined), 10 * 1024 * 1024);
  assert.equal(resolveLogMaxBytes("12"), 10 * 1024 * 1024);
  assert.equal(resolveLogMaxBytes("2097152"), 2097152);
});

test("with keep = 1 only the previous file survives", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-log-"));
  const file = path.join(dir, "server.log");
  fs.writeFileSync(file, "new");
  fs.writeFileSync(`${file}.1`, "old");
  rotateLogFiles(file, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "new");
  assert.equal(fs.existsSync(`${file}.2`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with keep = 3 the history shifts and the oldest file is dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-log-"));
  const file = path.join(dir, "server.log");
  for (let generation = 1; generation <= 5; generation += 1) {
    fs.writeFileSync(file, `g${generation}`);
    rotateLogFiles(file, 3);
  }
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "g5");
  assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "g4");
  assert.equal(fs.readFileSync(`${file}.3`, "utf8"), "g3");
  assert.equal(fs.existsSync(`${file}.4`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
