#!/usr/bin/env node
// =============================================================================
// HYDRA-UMC-SERVER - tools/generate_openapi.mjs
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Builds docs/openapi.json from the routes this server really registers, by
// reading every `app.<method>("<path>", ...)` call in src/. It is a route
// inventory: path, method, tag and the access each route demands (public,
// any signed-in user, or admin role). Request and response bodies are NOT
// described - the prose contract for those stays in docs/REMOTE_API.md.
//
//   node tools/generate_openapi.mjs           rewrite docs/openapi.json
//   node tools/generate_openapi.mjs --check   fail if the file is out of date
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "docs", "openapi.json");
const ROUTE = /^[ \t]*app\.(get|post|put|patch|delete)\(\s*(["'`])(\/[^"'`]+)\2\s*,([\s\S]*?)(?:async\s+)?\(\s*req\b/gm;

function sourceFiles() {
  const dir = path.join(root, "src");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).sort().map((f) => path.join(dir, f));
}

function collectRoutes() {
  const routes = new Map();
  for (const file of sourceFiles()) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(ROUTE)) {
      const [, method, , route, rest] = m;
      // Express path params (:id) become OpenAPI templates ({id}).
      const templated = route.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      const access = /requireAdmin/.test(rest) ? "admin" : /authenticate/.test(rest) ? "user" : "public";
      routes.set(`${method} ${templated}`, { method, path: templated, access, rateLimited: /RateLimiter/.test(rest) });
    }
  }
  return [...routes.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function buildDocument() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const paths = {};
  for (const r of collectRoutes()) {
    const params = [...r.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((p) => ({
      name: p[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const operation = {
      tags: [r.path.startsWith("/api/") ? r.path.split("/")[2] : r.path.split("/")[1]],
      summary: `${r.method.toUpperCase()} ${r.path}`,
      description:
        r.access === "admin"
          ? "Requires a signed-in account with the admin role."
          : r.access === "user"
            ? "Requires a signed-in account (bearer token)."
            : "No authentication required by the route itself.",
      "x-access": r.access,
      responses: { "200": { description: "Success. The body is documented in docs/REMOTE_API.md." } },
    };
    if (params.length) operation.parameters = params;
    if (r.access !== "public") operation.security = [{ bearerAuth: [] }];
    if (r.rateLimited) operation["x-rate-limited"] = true;
    (paths[r.path] ??= {})[r.method] = operation;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "HYDRA-UMC-SERVER API",
      version: pkg.version,
      description:
        "Route inventory generated from the routes registered in src/. It lists paths, methods and required access only; request and response bodies are described in docs/REMOTE_API.md.",
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    paths,
  };
}

const rendered = JSON.stringify(buildDocument(), null, 2) + "\n";
if (process.argv.includes("--check")) {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== rendered) {
    console.error("docs/openapi.json is out of date - run: node tools/generate_openapi.mjs");
    process.exit(1);
  }
  console.log("openapi.json is up to date");
} else {
  fs.writeFileSync(outFile, rendered);
  console.log(`wrote ${path.relative(root, outFile)} (${Object.keys(JSON.parse(rendered).paths).length} paths)`);
}
