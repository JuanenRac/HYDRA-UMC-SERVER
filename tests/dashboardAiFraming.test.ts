// =============================================================================
// HYDRA-UMC-SERVER - tests/dashboardAiFraming.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The AI dashboard served at /dashboard-ai may be framed by a page of the same origin (the panel of STUDIO) and by no other.
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { registerStaticRoutes } from "../src/routes/staticRoutes";

test("the AI dashboard may be framed by its own origin only, and the rest of the server is not affected", async () => {
  const previous = process.cwd();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-umc-server-framing-"));
  fs.mkdirSync(path.join(work, "public", "dashboard-ai"), { recursive: true });
  fs.mkdirSync(path.join(work, "data"), { recursive: true });
  fs.writeFileSync(path.join(work, "public", "dashboard-ai", "index.html"), "<!doctype html><title>dashboard</title>");
  fs.writeFileSync(path.join(work, "public", "index.html"), "<!doctype html><title>studio</title>");
  process.chdir(work);
  const app = express();
  registerStaticRoutes(app, { dataPath: path.join(work, "data") });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const page = await fetch(`http://127.0.0.1:${port}/dashboard-ai/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'self'");
    assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
    const asset = await fetch(`http://127.0.0.1:${port}/dashboard-ai/index.html?embed=1`);
    assert.equal(asset.headers.get("content-security-policy"), "frame-ancestors 'self'");
  } finally {
    server.close();
    process.chdir(previous);
    fs.rmSync(work, { recursive: true, force: true });
  }
});
