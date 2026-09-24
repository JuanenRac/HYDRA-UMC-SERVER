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
import { SCHEMAS, RESPONSES, REQUESTS, errorResponse, jsonContent } from "./openapi_types.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "docs", "openapi.json");
const ROUTE = /^[ \t]*app\.(get|post|put|patch|delete)\(\s*(["'`])(\/[^"'`]+)\2\s*,([\s\S]*?)(?:async\s+)?\(\s*req\b/gm;

function sourceFiles() {
  const dir = path.join(root, "src");
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path.join(dir, entry.name));
    // Route modules live one level down (src/routes/).
    if (entry.isDirectory() && entry.name === "routes") {
      for (const f of fs.readdirSync(path.join(dir, "routes"))) if (f.endsWith(".ts")) files.push(path.join(dir, "routes", f));
    }
  }
  return files.sort();
}

// Plain code-unit order: localeCompare varies with the ICU version of the
// Node that runs this, and the output must be identical everywhere.
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const STATUS_TEXT = {
  200: "Success",
  201: "Created",
  204: "No content",
  400: "Invalid request",
  401: "Not signed in or token rejected",
  403: "Signed in but not allowed",
  404: "Not found",
  409: "Conflict with the current state",
  413: "Payload too large",
  429: "Rate limited",
  500: "Server error",
  502: "Upstream service rejected the request",
  503: "Not configured or unavailable",
};

// What the handler's own source reveals: the status codes it can answer with,
// the JSON body fields it reads, and the query parameters it reads. Names
// only - types and validation live in the handler, and the prose contract in
// docs/REMOTE_API.md stays the reference for values.
function inspectHandler(text) {
  const statuses = new Set();
  for (const m of text.matchAll(/res\s*\.\s*status\(\s*(\d{3})\s*\)/g)) statuses.add(Number(m[1]));
  for (const m of text.matchAll(/res\s*\.\s*sendStatus\(\s*(\d{3})\s*\)/g)) statuses.add(Number(m[1]));
  if (/res\s*\.\s*(json|send|end|download|sendFile)\(/.test(text) && ![...statuses].some((c) => c < 300)) statuses.add(200);
  const body = new Set();
  for (const m of text.matchAll(/req\.body\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) body.add(m[1]);
  for (const m of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*\(?\s*req\.body/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(":")[0].split("=")[0].trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) body.add(name);
    }
  }
  const query = new Set();
  for (const m of text.matchAll(/req\.query\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) query.add(m[1]);
  return { statuses: [...statuses].sort((a, b) => a - b), body: [...body].sort(compare), query: [...query].sort(compare) };
}

function collectRoutes() {
  const routes = new Map();
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, "utf8");
    const matches = [...text.matchAll(ROUTE)];
    matches.forEach((m, i) => {
      const [, method, , route, rest] = m;
      // Express path params (:id) become OpenAPI templates ({id}).
      const templated = route.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      const access = /requireAdmin/.test(rest) ? "admin" : /authenticate/.test(rest) ? "user" : "public";
      // The handler ends at the first line that closes the call at the same
      // indentation the route was registered at; if there is none, at the
      // next route. Reading on to the next route would credit a handler with
      // the status codes of whatever code follows it.
      const nextRoute = i + 1 < matches.length ? matches[i + 1].index : text.length;
      const indent = /^[ 	]*/.exec(m[0])[0];
      const closing = new RegExp("^" + indent + "\\}\\);[ \\t]*$", "m").exec(text.slice(m.index + m[0].length));
      const handlerEnd = closing ? Math.min(nextRoute, m.index + m[0].length + closing.index) : nextRoute;
      const handler = text.slice(m.index + m[0].length, handlerEnd);
      routes.set(`${method} ${templated}`, {
        method,
        path: templated,
        access,
        rateLimited: /RateLimiter/.test(rest),
        ...inspectHandler(handler),
      });
    });
  }
  return [...routes.values()].sort((a, b) => compare(a.path, b.path) || compare(a.method, b.method));
}

function apiVersion() {
  const source = fs.readFileSync(path.join(root, "src", "server.ts"), "utf8");
  const match = /const REMOTE_API_VERSION\s*=\s*(\d+)/.exec(source);
  return match ? match[1] : "1";
}

function buildDocument() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const paths = {};
  const routes = collectRoutes();
  const known = new Set(routes.map((r) => `${r.method.toUpperCase()} ${r.path}`));
  for (const key of [...Object.keys(RESPONSES), ...Object.keys(REQUESTS)]) {
    if (!known.has(key)) throw new Error(`tools/openapi_types.mjs describes ${key}, which is not a registered route`);
  }
  for (const r of routes) {
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
      responses: Object.fromEntries(
        (r.statuses.length ? r.statuses : [200]).map((code) => [
          String(code),
          { description: `${STATUS_TEXT[code] ?? "Response"}. The body is documented in docs/REMOTE_API.md.` },
        ]),
      ),
    };
    const key = `${r.method.toUpperCase()} ${r.path}`;
    for (const [code, response] of Object.entries(operation.responses)) {
      if (Number(code) >= 400) response.content = jsonContent(errorResponse);
      else if (code === "200" && RESPONSES[key]) response.content = jsonContent(RESPONSES[key]);
    }
    for (const name of r.query) params.push({ name, in: "query", required: false, schema: { type: "string" } });
    if (params.length) operation.parameters = params;
    if (REQUESTS[key]) {
      operation.requestBody = {
        required: REQUESTS[key].required.length > 0,
        content: jsonContent({ type: "object", required: REQUESTS[key].required, properties: REQUESTS[key].fields }),
      };
    } else if (r.body.length && r.method !== "get" && r.method !== "delete") {
      operation.requestBody = {
        required: false,
        description: "JSON body. Only the field names the handler reads are listed; types and limits are checked in the handler.",
        content: { "application/json": { schema: { type: "object", properties: Object.fromEntries(r.body.map((n) => [n, {}])) } } },
      };
    }
    if (r.access !== "public") operation.security = [{ bearerAuth: [] }];
    if (r.rateLimited) operation["x-rate-limited"] = true;
    (paths[r.path] ??= {})[r.method] = operation;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "HYDRA-UMC-SERVER API",
      // The API contract version, not the package version: a routine version
      // bump must not make the committed file stale.
      version: apiVersion(),
      description:
        "Generated from the routes registered in src/. It lists paths, methods, required access, the status codes each handler can return, and the names of the JSON body fields and query parameters it reads. Routes with a stable shape carry typed request and response schemas; the others are described in docs/REMOTE_API.md.",
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } }, schemas: SCHEMAS },
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
