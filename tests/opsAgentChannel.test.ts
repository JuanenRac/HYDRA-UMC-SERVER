// =============================================================================
// HYDRA-UMC-SERVER - Unit tests for the signed channel to the node watchdog
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The client signs the way the edge verifies (vectors written by the edge's own Python code) and accepts only a reply that is signed,
// addressed to this server, fresh and new.
import test from "node:test";
import assert from "node:assert/strict";
import {
  OpsAgentChannel, canonicalJson, parseKeepingNumbers, parseRegistry, sign, channelFromEnv, ChannelError, type Message,
} from "../src/opsAgentChannel.ts";

const SECRET = "0123456789abcdef-secret";
const EDGE_SECRET = "edge-secret-0123456789abcdef";
const REGISTRY = { "hydra-umc-server": SECRET, edge: EDGE_SECRET };

// written by incident_transport.py of the edge (HMAC-SHA256 over json.dumps(sort_keys=True, separators=(",", ":")))
const VECTOR_REQUEST = {
  message_id: "m1", from_node: "hydra-umc-server", to_node: "edge", kind: "ack", contract_version: "incident-transport/1", nonce: "n1",
  sent_at: 1730000000.25, payload: { op: "proposal-decide", incidentId: "inc-ñ-1", decision: "approved", by: "root" },
};
const VECTOR_REQUEST_MAC = "af8a240b290ab07452ccee5d6138aab87d3e5f4309e00e28a87430de89be6c11";
const VECTOR_REPLY_TEXT = '{"message_id": "m2", "from_node": "edge", "to_node": "hydra-umc-server", "kind": "ack", "contract_version": "incident-transport/1", "nonce": "n2", "sent_at": 1730000000.0, "payload": {"ok": true, "op": "proposals", "result": {"pending": [{"incident": {"incidentId": "a", "score": 1.0, "n": 2, "t": "\\u00e9\\u007f\\n"}}], "decided": []}}, "mac": "8553b71fb730d567e8286e72fe1c9e18274409e9f9cbf3da9683091aa97754f6"}';

test("the signature of a request equals the one the edge computes", () => {
  assert.equal(sign(VECTOR_REQUEST as Message, SECRET), VECTOR_REQUEST_MAC);
});

test("a whole-number sent_at is written as a float, as the edge writes it", () => {
  assert.match(canonicalJson({ sent_at: 5, n: 5 }, new Set(["sent_at"])), /"n":5,"sent_at":5\.0/);
});

test("the signature of a reply with floats, accents and a control character equals the one the edge computes", () => {
  const reply = parseKeepingNumbers(VECTOR_REPLY_TEXT) as Message;
  assert.equal(sign(reply, SECRET), reply.mac);
});

interface EdgeOptions { secret?: string; nowMs: () => number; mutate?: (body: any) => void }

function edge(handlerResult: (op: string, payload: any) => any, opts: EdgeOptions) {
  const seenRequests: any[] = [];
  let counter = 0;
  const fetchImpl = (async (_url: string, init: any) => {
    const request = JSON.parse(init.body);
    seenRequests.push({ request, headers: init.headers });
    const { mac, ...rest } = request;
    const good = sign(rest, SECRET) === mac;
    const result = good ? handlerResult(request.payload.op, request.payload) : null;
    const body: any = {
      message_id: "r" + ++counter, from_node: "edge", to_node: request.from_node, kind: "ack", contract_version: "incident-transport/1",
      nonce: "reply-nonce-" + counter, sent_at: opts.nowMs() / 1000,
      payload: good ? { ok: true, op: request.payload.op, result } : { ok: false, code: "bad-signature", reason: "no" },
    };
    body.mac = sign(body, opts.secret ?? EDGE_SECRET);
    opts.mutate?.(body);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seenRequests };
}

const NOW = 1_730_000_000_500;
function channel(e: { fetchImpl: typeof fetch }, extra: Partial<ConstructorParameters<typeof OpsAgentChannel>[0]> = {}) {
  return new OpsAgentChannel({ url: "http://127.0.0.1:1", localNode: "hydra-umc-server", edgeNode: "edge", registry: REGISTRY, fetchImpl: e.fetchImpl, now: () => NOW, ...extra });
}

function resign(body: any) {
  const { mac: _mac, ...rest } = body;
  body.mac = sign(rest, EDGE_SECRET);
}

async function refused(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof ChannelError && error.code === code);
}

test("listing sends a signed request with the node header and returns the result as plain values", async () => {
  const e = edge(() => ({ pending: [{ incident: { incidentId: "a", score: 1 } }], decided: [] }), { nowMs: () => NOW });
  const result = await channel(e).proposals();
  assert.equal((result.pending as any[])[0].incident.incidentId, "a");
  const sent = e.seenRequests[0];
  assert.equal(sent.headers["X-Ops-Node"], "hydra-umc-server");
  assert.equal(sent.request.payload.op, "proposals");
  assert.equal(sent.request.kind, "incident");
  assert.equal(sent.request.contract_version, "incident-transport/1");
});

test("a decision carries incidentId, decision and who decides, in a message of kind ack", async () => {
  const e = edge((_op, p) => ({ incidentId: p.incidentId, decision: p.decision }), { nowMs: () => NOW });
  const result = await channel(e).decide("inc-1", "approved", "root");
  assert.deepEqual(result, { incidentId: "inc-1", decision: "approved" });
  assert.deepEqual(e.seenRequests[0].request.payload, { op: "proposal-decide", incidentId: "inc-1", decision: "approved", by: "root" });
  assert.equal(e.seenRequests[0].request.kind, "ack");
});

test("a reply signed with another secret, for another node, from another node, stale, of another version or repeated is refused", async () => {
  await refused(channel(edge(() => ({}), { nowMs: () => NOW, secret: "another-secret-0123456789" })).proposals(), "reply-bad-signature");
  await refused(channel(edge(() => ({}), { nowMs: () => NOW, mutate: (b) => { b.to_node = "someone"; resign(b); } })).proposals(), "reply-wrong-recipient");
  await refused(channel(edge(() => ({}), { nowMs: () => NOW, mutate: (b) => { b.from_node = "hydra-umc-server"; resign(b); } })).proposals(), "reply-impersonation");
  await refused(channel(edge(() => ({}), { nowMs: () => NOW - 500_000 })).proposals(), "reply-stale");
  await refused(channel(edge(() => ({}), { nowMs: () => NOW, mutate: (b) => { b.contract_version = "incident-transport/2"; resign(b); } })).proposals(), "reply-incompatible-version");
  const same = edge(() => ({}), { nowMs: () => NOW, mutate: (b) => { b.nonce = "fixed"; resign(b); } });
  const c = channel(same);
  await c.proposals();
  await refused(c.proposals(), "reply-replay");
});

test("an unsigned refusal of the edge keeps its code; an unreachable edge and a failed operation are named", async () => {
  const unsigned = (async () => new Response(JSON.stringify({ ok: false, code: "bad-signature", reason: "the HMAC does not match" }), { status: 401 })) as unknown as typeof fetch;
  await refused(channel({ fetchImpl: unsigned }).proposals(), "bad-signature");
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  await refused(channel({ fetchImpl: down }).proposals(), "unreachable");
  const failed = edge(() => ({}), { nowMs: () => NOW, mutate: (b) => { b.payload = { ok: false, code: "operation-failed", reason: "not-pending" }; resign(b); } });
  await refused(channel(failed).decide("x", "rejected", "root"), "operation-failed");
});

test("the registry must name both nodes, with long enough secrets, and an error never repeats a secret", () => {
  assert.throws(() => new OpsAgentChannel({ url: "u", localNode: "a", edgeNode: "edge", registry: REGISTRY }), ChannelError);
  assert.throws(() => parseRegistry("{"), ChannelError);
  assert.throws(() => parseRegistry('{"nodes":{}}'), ChannelError);
  assert.throws(() => parseRegistry('{"nodes":{"n":"short-secret"}}'), (error: unknown) => error instanceof ChannelError && !error.message.includes("short-secret"));
  assert.deepEqual(parseRegistry(JSON.stringify({ nodes: REGISTRY })), REGISTRY);
});

test("without an address or a registry file the channel is not set up; with both it is read from the file", () => {
  assert.equal(channelFromEnv({}), null);
  assert.equal(channelFromEnv({ HYDRA_UMC_OPS_AGENT_URL: "http://x" }), null);
  const env = { HYDRA_UMC_OPS_AGENT_URL: "http://x", HYDRA_UMC_OPS_AGENT_REGISTRY_FILE: "reg.json" };
  assert.ok(channelFromEnv(env, { read: () => JSON.stringify({ nodes: REGISTRY }) }) instanceof OpsAgentChannel);
  assert.throws(() => channelFromEnv(env, { read: () => { throw new Error("secret path"); } }), (e: unknown) => e instanceof ChannelError && e.code === "registry-unreadable");
});
