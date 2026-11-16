// =============================================================================
// HYDRA-UMC-SERVER - Tests of the environment lines of the systemd unit
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Without its settings file the unit must not start the server in development mode (secret from the source, any origin, default administrator account, every interface).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const unit = fs.readFileSync(new URL("../systemd/hydra-umc-server.service", import.meta.url), "utf8");
const lines = unit.split(/\r?\n/);

test("the unit sets NODE_ENV=production itself", () => {
  assert.ok(lines.includes("Environment=NODE_ENV=production"), "Environment=NODE_ENV=production is missing");
  assert.ok(!lines.some((line) => /^Environment=.*NODE_ENV=(?!production\b)/.test(line)), "another NODE_ENV value is set");
});

test("the settings file is required: the EnvironmentFile line has no leading dash", () => {
  const files = lines.filter((line) => line.startsWith("EnvironmentFile="));
  assert.deepEqual(files, ["EnvironmentFile=/etc/hydra-umc/server.env"]);
});

test("the environment file is read after the default so that the file keeps the last word", () => {
  const defaultAt = lines.indexOf("Environment=NODE_ENV=production");
  const fileAt = lines.findIndex((line) => line.startsWith("EnvironmentFile="));
  assert.ok(defaultAt >= 0 && fileAt > defaultAt);
});
