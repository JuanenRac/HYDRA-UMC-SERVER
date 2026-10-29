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
  if (problems.length) {
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`SDK_CONTRACT=FAIL ${problems.length} difference(s)`);
    process.exit(1);
  }
  const count = Object.values(sdk.paths).reduce((n, item) => n + METHODS.filter((m) => item[m]).length, 0);
  console.log(`SDK_CONTRACT=PASS ${count} operations promised by the SDK are all offered by the server`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
