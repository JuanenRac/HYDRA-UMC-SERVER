// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for a saved options file that exists and cannot be understood
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// A file that is not there is a fresh install; a file that is there and cannot be understood stops the start (a copy is kept) instead of
// becoming "no options", and while the server runs the last good options keep being used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ALLOW_DAMAGED_VARIABLE, DamagedConfigError, damagedConfigAllowed, keepDamagedCopy, refuseDamagedConfig } from "../src/configFileGuard.ts";
import { ServerConfigReader } from "../src/serverConfigFile.ts";
import { SafetyLimits, loadSafetyConfig } from "../src/safetyLimits.ts";

let dir = "";
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-damaged-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const copiesOf = (file: string) => fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.damaged-`));

describe("the guard", () => {
  it("only the exact word 1 allows a start on the defaults", () => {
    assert.equal(damagedConfigAllowed({ [ALLOW_DAMAGED_VARIABLE]: "1" }), true);
    for (const word of [undefined, "", "0", "true", "yes", "on", "2"]) assert.equal(damagedConfigAllowed({ [ALLOW_DAMAGED_VARIABLE]: word }), false, String(word));
  });

  it("keeps a copy next to the file, never over an earlier copy, and the original stays", () => {
    const file = path.join(dir, "x.json");
    fs.writeFileSync(file, "{ broken");
    const first = keepDamagedCopy(file, 1_700_000_000_000);
    const second = keepDamagedCopy(file, 1_700_000_000_000);
    assert.ok(first && second && first !== second);
    assert.equal(fs.readFileSync(first, "utf-8"), "{ broken");
    assert.equal(copiesOf(file).length, 2);
    assert.equal(fs.readFileSync(file, "utf-8"), "{ broken");
    assert.equal(keepDamagedCopy(path.join(dir, "missing.json")), null);
  });

  it("refuses with the file, the copy and the way out; the allowed start only logs", () => {
    const file = path.join(dir, "x.json");
    fs.writeFileSync(file, "nope");
    assert.throws(() => refuseDamagedConfig(file, "not valid JSON", undefined, {}), (error: unknown) => {
      assert.ok(error instanceof DamagedConfigError);
      assert.equal(error.file, file);
      assert.ok(error.copy && fs.existsSync(error.copy));
      assert.match(error.message, new RegExp(ALLOW_DAMAGED_VARIABLE));
      return true;
    });
    const logs: string[] = [];
    refuseDamagedConfig(file, "not valid JSON", (line) => logs.push(line), { [ALLOW_DAMAGED_VARIABLE]: "1" });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /defaults are used for this start/);
  });
});

describe("data/server-config.json", () => {
  const file = () => path.join(dir, "server-config.json");

  it("a file that is not there is a fresh install: no options, no refusal", () => {
    const reader = new ServerConfigReader(file());
    assert.deepEqual(reader.readAtStart({}), {});
    assert.deepEqual(reader.read(), {});
    assert.equal(copiesOf(file()).length, 0);
  });

  it("a good file is read as it is", () => {
    fs.writeFileSync(file(), JSON.stringify({ port: 3100, tls: { enabled: true } }));
    const reader = new ServerConfigReader(file());
    assert.deepEqual(reader.readAtStart({}), { port: 3100, tls: { enabled: true } });
    assert.deepEqual(reader.read(), { port: 3100, tls: { enabled: true } });
  });

  it("a file that is there and cannot be understood stops the start and a copy is kept", () => {
    for (const content of ["{ not json", "[1,2]", "null", "", "12"]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file(), content);
      assert.throws(() => new ServerConfigReader(file()).readAtStart({}), DamagedConfigError, JSON.stringify(content));
      assert.equal(copiesOf(file()).length, 1, JSON.stringify(content));
      assert.equal(fs.readFileSync(file(), "utf-8"), content, "the damaged file itself is not touched");
    }
  });

  it("the allowed start uses no options and says so", () => {
    fs.writeFileSync(file(), "{ not json");
    const logs: string[] = [];
    assert.deepEqual(new ServerConfigReader(file(), (line) => logs.push(line)).readAtStart({ [ALLOW_DAMAGED_VARIABLE]: "1" }), {});
    assert.ok(logs.some((line) => /defaults are used for this start/.test(line)));
  });

  it("while running a file that turns bad keeps the last good options, keeps one copy and logs once", () => {
    fs.writeFileSync(file(), JSON.stringify({ port: 3100, tls: { enabled: true } }));
    const logs: string[] = [];
    const reader = new ServerConfigReader(file(), (line) => logs.push(line));
    assert.deepEqual(reader.readAtStart({}), { port: 3100, tls: { enabled: true } });
    fs.writeFileSync(file(), '{"port": 3100, "tls": ');
    for (let i = 0; i < 3; i += 1) assert.deepEqual(reader.read(), { port: 3100, tls: { enabled: true } });
    assert.equal(copiesOf(file()).length, 1);
    assert.equal(logs.length, 1);
    // each answer is its own object: a caller that changes it does not change what the next read gives
    (reader.read() as any).port = 1;
    assert.equal((reader.read() as any).port, 3100);
    // repaired by hand: read again, and a later damage is copied and logged again
    fs.writeFileSync(file(), JSON.stringify({ port: 3200 }));
    assert.deepEqual(reader.read(), { port: 3200 });
    fs.writeFileSync(file(), "{");
    assert.deepEqual(reader.read(), { port: 3200 });
    assert.equal(logs.length, 2);
  });

  it("while running with no good read yet the defaults are used (the start-up check is what refuses)", () => {
    fs.writeFileSync(file(), "{");
    assert.deepEqual(new ServerConfigReader(file()).read(), {});
  });
});

describe("data/safety-limits.json", () => {
  const file = () => path.join(dir, "safety-limits.json");

  it("not there: the defaults of a fresh install", () => {
    assert.equal(loadSafetyConfig(file()).jog.default.maxAmount, 100);
    assert.equal(copiesOf(file()).length, 0);
  });

  it("damaged or holding a refused value: the start is refused and a copy is kept, never a silent fall back to the defaults", () => {
    for (const content of ["{ not json", JSON.stringify({ jog: { default: { maxAmount: 99999 } } }), JSON.stringify({ jog: { armRequired: "yes" } })]) {
      fs.writeFileSync(file(), content);
      assert.throws(() => new SafetyLimits(dir), DamagedConfigError, content);
      assert.equal(fs.readFileSync(file(), "utf-8"), content);
    }
    assert.ok(copiesOf(file()).length >= 3);
  });

  it("the allowed start uses the defaults and logs it", () => {
    fs.writeFileSync(file(), "{ not json");
    const before = process.env[ALLOW_DAMAGED_VARIABLE];
    process.env[ALLOW_DAMAGED_VARIABLE] = "1";
    try {
      const logs: string[] = [];
      const limits = new SafetyLimits(dir, (line) => logs.push(line));
      assert.equal(limits.jogFor("x").maxAmount, 100);
      assert.equal(logs.length, 1);
    } finally {
      if (before === undefined) delete process.env[ALLOW_DAMAGED_VARIABLE];
      else process.env[ALLOW_DAMAGED_VARIABLE] = before;
    }
  });

  it("a setting this version does not know is still ignored on its own: the known ones keep their saved values", () => {
    fs.writeFileSync(file(), JSON.stringify({ jog: { armRequired: true, newerSetting: 1 } }));
    const limits = new SafetyLimits(dir);
    assert.equal(limits.get().jog.armRequired, true);
    assert.equal(copiesOf(file()).length, 0);
  });
});
