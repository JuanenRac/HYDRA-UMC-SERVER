// =============================================================================
// HYDRA-UMC-SERVER - Authentication matrix of every route
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Reads every route the server registers (src/server.ts and src/routes/*.ts) and proves, against the real
// running server, that none of them answers without a credential unless it is on the short list of public routes
// below, and that every route behind `requireAdmin` refuses a signed-in operator. A route added later without
// `authenticate` (or one of the access guards) fails here instead of shipping open.
//
// What it never does: it does not call the two kiosk routes that power the host off (they are checked as
// "public, direct request only" by tools/verify_hardening_contract.mjs), and it never sends a request with an
// administrator token, so nothing here can reboot, flash or change anything.

import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "matrix-admin", password: "matrix-admin-password" };
const OPERATOR = { username: "matrix-operator", password: "matrix-operator-password" };

// Routes that are public on purpose. Anything else registered without a guard is a failure.
const PUBLIC_ROUTES = new Set([
  "POST /api/login",
  "POST /api/refresh",
  "POST /api/logout",
  "GET /api/hydra-info",
  // The health of the process: answers 404 until an administrator opens it (health.open), then a HealthReport with nothing else in it.
  "GET /health",
  // The kiosk power buttons: accepted only for a direct request from the machine itself, never probed here.
  "POST /api/system/reboot",
  "POST /api/system/shutdown",
]);
const NEVER_PROBE = new Set(["POST /api/system/reboot", "POST /api/system/shutdown"]);
const GUARDS = ["authenticate", "mediaAccess", "infoAccess"];

/** Every `app.<method>("<path>", <guards...>, (req, ...` registration with the guard names it lists. */
export function scanRoutes(source) {
  const found = [];
  const pattern = /app\.(get|post|put|delete|patch)\(\s*"([^"]+)"\s*,([\s\S]*?)\(\s*_?req\b/g;
  for (const match of source.matchAll(pattern)) {
    const chain = match[3].replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " "); // a guard named in a comment is not a guard
    found.push({
      method: match[1].toUpperCase(),
      path: match[2],
      guards: GUARDS.filter((name) => new RegExp(`\\b${name}\\b`).test(chain)),
      admin: /\brequireAdmin\b/.test(chain),
    });
  }
  return found;
}

async function sourceFiles() {
  const routesDir = path.join(ROOT, "src", "routes");
  const names = (await readdir(routesDir)).filter((name) => name.endsWith(".ts")).sort();
  return [SERVER_SOURCE, ...names.map((name) => path.join(routesDir, name))];
}

async function reservePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
}

async function waitForServer(port) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/hydra-info`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become ready: ${lastError}`);
}

async function call(port, method, route, headers = {}) {
  const init = { method, headers: { "content-type": "application/json", ...headers }, redirect: "manual" };
  if (method !== "GET" && method !== "DELETE") init.body = "{}";
  const response = await fetch(`http://127.0.0.1:${port}${route}`, init);
  await response.arrayBuffer();
  return response.status;
}

async function login(port, credentials) {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
  assert.equal(response.status, 200, `login for ${credentials.username} failed`);
  return (await response.json()).token;
}

async function main() {
  const routes = [];
  for (const file of await sourceFiles()) routes.push(...scanRoutes(await readFile(file, "utf8")));
  assert(routes.length >= 40, `the scan found only ${routes.length} routes: the pattern no longer matches how routes are registered`);

  // 1. Static: a route without any guard must be a public one, and a public one must still be unguarded on purpose.
  const unguarded = routes.filter((route) => route.guards.length === 0 && !route.admin).map((route) => `${route.method} ${route.path}`);
  const unexpected = unguarded.filter((key) => !PUBLIC_ROUTES.has(key));
  assert.deepEqual(unexpected, [], `routes registered without authentication: ${unexpected.join(", ")}`);
  const stale = [...PUBLIC_ROUTES].filter((key) => !unguarded.includes(key));
  assert.deepEqual(stale, [], `the public list names routes that no longer exist or are now guarded: ${stale.join(", ")}`);
  for (const route of routes.filter((r) => r.admin)) {
    assert(route.guards.includes("authenticate"), `${route.method} ${route.path} uses requireAdmin without authenticate in front of it`);
  }

  // 2. Dynamic: the real server.
  const directory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-matrix-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await copyFile(path.join(ROOT, "package.json"), path.join(directory, "package.json"));
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: directory,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        JWT_SECRET: "route-matrix-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        HYDRA_UMC_INFO_AUTH: "required",
        HYDRA_UMC_CAMERA_AUTH: "required",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    try {
      await waitForServer(port);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
    }

    const adminToken = await login(port, ADMIN);
    const created = await fetch(`http://127.0.0.1:${port}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ ...OPERATOR, role: "operator" }),
    });
    assert.equal(created.status, 200, "the operator account for the matrix could not be created");
    const operatorToken = await login(port, OPERATOR);

    let anonymous = 0;
    let forbidden = 0;
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC_ROUTES.has(key) || NEVER_PROBE.has(key)) continue;
      const concrete = route.path.replace(/:[A-Za-z]+/g, "probe");
      const withoutToken = await call(port, route.method, concrete);
      assert.equal(withoutToken, 401, `${key} answered ${withoutToken} to an anonymous request, expected 401`);
      anonymous += 1;
      const garbage = await call(port, route.method, concrete, { authorization: "Bearer not-a-valid-token" });
      assert([401, 403].includes(garbage), `${key} answered ${garbage} to an invalid token, expected 401 or 403`);
      if (route.admin) {
        const asOperator = await call(port, route.method, concrete, { authorization: `Bearer ${operatorToken}` });
        assert.equal(asOperator, 403, `${key} answered ${asOperator} to an operator, expected 403`);
        forbidden += 1;
      }
    }
    assert(anonymous >= 35, `only ${anonymous} routes were probed anonymously`);
    assert(forbidden >= 15, `only ${forbidden} admin routes were probed as an operator`);
    console.log(`SERVER_ROUTE_AUTH_MATRIX=PASS routes=${routes.length} public=${PUBLIC_ROUTES.size} anonymous-denied=${anonymous} operator-denied-on-admin=${forbidden}`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("SERVER_ROUTE_AUTH_MATRIX=FAIL", error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
