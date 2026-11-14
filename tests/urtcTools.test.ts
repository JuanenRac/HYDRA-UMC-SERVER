import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { URTC_NO_TOOL_ID, URTC_TOOLS, isKnownUrtcTool, unknownToolLogLine } from "../src/urtcTools";

// The tool of a command is checked against the common list of the URTC family, and a tool that is not in it is only said in the log.

test("the table has the 25 tools with their identifiers in order and the no-tool identifier after them", () => {
  assert.equal(URTC_TOOLS.length, 25);
  URTC_TOOLS.forEach((tool, index) => assert.equal(tool.id, index));
  assert.equal(URTC_NO_TOOL_ID, 25);
  assert.equal(new Set(URTC_TOOLS.map((tool) => tool.name)).size, 25);
  assert.equal(new Set(URTC_TOOLS.map((tool) => tool.title)).size, 25);
});

test("the table is the list of the SDK when a checkout of the SDK is at hand", (t) => {
  const roots = [process.env.HYDRA_UMC_SDK_DIR, path.resolve(process.cwd(), "..", "HYDRA-UMC-SDK")].filter((dir): dir is string => !!dir);
  const file = roots.map((dir) => path.join(dir, "contracts", "urtc_tools.json")).find((candidate) => fs.existsSync(candidate));
  if (!file) {
    t.skip("no checkout of the SDK");
    return;
  }
  const catalogue = JSON.parse(fs.readFileSync(file, "utf8")) as { invalid_tool_id: number; tools: { tool_id: number; name: string; title: string }[] };
  assert.equal(catalogue.invalid_tool_id, URTC_NO_TOOL_ID);
  assert.deepEqual(URTC_TOOLS.map((tool) => ({ id: tool.id, name: tool.name, title: tool.title })), catalogue.tools.map((tool) => ({ id: tool.tool_id, name: tool.name, title: tool.title })));
});

test("a tool is known by its name, its name without TOOL_, its title, None or its identifier", () => {
  for (const known of ["TOOL_DRILL", "drill", " Drill ", "Drill (BL4260)", "SMT Pick & Place Head", "None", "none", "TOOL_INVALID", 0, 5, 24, 25, "5", "25"]) {
    assert.equal(isKnownUrtcTool(known), true, String(known));
  }
});

test("anything else is unknown: another text, an empty text, a number out of range, a fraction, and what is not a text or a number", () => {
  for (const unknown of ["PnP", "Laser", "", "   ", "26", 26, -1, 2.5, Number.NaN, null, undefined, {}, [], true, "TOOL_"]) {
    assert.equal(isKnownUrtcTool(unknown), false, JSON.stringify(unknown));
  }
});

test("only an unknown tool gets a line for the log, and a long value is cut", () => {
  assert.equal(unknownToolLogLine(3, "Drill (BL4260)"), null);
  assert.equal(unknownToolLogLine(3, 7), null);
  assert.match(unknownToolLogLine(3, "PnP") ?? "", /^\[tool\] robot 3: "PnP" is not a tool of the URTC family/);
  assert.match(unknownToolLogLine(3, 99) ?? "", /: 99 is not a tool/);
  assert.match(unknownToolLogLine(3, {}) ?? "", /: a object is not a tool/);
  const long = unknownToolLogLine(3, "x".repeat(500)) ?? "";
  assert.ok(long.length < 200, String(long.length));
});
