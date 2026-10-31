import assert from "node:assert/strict";
import { test } from "node:test";
import { compareClosedSchemas, compareContracts, compareQueryParameters, findGeneratedDocuments, findSdkContract } from "../tools/verify_sdk_contract.mjs";

const op = (codes: string[], secured = true) => ({ responses: Object.fromEntries(codes.map((c) => [c, {}])), ...(secured ? { security: [{ bearerAuth: [] }] } : { security: [] }) });

test("a contract the server fully offers has no differences", () => {
  const sdk = { paths: { "/api/x": { get: op(["200", "401", "404"]) } } };
  const server = { paths: { "/api/x": { get: op(["200", "404"]) } } };
  assert.deepEqual(compareContracts(sdk, server), []);
});

test("a route the server does not register is reported", () => {
  const sdk = { paths: { "/api/x": { get: op(["200"]) } } };
  assert.match(compareContracts(sdk, { paths: {} })[0], /GET \/api\/x.*does not register/);
});

test("a missing method on a known path is reported", () => {
  const sdk = { paths: { "/api/x": { post: op(["200"]) } } };
  assert.equal(compareContracts(sdk, { paths: { "/api/x": { get: op(["200"]) } } }).length, 1);
});

test("a status the handler never produces is reported, a middleware status is not", () => {
  const sdk = { paths: { "/api/x": { post: op(["200", "409", "429", "403"]) } } };
  const server = { paths: { "/api/x": { post: op(["200"]) } } };
  const problems = compareContracts(sdk, server);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /status 409/);
});

test("a difference in public against signed-in access is reported", () => {
  const sdk = { paths: { "/api/x": { get: op(["200"], false) } } };
  const server = { paths: { "/api/x": { get: op(["200"], true) } } };
  assert.match(compareContracts(sdk, server)[0], /access differs/);
});

test("the SDK contract is found through HYDRA_UMC_SDK_DIR and not found in an empty place", () => {
  assert.equal(findSdkContract({ HYDRA_UMC_SDK_DIR: "Z:/no/such/dir" } as any, "Z:/no/such/root"), null);
});

const withQuery = (names: string[]) => ({ get: { responses: { "200": {} }, security: [{ bearerAuth: [] }], parameters: names.map((name) => ({ name, in: "query" })) } });

test("the query parameters of a handler are exactly the declared ones", () => {
  const sdk = { paths: { "/api/x": withQuery(["kind", "limit"]) } };
  assert.deepEqual(compareQueryParameters(sdk, { paths: { "/api/x": withQuery(["limit", "kind"]) } }), []);
  const problems = compareQueryParameters(sdk, { paths: { "/api/x": withQuery(["kind", "user"]) } });
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /declares the query parameter limit/);
  assert.match(problems.join("\n"), /reads the query parameter user/);
});

test("a closed schema copy that drifts is reported", () => {
  const sdk = { additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: "^a$" }, kind: { enum: ["a", "b"] }, v: { const: "1.0" } } };
  const same = { additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: "^a$" }, kind: { type: "string", enum: ["a", "b"] }, v: { type: "string", enum: ["1.0"] } } };
  assert.deepEqual(compareClosedSchemas("S", sdk, same), []);
  assert.equal(compareClosedSchemas("S", sdk, { ...same, required: [] }).length, 1);
  assert.equal(compareClosedSchemas("S", sdk, { ...same, properties: { ...same.properties, kind: { enum: ["a"] } } }).length, 1);
  assert.equal(compareClosedSchemas("S", sdk, { ...same, properties: { ...same.properties, id: { type: "string" } } }).length, 1);
  assert.equal(compareClosedSchemas("S", sdk, { ...same, additionalProperties: true }).length, 1);
  assert.match(compareClosedSchemas("S", sdk, undefined)[0], /does not carry it/);
});

test("no generated SDK document is found in an empty place", () => {
  assert.deepEqual(findGeneratedDocuments({ HYDRA_UMC_SDK_DIR: "Z:/no/such/dir" } as any, "Z:/no/such/root"), []);
});