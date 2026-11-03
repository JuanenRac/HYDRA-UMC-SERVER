import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SCHEMAS, SHAPES_FILE, loadShapes } from "../tools/openapi_types.mjs";
import { compareShapesFile } from "../tools/verify_sdk_contract.mjs";

// The shapes of the answers belong to the SDK: this server carries a byte copy and builds its inventory from it.

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "shapes-"));

test("the shapes of the inventory are the ones of the copy of the SDK, and nothing is written in the server types any more", () => {
  const document = JSON.parse(fs.readFileSync(SHAPES_FILE, "utf8"));
  assert.equal(document.format, "hydra-server-shapes/1");
  assert.deepEqual(SCHEMAS, document.shapes);
  assert.ok(Object.keys(SCHEMAS).length >= 40);
  const source = fs.readFileSync(new URL("../tools/openapi_types.mjs", import.meta.url), "utf8");
  assert.ok(!/^\s+(LoginResult|TotpStatus|SystemMetrics|UserList):\s*\{/m.test(source), "a shape is written in the server again");
});

test("the generated inventory carries exactly those shapes, in that order", () => {
  const inventory = JSON.parse(fs.readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(inventory.components.schemas), Object.keys(SCHEMAS));
  assert.deepEqual(inventory.components.schemas, SCHEMAS);
});

test("a file that is not a file of shapes is refused instead of read", () => {
  const dir = temp();
  for (const [name, body] of Object.entries({ a: "{", b: "[]", c: JSON.stringify({ format: "other/1", shapes: {} }), d: JSON.stringify({ format: "hydra-server-shapes/1" }), e: JSON.stringify({ format: "hydra-server-shapes/1", shapes: [] }) })) {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, body);
    assert.throws(() => loadShapes(file), undefined, name);
  }
  const good = path.join(dir, "good.json");
  fs.writeFileSync(good, JSON.stringify({ format: "hydra-server-shapes/1", shapes: { A: { type: "object" } } }));
  assert.deepEqual(loadShapes(good), { A: { type: "object" } });
});

function fakeSdk(dir: string, shapes: string | null) {
  const contract = path.join(dir, "contracts", "openapi", "v1", "server.openapi.json");
  fs.mkdirSync(path.dirname(contract), { recursive: true });
  fs.writeFileSync(contract, "{}");
  if (shapes !== null) {
    fs.mkdirSync(path.join(dir, "contracts", "sources"), { recursive: true });
    fs.writeFileSync(path.join(dir, "contracts", "sources", "server.shapes.json"), shapes);
  }
  return contract;
}

test("the copy equals the file of the SDK, line endings aside, and a difference is reported", () => {
  const dir = temp();
  const text = fs.readFileSync(SHAPES_FILE, "utf8");
  const contract = fakeSdk(dir, text);
  assert.deepEqual(compareShapesFile(contract, SHAPES_FILE), []);
  const crlf = fakeSdk(temp(), text.split("\n").join("\r\n"));
  assert.deepEqual(compareShapesFile(crlf, SHAPES_FILE), []);
  const changed = fakeSdk(temp(), text.replace('"Error"', '"Failure"'));
  assert.match(compareShapesFile(changed, SHAPES_FILE)[0], /differs from contracts\/sources\/server.shapes.json/);
});

test("an SDK without the shapes file leaves nothing to compare, and a missing copy is reported when the SDK has one", () => {
  assert.deepEqual(compareShapesFile(fakeSdk(temp(), null), SHAPES_FILE), []);
  const contract = fakeSdk(temp(), "{}");
  assert.match(compareShapesFile(contract, path.join(temp(), "none.json"))[0], /has no copy/);
});
