import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// The container bench runs on the pull requests that touch what its scenarios cover: pinned by commit, never on a push, with a list of paths and a
// concurrency group that cancels the run of an earlier push to the same pull request.

const text = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "container-bench.yml"), "utf8").replace(/\r\n/g, "\n");

test("the called workflow is pinned by a full commit hash of HYDRA-UMC-DEV-SERVER", () => {
  assert.match(text, /uses: JuanenRac\/HYDRA-UMC-DEV-SERVER\/\.github\/workflows\/server-bench\.yml@[0-9a-f]{40}\n/);
});

test("it starts on a pull request with a list of paths, by hand, and never on a push", () => {
  assert.match(text, /^on:\n  pull_request:\n    paths:\n/m);
  assert.match(text, /^  workflow_dispatch:\n/m);
  assert.doesNotMatch(text, /^  push:/m);
  for (const covered of ["src/server.ts", "src/auth.ts", "src/routes/**", "scripts/Dockerfile", "package-lock.json"]) assert.ok(text.includes(`- "${covered}"`), covered);
});

test("it builds the head of the pull request and cancels an earlier run of the same pull request but never main", () => {
  assert.match(text, /server_ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(text, /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' && !startsWith\(github\.ref, 'refs\/tags\/'\) \}\}/);
  assert.match(text, /permissions:\n  contents: read\n/);
});
