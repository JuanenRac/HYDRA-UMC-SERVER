// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the route scanner of tools/verify_route_auth_matrix.mjs
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The matrix check is only as good as its reading of how routes are registered. These tests pin that reading
// to the shapes the server really uses, so a change of style cannot make the scan quietly find fewer routes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { scanRoutes } from "../tools/verify_route_auth_matrix.mjs";

test("a route with no guard is reported with an empty guard list", () => {
  const [route] = scanRoutes(`app.get("/api/open", (req, res) => { res.json({}); });`);
  assert.deepEqual(route, { method: "GET", path: "/api/open", guards: [], admin: false });
});

test("authenticate, the media and info guards and requireAdmin are told apart", () => {
  const routes = scanRoutes(`
    app.post("/api/a/:id", authenticate, requireAdmin, async (req, res) => {});
    app.get("/api/camera/:id/stream", mediaAccess, async (req, res) => {});
    app.get("/metrics", infoAccess, async (req, res) => {});
    app.delete("/api/d", authenticate, (req, res) => {});
  `);
  assert.deepEqual(routes.map((r) => [r.method, r.path, r.guards, r.admin]), [
    ["POST", "/api/a/:id", ["authenticate"], true],
    ["GET", "/api/camera/:id/stream", ["mediaAccess"], false],
    ["GET", "/metrics", ["infoAccess"], false],
    ["DELETE", "/api/d", ["authenticate"], false],
  ]);
});

test("a registration split over several lines, with a rate limiter in the chain, is still read", () => {
  const [route] = scanRoutes(`app.post(
    "/api/stop-all",
    authenticate,
    stopAllRateLimiter ?? ((_req: any, _res: any, next: any) => next()),
    async (req, res) => {});`);
  assert.equal(route.path, "/api/stop-all");
  assert.deepEqual(route.guards, ["authenticate"]);
});

test("a guard named only in a comment or a longer identifier does not count", () => {
  const [route] = scanRoutes(`app.get("/api/x", /* authenticate */ unauthenticatedHelper, (req, res) => {});`);
  assert.deepEqual(route.guards, []);
});

test("the scan finds every route the server registers (a style change must not hide routes)", async () => {
  const files = ["src/server.ts", "src/routes/adminRoutes.ts", "src/routes/cameraRoutes.ts", "src/routes/commandRoutes.ts"];
  let found = 0;
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const registered = (source.match(/\bapp\.(get|post|put|delete|patch)\(/g) ?? []).length;
    const scanned = scanRoutes(source).length;
    assert.equal(scanned, registered, `${file}: ${registered} registrations but the scan read ${scanned}`);
    found += scanned;
  }
  assert(found >= 30);
});
