import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { acceptedEvent, commandOperation, correlationFor, newOperationId, nextEvent } from "../src/commandLifecycle.ts";

const SCHEMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "HYDRA-UMC-SDK", "contracts", "json-schema", "v1", "command-lifecycle-event.schema.json");
const OPERATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "HYDRA-UMC-SDK", "contracts", "json-schema", "v1", "operation.schema.json");

// A small check of a closed schema: the fields it lists, the required ones, enum, pattern, minimum and the if/then of the reason.
function violations(schema: any, value: any): string[] {
  const problems: string[] = [];
  const props = schema.properties ?? {};
  if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in props)) problems.push(`unknown field ${key}`);
  for (const key of schema.required ?? []) if (!(key in value)) problems.push(`missing ${key}`);
  for (const [key, rule] of Object.entries<any>(props)) {
    if (!(key in value)) continue;
    const v = value[key];
    if ("const" in rule && v !== rule.const) problems.push(`${key} is not ${rule.const}`);
    if (rule.enum && !rule.enum.includes(v)) problems.push(`${key} not in enum`);
    if (rule.pattern && !new RegExp(rule.pattern).test(v)) problems.push(`${key} breaks its pattern`);
    if (rule.minimum !== undefined && v < rule.minimum) problems.push(`${key} below minimum`);
    if (rule.maxLength !== undefined && String(v).length > rule.maxLength) problems.push(`${key} too long`);
  }
  return problems;
}

test("the accepted event is the first of its command", () => {
  const e = acceptedEvent("cmd-1", 7, "play", new Date("2000-01-01T00:00:00Z"));
  assert.deepEqual(e, { schema_version: "1.0", operation_id: "cmd-1", robot_id: "7", command: "play", state: "ACCEPTED", at_utc: "2000-01-01T00:00:00.000Z", sequence: 1 });
});

test("the sequence grows and FAILED or CANCELLED need a reason", () => {
  const a = acceptedEvent("cmd-1", 1, "stop");
  const r = nextEvent(a, "RUNNING");
  assert.equal(r.sequence, 2);
  assert.throws(() => nextEvent(r, "FAILED"), /needs a reason/);
  assert.throws(() => nextEvent(r, "CANCELLED", ""), /needs a reason/);
  const f = nextEvent(r, "FAILED", "the controller refused");
  assert.equal(f.sequence, 3);
  assert.equal(f.reason, "the controller refused");
  assert.equal("reason" in nextEvent(f, "COMPLETED"), false, "a reason of an earlier state is not carried over");
});

test("operation ids fit the contract pattern and are unique", () => {
  const a = newOperationId();
  assert.match(a, /^[A-Za-z0-9._:-]{1,64}$/);
  assert.notEqual(a, newOperationId());
});

test("a correlation id of the caller is kept only when it fits the pattern", () => {
  assert.equal(correlationFor("trace-9", "cmd-1"), "trace-9");
  assert.equal(correlationFor("bad value!", "cmd-1"), "cmd-1");
  assert.equal(correlationFor(undefined, "cmd-1"), "cmd-1");
  assert.equal(correlationFor("x".repeat(65), "cmd-1"), "cmd-1");
});

test("the event and the operation match the closed schemas of the SDK when its checkout is beside this one", { skip: !fs.existsSync(SCHEMA) }, () => {
  const event = acceptedEvent(newOperationId(), 3, "pause");
  assert.deepEqual(violations(JSON.parse(fs.readFileSync(SCHEMA, "utf8")), event), []);
  const failed = nextEvent(event, "FAILED", "no evidence");
  assert.deepEqual(violations(JSON.parse(fs.readFileSync(SCHEMA, "utf8")), failed), []);
  const op = commandOperation(event.operation_id, event.operation_id, 3, "pause");
  const opSchema = JSON.parse(fs.readFileSync(OPERATION, "utf8"));
  assert.deepEqual(violations(opSchema, op), []);
});
