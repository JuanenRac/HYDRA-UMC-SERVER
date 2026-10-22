import assert from "node:assert/strict";
import { test } from "node:test";
import { aiAccessAdminOnly, registerLocalAiRoutes } from "../src/routes/localAiRoutes.ts";

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
