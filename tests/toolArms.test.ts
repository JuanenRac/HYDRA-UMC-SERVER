// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the read of the arm state of the URTC tools
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// GET /api/tool-arms carries the caller's own token to the safety zones service (a stand-in here) and passes its answer on as it is, a stale report
// included; it answers 503 while the address is not set or the service is down, and passes a 404 of a service without the option on.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { registerUpstreamRoutes } from "../src/routes/upstreamRoutes.ts";

type Handler = (req: any, res: any, next?: any) => Promise<unknown> | unknown;

const REPORT = {
  schema_version: "1.0",
  ttlSeconds: 30,
  arms: [
    { robot: "arm-3", toolId: 4, armed: true, by: "token", seq: 1, ageSeconds: 2.1, stale: false },
    { robot: "arm-3", toolId: 5, armed: true, by: "token", seq: 2, ageSeconds: 95.0, stale: true },
  ],
  armedCount: 1,
  staleCount: 1,
};

async function setup(upstream: { status: number; body: unknown } | null, addressed = true) {
  const routes: Record<string, Handler[]> = {};
  const app: any = {
    get(path: string, ...handlers: Handler[]) { routes[`GET ${path}`] = handlers; },
    post() {}, put() {}, delete() {}, patch() {},
  };
  const seen: { method?: string; url?: string; authorization?: string }[] = [];
  const service = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(upstream?.status ?? 200, { "content-type": "application/json" });
    res.end(typeof upstream?.body === "string" ? upstream.body : JSON.stringify(upstream?.body ?? {}));
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const port = (service.address() as any).port;
  let down = upstream === null;
  if (down) await new Promise<void>((resolve) => service.close(() => resolve()));
  registerUpstreamRoutes(app, {
    authenticate: ((req: any, _res: any, next: any) => { req.user = { id: "u1", username: "viewer", role: "viewer" }; return next(); }) as any,
    requireAdmin: ((_req: any, res: any) => res.status(403).json({ error: "administrator required" })) as any,
    industrialLog: () => {},
    wsClients: [],
    DATALAKE_URL: "", DATALAKE_TIMEOUT_MS: 1000, CONNECTOR_HUB_URL: "", CONNECTOR_HUB_TIMEOUT_MS: 1000,
    SPI_BRIDGE_URL: "", SPI_BRIDGE_VERSION_TIMEOUT_MS: 1000, SPI_BRIDGE_FLASH_TIMEOUT_MS: 1000,
    SAFETY_ZONES_URL: addressed ? `http://127.0.0.1:${port}` : "",
  } as any);
  const call = async (req: any) => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.body = undefined;
    const done = new Promise<void>((resolve) => { res.once("finish", resolve); });
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: unknown) => { res.body = payload; queueMicrotask(() => res.emit("finish")); return res; };
    const chain = routes["GET /api/tool-arms"];
    assert.ok(chain, "the route is registered");
    const run = async (index: number): Promise<unknown> => (index >= chain.length ? undefined : chain[index](req, res, () => run(index + 1)));
    await run(0);
    await done;
    return res;
  };
  const stop = () => new Promise<void>((resolve) => { if (down) resolve(); else service.close(() => resolve()); });
  return { call, seen, stop };
}

const bearer = { authorization: "Bearer viewer-token-value" };

test("the answer of the service is passed on as it is, a stale report included, with the token of the caller", async () => {
  const t = await setup({ status: 200, body: REPORT });
  try {
    const res = await t.call({ headers: bearer });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, REPORT);
    assert.equal(res.body.arms[1].stale, true);
    assert.equal(res.body.armedCount, 1, "the stale armed tool is not counted");
    assert.deepEqual(t.seen.map((s) => [s.method, s.url, s.authorization]), [["GET", "/tool-arms", "Bearer viewer-token-value"]]);
  } finally {
    await t.stop();
  }
});

test("without a bearer token nothing leaves this server", async () => {
  const t = await setup({ status: 200, body: REPORT });
  try {
    for (const headers of [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }]) {
      const res = await t.call({ headers });
      assert.equal(res.statusCode, 401);
    }
    assert.equal(t.seen.length, 0);
  } finally {
    await t.stop();
  }
});

test("while the address is not set the read answers 503 and says it is not available", async () => {
  const t = await setup({ status: 200, body: REPORT }, false);
  try {
    const res = await t.call({ headers: bearer });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.available, false);
    assert.equal(t.seen.length, 0);
  } finally {
    await t.stop();
  }
});

test("a service that is down is a 503, never an empty list that could read as every tool disarmed", async () => {
  const t = await setup(null);
  try {
    const res = await t.call({ headers: bearer });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.arms, undefined);
  } finally {
    await t.stop();
  }
});

test("a service started without the option answers 404 and the refusal is passed on", async () => {
  const t = await setup({ status: 404, body: { error: "not found" } });
  try {
    const res = await t.call({ headers: bearer });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "not found" });
  } finally {
    await t.stop();
  }
});

test("an answer that is not JSON is reported as such", async () => {
  const t = await setup({ status: 200, body: "<html>not json</html>" });
  try {
    const res = await t.call({ headers: bearer });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.body.error), /not JSON/);
  } finally {
    await t.stop();
  }
});
