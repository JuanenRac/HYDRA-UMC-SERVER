// =============================================================================
// HYDRA-UMC-SERVER - tools/run_checks.mjs
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Runs every contract check of tools/checks.json one after the other and does NOT stop at the first one that fails: a chain
// joined with && hides every check after the failure and says nothing about which ones were left out. Each check is a node
// script that exits 0 when it passes. The summary names every check with its result; the exit status is 1 when any failed.
//
//   node tools/run_checks.mjs            run all of them
//   node tools/run_checks.mjs --list     print the names, run nothing
//   node tools/run_checks.mjs --only X   run the checks whose name contains X

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The longest a single check may run, in milliseconds. */
export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** The checks of the list file, in order. */
export function readChecks(file = path.join(ROOT, "tools", "checks.json")) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.checks) || parsed.checks.some((c) => typeof c !== "string")) {
    throw new Error("checks.json needs a list of file names under \"checks\"");
  }
  return parsed;
}

/** Runs [files] (paths relative to [cwd]); every one runs. Returns [{ file, ok, status, seconds }]. */
export function runAll(files, { cwd = ROOT, timeoutMs = CHECK_TIMEOUT_MS, log = () => {} } = {}) {
  const results = [];
  for (const file of files) {
    log(`--- ${file}`);
    const started = Date.now();
    const done = spawnSync(process.execPath, [file], { cwd, stdio: "inherit", timeout: timeoutMs });
    const ok = done.status === 0 && !done.error;
    const status = done.error ? `could not run or timed out: ${done.error.message}` : `exit ${done.status}`;
    results.push({ file, ok, status, seconds: Math.round((Date.now() - started) / 100) / 10 });
  }
  return results;
}

/** The text of the summary: one line per check, then the verdict. */
export function summary(results) {
  const lines = results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.file}  (${r.seconds}s${r.ok ? "" : `, ${r.status}`})`);
  const failed = results.filter((r) => !r.ok);
  lines.push(failed.length === 0 ? `CHECKS=PASS ${results.length}/${results.length}` : `CHECKS=FAIL ${failed.length} of ${results.length}: ${failed.map((r) => r.file).join(", ")}`);
  return lines.join("\n");
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: node tools/run_checks.mjs [--list] [--only NAME]  (runs every check of tools/checks.json and reports all of them)");
    return 0;
  }
  const { checks } = readChecks();
  if (argv.includes("--list")) {
    console.log(checks.join("\n"));
    return 0;
  }
  const only = argv.indexOf("--only");
  const wanted = only >= 0 ? checks.filter((c) => c.includes(argv[only + 1] ?? "")) : checks;
  if (wanted.length === 0) {
    console.error("CHECKS=FAIL no check matches");
    return 1;
  }
  const results = runAll(wanted, { log: (line) => console.log(line) });
  console.log(`\n${summary(results)}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
