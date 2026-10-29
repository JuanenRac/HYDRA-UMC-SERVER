import assert from "node:assert/strict";
import { test } from "node:test";
import { compareContracts, findSdkContract } from "../tools/verify_sdk_contract.mjs";

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
