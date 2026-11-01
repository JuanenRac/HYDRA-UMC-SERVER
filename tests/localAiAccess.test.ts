import assert from "node:assert/strict";
import { test } from "node:test";
import { aiAccessAdminOnly, EXACT_SERVICE_REQUESTS, isForwardable, READ_ONLY_SERVICE_PATHS, registerLocalAiRoutes } from "../src/routes/localAiRoutes.ts";

function chainFor(deps: { adminOnly?: boolean }) {
  let chain: any[] = [];
  const app: any = { all(route: string, ...handlers: any[]) { if (route.startsWith("/api/ai/")) chain = handlers; } };
  const authenticate = () => undefined;
  const requireAdmin = (_req: any, res: any) => { res.status(403).json({ error: "admin only" }); };
  registerLocalAiRoutes(app, { authenticate, requireAdmin, ...deps } as any);
  return { chain, authenticate };
}

function run(gate: any, user: any) {
  let status = 200;
  let passed = false;
  const res: any = { status(code: number) { status = code; return res; }, json() { return res; } };
  gate({ user }, res, () => { passed = true; });
  return { status, passed };
}

test("the relay stays open to any signed-in user unless the installation limits it", () => {
  assert.equal(aiAccessAdminOnly(undefined), false);
  assert.equal(aiAccessAdminOnly(""), false);
  assert.equal(aiAccessAdminOnly("user"), false);
  assert.equal(aiAccessAdminOnly(" Admin "), true);
  const { chain, authenticate } = chainFor({});
  assert.equal(chain[0], authenticate);
  assert.deepEqual(run(chain[1], { role: "operator" }), { status: 200, passed: true });
});

test("with the admin limit the relay is refused to anyone else", () => {
  const { chain } = chainFor({ adminOnly: true });
  assert.deepEqual(run(chain[1], { role: "operator" }), { status: 403, passed: false });
});

test("the limit can be switched at run time", () => {
  let adminOnly = false;
  const { chain } = chainFor({ adminOnly: () => adminOnly } as any);
  assert.deepEqual(run(chain[1], { role: "operator" }), { status: 200, passed: true });
  adminOnly = true;
  assert.deepEqual(run(chain[1], { role: "operator" }), { status: 403, passed: false });
});

test("the data lake is reached read-only: a read of a listed path, nothing else", () => {
  for (const path of READ_ONLY_SERVICE_PATHS.datalake) {
    assert.equal(isForwardable("datalake", "GET", path), true, path);
    assert.equal(isForwardable("datalake", "HEAD", path), true, path);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(isForwardable("datalake", method, "/query"), false, method);
    assert.equal(isForwardable("datalake", method, "/ingest"), false, method);
  }
  for (const path of ["/ingest", "/ingest/batch", "/retention", "/retention/apply", "/", "/query/", "/Query", "/query/../retention"]) {
    assert.equal(isForwardable("datalake", "GET", path), false, path);
  }
});

test("the planner and the dispatcher are reached only for the exact requests listed: the dry run of a plan and the estimates", () => {
  for (const request of EXACT_SERVICE_REQUESTS["semantic-planner"]) {
    const [method, path] = request.split(" ");
    assert.equal(isForwardable("semantic-planner", method, path), true, request);
  }
  for (const [method, path] of [["GET", "/plan/simulate"], ["POST", "/release"], ["POST", "/propose"], ["POST", "/plan/simulate/"], ["DELETE", "/plan/simulate"], ["POST", "/health"], ["POST", "/Plan/simulate"]]) {
    assert.equal(isForwardable("semantic-planner", method, path), false, `${method} ${path}`);
  }
  assert.equal(isForwardable("job-dispatcher", "GET", "/dispatch/eta"), true);
  assert.equal(isForwardable("job-dispatcher", "GET", "/health"), true);
  for (const [method, path] of [["POST", "/dispatch"], ["POST", "/jobs/submit"], ["GET", "/jobs"], ["POST", "/dispatch/eta"], ["POST", "/robots"], ["POST", "/jobs/stop-ack"], ["GET", "/dispatch/eta/../jobs"], ["PUT", "/dispatch/eta"]]) {
    assert.equal(isForwardable("job-dispatcher", method, path), false, `${method} ${path}`);
  }
});

test("the data lake window statistics can be probed for, and nothing of the downsampling is opened", () => {
  assert.equal(isForwardable("datalake", "GET", "/windows"), true);
  for (const path of ["/rollups", "/downsample", "/downsample/apply"]) assert.equal(isForwardable("datalake", "GET", path), false, path);
  assert.equal(isForwardable("datalake", "POST", "/windows"), false);
});

test("the other services are forwarded as they always were", () => {
  assert.equal(isForwardable("anomaly-detector", "POST", "/detect"), true);
  assert.equal(isForwardable("vla-engine", "DELETE", "/anything"), true);
});
