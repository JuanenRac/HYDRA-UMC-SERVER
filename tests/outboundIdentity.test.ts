// =============================================================================
// HYDRA-UMC-SERVER - tests/outboundIdentity.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Every call this server makes to a service of the family must be able to carry its identity (src/serviceIdentity.ts), or the services whose identity switch
// is on would refuse it. This test reads the sources: each `fetch(` of the server has to build its headers with `upstreamHeaders`, `identityHeader` or
// `withIdentity` close by, unless it is one of the few calls listed here with the reason.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const CARRIES = /\b(upstreamHeaders|identityHeader|withIdentity)\b/;

/** Calls that deliberately do not present the identity of the server, found by the text near the call. */
const EXEMPT: ReadonlyArray<{ near: RegExp; why: string }> = [
  { near: /relayWithOwnToken/, why: "the connector hub gate is reached with the Bearer token of the signed-in account itself, passed on as it came" },
  { near: /\/atc\/reset|SAFETY_ZONES_URL\}\/tool-arms/, why: "the reset of the arm state of a tool changer carries the Bearer token of the signed-in administrator itself, passed on as it came, like the other relays of that kind" },
  { near: /api\.github\.com\/repos\//, why: "the look at the newest published versions asks GitHub, which is not a service of the family and must never receive the identity of the server" },
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith(".ts") ? [full] : [];
  });
}

test("every outbound fetch of the server can carry the identity of the server", () => {
  const missing: string[] = [];
  let calls = 0;
  for (const file of sources(SRC)) {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || !/\bfetch\(/.test(code)) return;
      if (/fetch:\s*\(url, init\) => fetch\(url, init\)/.test(code)) return; // a wrapper handed to code that builds its own headers (checked where it is)
      calls += 1;
      const around = lines.slice(Math.max(0, index - 14), index + 10).join("\n");
      const wider = lines.slice(Math.max(0, index - 30), index + 10).join("\n");
      if (CARRIES.test(around) || EXEMPT.some((entry) => entry.near.test(wider))) return;
      missing.push(`${path.relative(SRC, file)}:${index + 1}`);
    });
  }
  assert.ok(calls >= 10, `expected to find the outbound calls of the server, found ${calls}`);
  assert.deepEqual(missing, [], `these calls do not present the identity of the server: ${missing.join(", ")}`);
});
