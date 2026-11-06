#!/usr/bin/env node
// =============================================================================
// HYDRA-UMC-SERVER - tools/verify_sdk_contract.mjs
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Contract test against the published SDK contract (contracts/openapi/v1/server.openapi.json).
// Every route the SDK promises to its clients must exist in docs/openapi.json (the inventory generated
// from the routes this server really registers) with the same method, the same kind of access (public
// or signed in) and every status code the handler itself produces. Codes that a shared middleware adds
// (401, 403, 429) are not asked of the handler. The reverse is not required for this contract: the server may offer more
// routes than the SDK promises (but see the full inventory below).
//
// The full inventory of the SDK (server.full.openapi.json, next to the contract) is checked the other way too: every
// route this server registers must be in it, so a new route cannot ship without being declared in the SDK. An SDK
// checkout without that file leaves nothing to compare. The route table the SDK generates for its clients
// (generated/hydra-routes.json) is compared the same way when the checkout has it.
//
// The SDK is looked up in HYDRA_UMC_SDK_DIR, then in a sibling HYDRA-UMC-SDK checkout. When none is
// there the check is skipped with a notice, unless HYDRA_UMC_REQUIRE_SDK=1 (then it fails).
//
//   node tools/verify_sdk_contract.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK_FILE = ["contracts", "openapi", "v1", "server.openapi.json"];
const MIDDLEWARE_CODES = new Set(["401", "403", "429"]);
const METHODS = ["get", "post", "put", "patch", "delete"];

export function findSdkContract(env = process.env, root = ROOT) {
  const candidates = [];
  if (env.HYDRA_UMC_SDK_DIR) candidates.push(path.resolve(env.HYDRA_UMC_SDK_DIR));
  candidates.push(path.resolve(root, "..", "HYDRA-UMC-SDK"));
  for (const dir of candidates) {
    const file = path.join(dir, ...SDK_FILE);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const isPublic = (op) => !op.security || op.security.length === 0 || op.security.every((s) => Object.keys(s).length === 0);

// Returns the list of differences between what the SDK promises and what the server inventory offers.
export function compareContracts(sdk, server) {
  const problems = [];
  for (const [route, item] of Object.entries(sdk.paths ?? {})) {
    for (const method of METHODS) {
      const promised = item[method];
      if (!promised) continue;
      const label = `${method.toUpperCase()} ${route}`;
      const offered = server.paths?.[route]?.[method];
      if (!offered) {
        problems.push(`${label}: the SDK promises this route and the server does not register it`);
        continue;
      }
      if (isPublic(promised) !== isPublic(offered)) {
        problems.push(`${label}: access differs (SDK ${isPublic(promised) ? "public" : "signed in"}, server ${isPublic(offered) ? "public" : "signed in"})`);
      }
      const have = new Set(Object.keys(offered.responses ?? {}));
      for (const code of Object.keys(promised.responses ?? {})) {
        if (MIDDLEWARE_CODES.has(code)) continue;
        if (!have.has(code)) problems.push(`${label}: the SDK lists status ${code} and the handler never produces it`);
      }
    }
  }
  return problems;
}

// Every route and method the server registers is declared in the full inventory of the SDK.
export function compareInventoryCoverage(sdkFull, server) {
  const problems = [];
  for (const [route, item] of Object.entries(server.paths ?? {})) {
    for (const method of METHODS) {
      if (item[method] && !sdkFull.paths?.[route]?.[method]) problems.push(`${method.toUpperCase()} ${route}: the server registers this route and the full inventory of the SDK does not declare it`);
    }
  }
  return problems;
}

// The documents the SDK generates from its own route sources (contracts/sources/*.routes.json). Optional: an
// older SDK checkout has none.
export function findGeneratedDocuments(env = process.env, root = ROOT) {
  const sdkFile = findSdkContract(env, root);
  if (!sdkFile) return [];
  const dir = path.dirname(sdkFile);
  return fs.readdirSync(dir).filter((name) => name.endsWith(".openapi.json") && name !== "server.openapi.json" && name !== "server.full.openapi.json").sort().map((name) => path.join(dir, name));
}

// The query parameters a handler reads are exactly the ones the SDK source declares.
export function compareQueryParameters(sdk, server) {
  const problems = [];
  for (const [route, item] of Object.entries(sdk.paths ?? {})) {
    for (const method of METHODS) {
      if (!item[method] || !server.paths?.[route]?.[method]) continue;
      const names = (op) => new Set((op.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name));
      const promised = names(item[method]);
      const offered = names(server.paths[route][method]);
      const label = `${method.toUpperCase()} ${route}`;
      for (const name of promised) if (!offered.has(name)) problems.push(`${label}: the SDK declares the query parameter ${name} and the handler never reads it`);
      for (const name of offered) if (!promised.has(name)) problems.push(`${label}: the handler reads the query parameter ${name} and the SDK does not declare it`);
    }
  }
  return problems;
}

// What must not drift between a closed schema of the SDK and the copy in an OpenAPI document: whether it is closed, the
// required fields, and for every property its enum (or const), pattern and format.
function closedShape(schema) {
  const properties = {};
  for (const [name, def] of Object.entries(schema.properties ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const shape = {};
    if (def.enum) shape.enum = def.enum;
    else if ("const" in def) shape.enum = [def.const];
    if (def.pattern) shape.pattern = def.pattern;
    if (def.format) shape.format = def.format;
    properties[name] = shape;
  }
  return { additionalProperties: schema.additionalProperties ?? null, required: [...(schema.required ?? [])].sort(), properties };
}

export function compareClosedSchemas(name, sdkSchema, serverSchema) {
  if (!serverSchema) return [`schema ${name}: the server document does not carry it`];
  return JSON.stringify(closedShape(sdkSchema)) === JSON.stringify(closedShape(serverSchema)) ? [] : [`schema ${name}: the server copy differs from the closed schema of the SDK`];
}

// The byte copy of the shapes of the answers that this server carries (tools/sdk/server.shapes.json) is the file of the SDK
// (contracts/sources/server.shapes.json). An SDK that has no such file yet (an older checkout) leaves nothing to compare.
export function compareShapesFile(sdkFile, vendoredFile = path.join(ROOT, "tools", "sdk", "server.shapes.json")) {
  const sdkShapes = path.join(path.dirname(sdkFile), "..", "..", "sources", "server.shapes.json");
  if (!fs.existsSync(sdkShapes)) return [];
  if (!fs.existsSync(vendoredFile)) return [`${path.basename(vendoredFile)}: the SDK carries the shapes of the answers and this server has no copy of them`];
  const clean = (file) => fs.readFileSync(file, "utf8").split("\r\n").join("\n");
  return clean(sdkShapes) === clean(vendoredFile) ? [] : [`${path.basename(vendoredFile)}: differs from contracts/sources/server.shapes.json of the SDK (copy the file from the SDK checkout)`];
}

// The route table the SDK generates for its clients (generated/hydra-routes.json) lists exactly the routes this server
// registers, with the same kind of access and the same query parameters. An SDK checkout without the table (an older
// one) leaves nothing to compare.
export function compareRouteTable(table, server) {
  const problems = [];
  const rows = new Map((table.routes ?? []).map((row) => [`${row.method.toLowerCase()} ${row.path}`, row]));
  for (const [route, item] of Object.entries(server.paths ?? {})) {
    for (const method of METHODS) {
      const offered = item[method];
      if (!offered) continue;
      const label = `${method.toUpperCase()} ${route}`;
      const row = rows.get(`${method} ${route}`);
      if (!row) {
        problems.push(`${label}: the server registers this route and the route table of the SDK does not list it`);
        continue;
      }
      if ((row.access === "public") !== isPublic(offered)) problems.push(`${label}: the route table says ${row.access} and the server says ${isPublic(offered) ? "public" : "signed in"}`);
      const names = (offered.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name).sort();
      if (JSON.stringify(names) !== JSON.stringify([...row.query].sort())) problems.push(`${label}: the query parameters of the route table differ from the ones the handler reads`);
    }
  }
  for (const key of rows.keys()) {
    const [method, route] = key.split(" ");
    if (!server.paths?.[route]?.[method]) problems.push(`${method.toUpperCase()} ${route}: the route table of the SDK lists this route and the server does not register it`);
  }
  return problems;
}

function generatedDocumentProblems(file, server) {
  const sdk = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = [...compareContracts(sdk, server), ...compareQueryParameters(sdk, server)];
  const schemaDir = path.join(path.dirname(file), "..", "..", "json-schema", "v1");
  for (const name of Object.keys(sdk.components?.schemas ?? {})) {
    const schemaFile = path.join(schemaDir, `${name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}.schema.json`);
    if (!fs.existsSync(schemaFile)) continue;
    problems.push(...compareClosedSchemas(name, JSON.parse(fs.readFileSync(schemaFile, "utf8")), server.components?.schemas?.[name]));
  }
  return problems.map((p) => `${path.basename(file)}: ${p}`);
}
function main() {
  const sdkFile = findSdkContract();
  if (!sdkFile) {
    if (process.env.HYDRA_UMC_REQUIRE_SDK === "1") {
      console.error("SDK_CONTRACT=FAIL no HYDRA-UMC-SDK checkout found (set HYDRA_UMC_SDK_DIR)");
      process.exit(1);
    }
    console.log("SDK_CONTRACT=SKIP no HYDRA-UMC-SDK checkout next to this one (set HYDRA_UMC_SDK_DIR to run it)");
    return;
  }
  const sdk = JSON.parse(fs.readFileSync(sdkFile, "utf8"));
  const server = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "openapi.json"), "utf8"));
  const problems = compareContracts(sdk, server);
  for (const file of findGeneratedDocuments()) problems.push(...generatedDocumentProblems(file, server));
  problems.push(...compareShapesFile(sdkFile));
  const fullFile = path.join(path.dirname(sdkFile), "server.full.openapi.json");
  if (fs.existsSync(fullFile)) problems.push(...compareInventoryCoverage(JSON.parse(fs.readFileSync(fullFile, "utf8")), server));
  const tableFile = path.join(path.dirname(sdkFile), "..", "..", "..", "generated", "hydra-routes.json");
  if (fs.existsSync(tableFile)) problems.push(...compareRouteTable(JSON.parse(fs.readFileSync(tableFile, "utf8")), server));
  if (problems.length) {
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`SDK_CONTRACT=FAIL ${problems.length} difference(s)`);
    process.exit(1);
  }
  const count = Object.values(sdk.paths).reduce((n, item) => n + METHODS.filter((m) => item[m]).length, 0);
  console.log(`SDK_CONTRACT=PASS ${count} operations promised by the SDK are all offered by the server`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
