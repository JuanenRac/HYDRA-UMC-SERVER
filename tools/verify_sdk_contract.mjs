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
// (401, 403, 429) are not asked of the handler. The reverse is not required: the server may offer more
// routes than the SDK promises.
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
  if (problems.length) {
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`SDK_CONTRACT=FAIL ${problems.length} difference(s)`);
    process.exit(1);
  }
  const count = Object.values(sdk.paths).reduce((n, item) => n + METHODS.filter((m) => item[m]).length, 0);
  console.log(`SDK_CONTRACT=PASS ${count} operations promised by the SDK are all offered by the server`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
