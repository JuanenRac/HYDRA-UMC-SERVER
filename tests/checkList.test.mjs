// The list of contract checks that `npm test` runs (tools/checks.json): none is left out, none is named twice, every one exists, and a
// failing check does not hide the ones after it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readChecks, runAll, summary } from "../tools/run_checks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every verify script is run by npm test or named in not_run with its reason", () => {
  const { checks, not_run: notRun = {} } = readChecks();
  const onDisk = readdirSync(path.join(ROOT, "tools")).filter((f) => /^verify_.*\.mjs$/.test(f)).map((f) => `tools/${f}`);
  for (const file of onDisk) {
    assert.ok(checks.includes(file) || typeof notRun[file] === "string" && notRun[file].length > 10, `${file} is neither run nor excused`);
  }
});

test("the list has no file twice and every file exists", () => {
  const { checks } = readChecks();
  assert.equal(new Set(checks).size, checks.length);
  for (const file of checks) assert.ok(existsSync(path.join(ROOT, file)), `${file} does not exist`);
});

test("npm test runs the list through the runner and no longer chains the scripts", () => {
  const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  assert.match(scripts.test, /node tools\/run_checks\.mjs/);
  assert.doesNotMatch(scripts.test, /node tools\/verify_/);
});

test("a check that fails does not hide the ones after it, and the summary names it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "run-checks-"));
  try {
    mkdirSync(path.join(dir, "tools"));
    writeFileSync(path.join(dir, "tools", "a.mjs"), "process.exit(0);\n");
    writeFileSync(path.join(dir, "tools", "b.mjs"), "process.exit(3);\n");
    writeFileSync(path.join(dir, "tools", "c.mjs"), "process.exit(0);\n");
    const results = runAll(["tools/a.mjs", "tools/b.mjs", "tools/c.mjs"], { cwd: dir });
    assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
    const text = summary(results);
    assert.match(text, /FAIL {2}tools\/b\.mjs/);
    assert.match(text, /CHECKS=FAIL 1 of 3: tools\/b\.mjs/);
    assert.match(summary(results.filter((r) => r.ok)), /CHECKS=PASS 2\/2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a check that cannot end in time is a failure, not a hang", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "run-checks-"));
  try {
    mkdirSync(path.join(dir, "tools"));
    writeFileSync(path.join(dir, "tools", "slow.mjs"), "setTimeout(() => {}, 60000);\n");
    const results = runAll(["tools/slow.mjs"], { cwd: dir, timeoutMs: 300 });
    assert.equal(results[0].ok, false);
    assert.match(results[0].status, /timed out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
