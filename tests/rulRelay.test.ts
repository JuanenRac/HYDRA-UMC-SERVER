import assert from "node:assert/strict";
import { test } from "node:test";
import { isRulRequest, isWriteToModel, registerLocalAiRoutes, rulBodyError, rulSettings } from "../src/routes/localAiRoutes.ts";
import { SecurityConfig, SecurityConfigError, resolveRul, type SecurityFile } from "../src/securityConfig.ts";

// ---- the switch ---------------------------------------------------------------------------------------------------------------------------

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

test("the relay of the estimate is off by default, only the exact word 1 turns it on from the environment, and the environment wins", () => {
  const { config } = makeConfig();
  assert.equal(config.rulEnabled(), false);
  assert.deepEqual(config.snapshot().rul.enabled, { value: false, source: "default" });
  assert.equal(makeConfig({ rul: "1" }).config.rulEnabled(), true);
  for (const word of ["true", "yes", "on", "0", ""]) assert.equal(makeConfig({ rul: word }).config.rulEnabled(), false, word);
  assert.deepEqual(resolveRul(undefined, { rul: { enabled: true } }), { value: true, source: "config" });
  assert.equal(resolveRul("0", { rul: { enabled: true } }).value, false);
});

test("an administrator switches it from the settings, the limits stay untouched and are logged", () => {
  const { config, logs, stored } = makeConfig({}, { rul: { maxPoints: 100, timeoutMs: 900 } });
  config.update({ rul: { enabled: true } }, "root");
  assert.equal(config.rulEnabled(), true);
  assert.deepEqual(stored().rul, { enabled: true, maxPoints: 100, timeoutMs: 900 });
  assert.ok(logs.some((l) => /root/.test(l) && /remaining-useful-life/.test(l) && /on/.test(l)));
  config.update({ rul: { enabled: false } }, "root");
  assert.equal(config.rulEnabled(), false);
  const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
  for (const value of ["yes", 1, null]) assert.throws(() => config.update({ rul: { enabled: value } }, "root"), bad400);
  assert.throws(() => config.update({ rul: [] }, "root"), bad400);
  assert.throws(() => makeConfig({ rul: "1" }).config.update({ rul: { enabled: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /HYDRA_UMC_RUL/.test(e.message));
});

// ---- who may ask, and the limits ----------------------------------------------------------------------------------------------------------

test("off, the estimate stays a write for administrators; on, it is open to operators and nothing else changes", () => {
  assert.equal(isWriteToModel("anomaly-detector", "POST", "/rul"), true);
  assert.equal(isWriteToModel("anomaly-detector", "POST", "/rul", false), true);
  assert.equal(isWriteToModel("anomaly-detector", "POST", "/rul", true), false);
  for (const path of ["/rul/", "/Rul", "/rul/../baseline/fit", "/baseline/fit", "/drift/init", "/drift/observe"]) {
    assert.equal(isWriteToModel("anomaly-detector", "POST", path, true), true, path);
  }
  assert.equal(isWriteToModel("anomaly-detector", "PUT", "/rul", true), true);
  assert.equal(isRulRequest("anomaly-detector", "POST", "/rul"), true);
  assert.equal(isRulRequest("anomaly-detector", "GET", "/rul"), false);
  assert.equal(isRulRequest("vla-engine", "POST", "/rul"), false);
});

test("the limits come from the file and anything invalid gives the default", () => {
  assert.deepEqual(rulSettings(false, undefined), { enabled: false, maxBodyBytes: 262144, maxPoints: 5000, timeoutMs: 8000 });
  assert.deepEqual(rulSettings(true, { maxBodyBytes: 4096, maxPoints: 50, timeoutMs: 1000 }), { enabled: true, maxBodyBytes: 4096, maxPoints: 50, timeoutMs: 1000 });
  assert.deepEqual(rulSettings(true, { maxBodyBytes: 5, maxPoints: "9", timeoutMs: 1e9 }), { enabled: true, maxBodyBytes: 262144, maxPoints: 5000, timeoutMs: 8000 });
  assert.deepEqual(rulSettings(true, "x"), { enabled: true, maxBodyBytes: 262144, maxPoints: 5000, timeoutMs: 8000 });
});

test("the body is checked before it is forwarded", () => {
  const settings = rulSettings(true, { maxBodyBytes: 1024, maxPoints: 10 });
  const ok = { points: [{ t: 1, score: 0.1 }], limit: 1 };
  assert.equal(rulBodyError(ok, JSON.stringify(ok), settings), null);
  assert.equal(rulBodyError([], "[]", settings)?.status, 400);
  assert.equal(rulBodyError({}, "{}", settings)?.status, 400);
  assert.equal(rulBodyError({ points: "x" }, "{}", settings)?.status, 400);
  const many = { points: Array.from({ length: 11 }, () => ({ t: 1, score: 1 })) };
  assert.equal(rulBodyError(many, JSON.stringify(many), settings)?.status, 413);
  const big = { points: [], pad: "x".repeat(2000) };
  assert.equal(rulBodyError(big, JSON.stringify(big), settings)?.status, 413);
});

// ---- the route, with a simulated detector ---------------------------------------------------------------------------------------------------

function relay(rul: ReturnType<typeof rulSettings> | undefined) {
  let chain: any[] = [];
  const app: any = { all(route: string, ...handlers: any[]) { if (route.startsWith("/api/ai/")) chain = handlers; } };
  const requireAdmin = (_req: any, res: any, next: any) => (_req.user?.role === "admin" ? next() : res.status(403).json({ error: "admin" }));
  const requireOperator = (req: any, res: any, next: any) => (["admin", "operator"].includes(req.user?.role) ? next() : res.status(403).json({ error: "operator" }));
  registerLocalAiRoutes(app, { authenticate: () => undefined, requireAdmin, requireOperator, adminOnly: false, rul: rul ? () => rul : undefined, env: { HYDRA_UMC_ANOMALY_TOKEN: "anomaly-token-12345" } } as any);
  return async (role: string, service: string, rest: string[], body: unknown, method = "POST") => {
    const out: { status: number; body?: any; text?: string } = { status: 200 };
    const res: any = {
      status(code: number) { out.status = code; return res; },
      json(value: any) { out.body = value; return res; },
      setHeader() { return res; },
      send(text: string) { out.text = text; return res; },
    };
    const req: any = { user: { role }, method, params: { service, rest }, url: `/api/ai/${service}/${rest.join("/")}`, body };
    let handler: Promise<unknown> = Promise.resolve();
    chain[1](req, res, () => { handler = chain[2](req, res); });
    await handler;
    return out;
  };
}

async function withDetector<T>(answer: (url: string, init: any) => Promise<Response> | Response, run: (calls: { url: string; init: any }[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return answer(String(url), init); }) as any;
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

const estimate = () => new Response(JSON.stringify({ state: "ok", days: 12 }), { status: 200, headers: { "content-type": "application/json" } });
const points = { points: [{ t: 1, score: 0.2 }], limit: 1 };

test("off, an operator is refused the estimate and an administrator still gets it, as before", async () => {
  const call = relay(undefined);
  await withDetector(estimate, async (calls) => {
    assert.equal((await call("operator", "anomaly-detector", ["rul"], points)).status, 403);
    assert.equal(calls.length, 0);
    const admin = await call("admin", "anomaly-detector", ["rul"], points);
    assert.equal(admin.status, 200);
    assert.equal(calls[0].url, "http://127.0.0.1:8097/rul");
    assert.equal(calls[0].init.headers.authorization, "Bearer anomaly-token-12345");
  });
  const off = relay(rulSettings(false, undefined));
  await withDetector(estimate, async () => {
    assert.equal((await off("operator", "anomaly-detector", ["rul"], points)).status, 403);
  });
});

test("on, an operator gets the estimate through the relay with the token of the detector; a viewer and a guest do not", async () => {
  const call = relay(rulSettings(true, undefined));
  await withDetector(estimate, async (calls) => {
    const op = await call("operator", "anomaly-detector", ["rul"], points);
    assert.equal(op.status, 200);
    assert.deepEqual(JSON.parse(op.text!), { state: "ok", days: 12 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.authorization, "Bearer anomaly-token-12345");
    assert.equal((await call("viewer", "anomaly-detector", ["rul"], points)).status, 403);
    assert.equal((await call("guest", "anomaly-detector", ["rul"], points)).status, 403);
    assert.equal(calls.length, 1);
  });
});

test("on, the other writes to the detector stay for administrators and the body limits answer before anything is forwarded", async () => {
  const call = relay(rulSettings(true, { maxPoints: 10, maxBodyBytes: 1024 }));
  await withDetector(estimate, async (calls) => {
    assert.equal((await call("operator", "anomaly-detector", ["baseline", "fit"], {})).status, 403);
    assert.equal((await call("operator", "anomaly-detector", ["rul", "..", "baseline", "fit"], {})).status, 403);
    assert.equal((await call("operator", "anomaly-detector", ["rul"], { points: "x" })).status, 400);
    assert.equal((await call("operator", "anomaly-detector", ["rul"], { points: Array.from({ length: 11 }, () => 1) })).status, 413);
    assert.equal((await call("operator", "anomaly-detector", ["rul"], { points: [], pad: "x".repeat(3000) })).status, 413);
    assert.equal(calls.length, 0);
  });
});

test("on, a detector that is down or never answers gives 503 and does not hold the request", async () => {
  const call = relay(rulSettings(true, { timeoutMs: 500 }));
  await withDetector(() => { throw new Error("ECONNREFUSED"); }, async () => {
    assert.equal((await call("operator", "anomaly-detector", ["rul"], points)).status, 503);
  });
  const hang = (_url: string, init: any) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await withDetector(hang, async () => {
    const started = Date.now();
    assert.equal((await call("operator", "anomaly-detector", ["rul"], points)).status, 503);
    assert.ok(Date.now() - started < 3000);
  });
  const stall = (_url: string, init: any) => {
    const stream = new ReadableStream({ start(controller) { init.signal.addEventListener("abort", () => controller.error(new Error("aborted"))); } });
    return new Response(stream, { status: 200 });
  };
  await withDetector(stall, async () => {
    const started = Date.now();
    assert.equal((await call("operator", "anomaly-detector", ["rul"], points)).status, 503);
    assert.ok(Date.now() - started < 3000);
  });
});

test("on, the estimate is asked of the anomaly detector only", async () => {
  const call = relay(rulSettings(true, undefined));
  await withDetector(estimate, async (calls) => {
    assert.equal((await call("operator", "vla-engine", ["rul"], points)).status, 200);
    assert.equal(calls[0].url, "http://127.0.0.1:8098/rul");
    assert.equal((await call("operator", "datalake", ["rul"], points)).status, 403);
  });
});
