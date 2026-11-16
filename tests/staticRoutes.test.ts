// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for src/routes/staticRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The static mounts over a real express app on a free port: the sensitive files of data/ stay hidden whatever the spelling of the address,
// a damaged address is refused, and the front ends are served only when their folders exist.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { RESERVED_DATA_FILENAMES, registerStaticRoutes, staticDataRoots } from "../src/routes/staticRoutes";

const originalCwd = process.cwd();

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A GET that keeps the address exactly as written (fetch would tidy dots and slashes before sending). */
function raw(port: number, target: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: target, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function withServer(work: (port: number, root: string) => Promise<void>, frontends: boolean, options: { settings?: unknown } = {}): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "static-routes-"));
  const dataPath = path.join(root, "data");
  write(path.join(dataPath, "WORKS", "a.json"), '{"ok":true}');
  for (const name of RESERVED_DATA_FILENAMES) write(path.join(dataPath, name), "secret-free placeholder");
  write(path.join(dataPath, "logs", "x.txt"), "log");
  write(path.join(dataPath, "points", "p.json"), "points");
  write(path.join(dataPath, "backups", "b.json"), "backup");
  write(path.join(dataPath, ".txn", "t.json"), "transaction");
  write(path.join(dataPath, "audit.jsonl"), '{"user":"x"}');
  write(path.join(dataPath, "audit-0000000001.jsonl"), '{"user":"x"}');
  write(path.join(dataPath, "totp.json"), "{}");
  write(path.join(dataPath, "connections.json"), "{}");
  write(path.join(dataPath, "device-tokens.json"), "{}");
  write(path.join(dataPath, "camera-media", "1", "snapshots", "a.jpg"), "jpg");
  write(path.join(dataPath, "models", "submitted", "m.stl"), "stl");
  write(path.join(dataPath, "index.html"), "<script>stolen()</script>");
  write(path.join(dataPath, "WORKS", "page.html"), "<script>x()</script>");
  write(path.join(dataPath, "WORKS", ".hidden.json"), "{}");
  write(path.join(dataPath, "custom", "robot1", "b.json"), '{"ok":true}');
  if (frontends) {
    write(path.join(root, "public", "index.html"), "<title>studio</title>");
    write(path.join(root, "public", "dashboard-ai", "index.html"), "<title>ai</title>");
    write(path.join(root, "public", "admin", "index.html"), "<title>admin</title>");
  }
  process.chdir(root);
  const app = express();
  registerStaticRoutes(app, { dataPath, getSettings: () => options.settings });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await work((server.address() as AddressInfo).port, root);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a work file is served and the reserved files are hidden under every spelling", async () => {
  await withServer(async (port) => {
    assert.equal((await raw(port, "/WORKS/a.json")).status, 200);
    const spellings = ["/settings.json", "/%73ettings.json", "//settings.json", "/Settings.json", "/./settings.json", "/%2e/settings.json", "/WORKS/../users.json", "/model_submissions.json", "/refresh_tokens.json", "/server-config.json", "/store-meta.json", "/safety-limits.json"];
    for (const spelling of spellings) assert.equal((await raw(port, spelling)).status, 404, spelling);
  }, false);
});

test("the folders that are never public answer not found, deep files included", async () => {
  await withServer(async (port) => {
    for (const target of ["/logs/x.txt", "/LOGS/x.txt", "/points/p.json", "/backups/b.json", "/.txn/t.json", "/logs", "/points/"]) {
      assert.equal((await raw(port, target)).status, 404, target);
    }
  }, false);
});

test("a damaged percent-encoding is refused, not guessed", async () => {
  await withServer(async (port) => {
    for (const target of ["/%E0%A4%A", "/%", "/%zz/settings.json"]) assert.equal((await raw(port, target)).status, 400, target);
  }, false);
});

test("without the built front ends nothing is served at the root, the admin or the AI dashboard", async () => {
  await withServer(async (port) => {
    for (const target of ["/", "/admin/", "/dashboard-ai/"]) assert.equal((await raw(port, target)).status, 404, target);
  }, false);
});

test("with the built front ends they are served, and the AI dashboard may be framed only by its own origin", async () => {
  await withServer(async (port) => {
    const studio = await raw(port, "/");
    assert.equal(studio.status, 200);
    assert.match(studio.body, /studio/);
    const admin = await raw(port, "/admin/");
    assert.equal(admin.status, 200);
    assert.match(admin.body, /admin/);
    const dashboard = await raw(port, "/dashboard-ai/");
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.body, /ai/);
    assert.equal(dashboard.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(dashboard.headers["content-security-policy"], "frame-ancestors 'self'");
    assert.equal(studio.headers["x-frame-options"], undefined);
    assert.equal((await raw(port, "/admin")).status, 301);
  }, true);
});

test("the list of reserved files holds only bare names in lower case", () => {
  assert.ok(RESERVED_DATA_FILENAMES.size >= 7);
  for (const name of RESERVED_DATA_FILENAMES) {
    assert.equal(name, name.toLowerCase());
    assert.ok(!name.includes("/") && !name.includes("\\"), name);
  }
});

test("only the folders of the works are served: the state of the server in data/ is private, whatever its name", async () => {
  await withServer(async (port) => {
    for (const target of ["/audit.jsonl", "/audit-0000000001.jsonl", "/totp.json", "/connections.json", "/device-tokens.json", "/camera-media/1/snapshots/a.jpg", "/models/submitted/m.stl", "/%61udit.jsonl", "/AUDIT.JSONL"]) {
      assert.equal((await raw(port, target)).status, 404, target);
    }
    assert.equal((await raw(port, "/WORKS/a.json")).status, 200);
    assert.equal((await raw(port, "/works/a.json")).status, 200);
    assert.equal((await raw(port, "/custom/robot1/b.json")).status, 404, "a folder that no worksPaths names is not served");
  }, false);
});

test("a page left in data/ does not become the home page, and a file of the works that a browser would run is served as plain text", async () => {
  await withServer(async (port) => {
    assert.equal((await raw(port, "/")).status, 404, "data/index.html is not served at the root");
    assert.equal((await raw(port, "/index.html")).status, 404);
    const page = await raw(port, "/WORKS/page.html");
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"]), /^text\/plain/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal((await raw(port, "/WORKS/a.json")).headers["x-content-type-options"], "nosniff");
    assert.equal((await raw(port, "/WORKS/.hidden.json")).status, 404, "a dot file is never served");
  }, false);
});

test("the folders of settings.worksPaths are served too, and nothing that tries to leave them", async () => {
  await withServer(async (port) => {
    assert.equal((await raw(port, "/custom/robot1/b.json")).status, 200);
    assert.equal((await raw(port, "/audit.jsonl")).status, 404);
  }, false, { settings: { worksPaths: { "1": "custom/robot1", "2": "../outside", "3": ".hidden/x", "4": 7 } } });
});

test("the roots that may be served come from WORKS and the first folder of each path of the settings, never from a dot or a parent folder", () => {
  assert.deepEqual([...staticDataRoots(undefined)], ["works"]);
  assert.deepEqual([...staticDataRoots({ worksPaths: { a: "Custom/robot1", b: "/other/x", c: "../up", d: ".h", e: "", f: 3, g: "a\\b" } })].sort(), ["a", "custom", "other", "works"]);
  assert.deepEqual([...staticDataRoots({ worksPaths: "no" })], ["works"]);
});
