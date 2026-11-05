// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the routes of the proposals of the node watchdog
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// GET /api/ops-agent/proposals and POST /api/ops-agent/proposals/decide: administrators only, the decision names the signed-in account
// (never one sent by the client), approving needs a confirmation, and every attempt is audited. The channel is a stand-in here.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerUpstreamRoutes } from "../src/routes/upstreamRoutes.ts";
import { ChannelError } from "../src/opsAgentChannel.ts";

type Handler = (req: any, res: any, next?: any) => Promise<unknown> | unknown;

function setup(channel: any, role = "admin", username = "root") {
  const routes: Record<string, Handler[]> = {};
  const app: any = {
    get(path: string, ...handlers: Handler[]) { routes[`GET ${path}`] = handlers; },
    post(path: string, ...handlers: Handler[]) { routes[`POST ${path}`] = handlers; },
    put() {}, delete() {}, patch() {},
  };
  const events: any[] = [];
  registerUpstreamRoutes(app, {
    authenticate: ((req: any, _res: any, next: any) => { req.user = { id: "u1", username, role }; return next(); }) as any,
    requireAdmin: ((req: any, res: any, next: any) => (req.user?.role === "admin" ? next() : res.status(403).json({ error: "administrator required" }))) as any,
    industrialLog: () => {}, wsClients: [], DATALAKE_URL: "", DATALAKE_TIMEOUT_MS: 1000, CONNECTOR_HUB_URL: "", CONNECTOR_HUB_TIMEOUT_MS: 1000,
    SPI_BRIDGE_URL: "", SPI_BRIDGE_VERSION_TIMEOUT_MS: 1000, SPI_BRIDGE_FLASH_TIMEOUT_MS: 1000,
    audit: { record: (event: any) => { events.push(event); return null as any; } },
    opsAgentChannel: typeof channel === "function" ? channel : () => channel,
  } as any);
  const call = async (key: string, req: any) => {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.status = (code: number) => { res.statusCode = code; return res; };
    const done = new Promise<void>((resolve) => { res.json = (payload: unknown) => { res.body = payload; resolve(); return res; }; });
    const chain = routes[key];
    assert.ok(chain, `route ${key} is registered`);
    const run = async (index: number): Promise<unknown> => (index >= chain.length ? undefined : chain[index](req, res, () => run(index + 1)));
    await run(0);
    await Promise.race([done, new Promise((r) => setTimeout(r, 200))]);
    return res;
  };
  return { call, events };
}

const LIST = "GET /api/ops-agent/proposals";
const DECIDE = "POST /api/ops-agent/proposals/decide";

function fakeChannel() {
  const calls: any[] = [];
  return {
    calls,
    proposals: async () => ({ pending: [{ incident: { incidentId: "a" } }], decided: [] }),
    decide: async (id: string, decision: string, by: string) => { calls.push([id, decision, by]); return { incidentId: id, decision, by }; },
  };
}

test("an administrator lists the proposals; a viewer is refused; no channel answers 503", async () => {
  const t = setup(fakeChannel());
  assert.deepEqual((await t.call(LIST, { headers: {} })).body.pending[0].incident.incidentId, "a");
  assert.equal((await setup(fakeChannel(), "viewer").call(LIST, { headers: {} })).statusCode, 403);
  const none = await setup(null).call(LIST, { headers: {} });
  assert.equal(none.statusCode, 503);
  assert.equal(none.body.available, false);
  const broken = await setup(() => { throw new ChannelError("registry-unreadable", "the node registry file cannot be read"); }).call(LIST, { headers: {} });
  assert.equal(broken.statusCode, 503);
});

test("a body of the wrong shape never leaves this server and is audited as refused", async () => {
  const channel = fakeChannel();
  const t = setup(channel);
  for (const body of [undefined, [], {}, { incidentId: "a" }, { incidentId: "a", decision: "maybe" }, { incidentId: 5, decision: "rejected" }, { incidentId: "a", decision: "rejected", by: "mallory" }]) {
    assert.equal((await t.call(DECIDE, { headers: {}, body, ip: "10.0.0.5" })).statusCode, 400);
  }
  assert.equal(channel.calls.length, 0);
  assert.ok(t.events.length === 7 && t.events.every((e) => e.type === "ops-agent-proposal-decision" && e.outcome === "refused"));
});

test("approving needs a confirmation before anything is sent", async () => {
  const channel = fakeChannel();
  const t = setup(channel);
  const res = await t.call(DECIDE, { headers: {}, body: { incidentId: "a", decision: "approved" }, ip: "10.0.0.5" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "CONFIRMATION_REQUIRED");
  assert.equal(channel.calls.length, 0);
  assert.equal(t.events[0].outcome, "refused");
});

test("a confirmed approval and a rejection go to the watchdog in the name of the signed-in account and are audited", async () => {
  const channel = fakeChannel();
  const t = setup(channel);
  assert.equal((await t.call(DECIDE, { headers: {}, body: { incidentId: "a", decision: "approved", confirm: true }, ip: "10.0.0.5" })).statusCode, 200);
  assert.equal((await t.call(DECIDE, { headers: {}, body: { incidentId: "b", decision: "rejected" }, ip: "10.0.0.5" })).statusCode, 200);
  assert.deepEqual(channel.calls, [["a", "approved", "root"], ["b", "rejected", "root"]]);
  assert.deepEqual(t.events.map((e) => [e.type, e.outcome, e.username, e.detail.incidentId, e.detail.decision]), [
    ["ops-agent-proposal-decision", "ok", "root", "a", "approved"],
    ["ops-agent-proposal-decision", "ok", "root", "b", "rejected"],
  ]);
});

test("a refusal of the watchdog is passed on with its reason and audited; an unreachable one answers 503", async () => {
  const refusing = { ...fakeChannel(), decide: async () => { throw new ChannelError("operation-failed", "not-pending"); } };
  const t = setup(refusing);
  const res = await t.call(DECIDE, { headers: {}, body: { incidentId: "a", decision: "rejected" }, ip: "10.0.0.5" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "operation-failed");
  assert.equal(t.events[0].outcome, "refused");
  const down = setup({ ...fakeChannel(), decide: async () => { throw new ChannelError("unreachable", "the edge cannot be reached"); } });
  const gone = await down.call(DECIDE, { headers: {}, body: { incidentId: "a", decision: "rejected" }, ip: "10.0.0.5" });
  assert.equal(gone.statusCode, 503);
  assert.equal(down.events[0].outcome, "failed");
});

test("only an administrator reaches the decision", async () => {
  const channel = fakeChannel();
  const t = setup(channel, "operator");
  assert.equal((await t.call(DECIDE, { headers: {}, body: { incidentId: "a", decision: "rejected" } })).statusCode, 403);
  assert.equal(channel.calls.length, 0);
  assert.equal(t.events.length, 0);
});

test("the name sent to the watchdog keeps to the characters it accepts", async () => {
  const channel = fakeChannel();
  const t = setup(channel, "admin", "Ana María@casa");
  await t.call(DECIDE, { headers: {}, body: { incidentId: "a", decision: "rejected" }, ip: "10.0.0.5" });
  assert.deepEqual(channel.calls, [["a", "rejected", "Ana_Mar_a_casa"]]);
});
