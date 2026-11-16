import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { currentBootId, pidsToReap, processStartTicks, serializeCameraPidFile } from "../src/cameraPidFile.ts";

// a /proc of its own: the boot identifier and, for every process, a stat line whose command name holds a space and a bracket
function fakeProc(bootId: string | null, processes: Record<number, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fakeproc-"));
  if (bootId !== null) {
    fs.mkdirSync(path.join(root, "sys", "kernel", "random"), { recursive: true });
    fs.writeFileSync(path.join(root, "sys", "kernel", "random", "boot_id"), bootId + "\n");
  }
  for (const [pid, start] of Object.entries(processes)) {
    fs.mkdirSync(path.join(root, pid));
    const fields = Array.from({ length: 30 }, (_v, i) => String(i));
    fields[18] = start; // field 22 of the line (the state, field 3, comes before the list)
    fs.writeFileSync(path.join(root, pid, "stat"), `${pid} (stream (serve) x) S ${fields.join(" ")}\n`);
  }
  return root;
}

test("the start time is field 22 even when the name of the command holds brackets", () => {
  const root = fakeProc("b1", { 4242: "123456" });
  assert.equal(processStartTicks(4242, root), "123456");
  assert.equal(processStartTicks(99, root), null);
  assert.equal(currentBootId(root), "b1");
});

test("a process of this boot with the written start time is stopped, another one with the same number is not", () => {
  const root = fakeProc("b1", { 4242: "123456" });
  const written = JSON.parse(serializeCameraPidFile([4242], root));
  assert.deepEqual(written, { bootId: "b1", entries: [{ pid: 4242, start: "123456" }] });
  assert.deepEqual(pidsToReap(written, () => true, root), [4242]);
  // the number was reused by a process that started later
  const reused = fakeProc("b1", { 4242: "999999" });
  assert.deepEqual(pidsToReap(written, () => true, reused), []);
  // a process that is not alive is not stopped
  assert.deepEqual(pidsToReap(written, () => false, root), []);
});

test("a file from before a reboot, and the old format with numbers only, stop nothing on Linux", () => {
  const root = fakeProc("b2", { 4242: "123456" });
  const before = { bootId: "b1", entries: [{ pid: 4242, start: "123456" }] };
  assert.deepEqual(pidsToReap(before, () => true, root), []);
  assert.deepEqual(pidsToReap([4242], () => true, root), []);
});

test("without /proc the numbers are used as before, and a number that is not a process is ignored", () => {
  const none = fakeProc(null, {});
  const written = JSON.parse(serializeCameraPidFile([4242], none));
  assert.deepEqual(written, { bootId: null, entries: [{ pid: 4242, start: null }] });
  assert.deepEqual(pidsToReap(written, () => true, none), [4242]);
  assert.deepEqual(pidsToReap([4242, 1, 0, -5, 1.5, "x"], () => true, none), [4242]);
  assert.deepEqual(pidsToReap("not a list", () => true, none), []);
});
