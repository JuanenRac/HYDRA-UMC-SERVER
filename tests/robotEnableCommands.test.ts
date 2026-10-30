import assert from "node:assert/strict";
import { test } from "node:test";
import { ROBOT_COMMANDS, commandMetricLabel } from "../src/routes/commandRoutes.ts";

test("disable is a command a phone may send over Bluetooth or MQTT, enable is not", () => {
  assert.equal(ROBOT_COMMANDS.has("disable"), true);
  assert.equal(ROBOT_COMMANDS.has("enable"), false);
  assert.equal(ROBOT_COMMANDS.has("stop"), true);
});

test("both commands have their own metric label", () => {
  assert.equal(commandMetricLabel("enable"), "enable");
  assert.equal(commandMetricLabel("disable"), "disable");
  assert.equal(commandMetricLabel("shutdown"), "unknown");
});
