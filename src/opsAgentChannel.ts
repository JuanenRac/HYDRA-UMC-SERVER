// =============================================================================
// HYDRA-UMC-SERVER - src/opsAgentChannel.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The client of the authenticated channel of HYDRA-UMC-OPS-AGENT (`incident-transport/1`), so that STUDIO and SUITE can list the
// proposals of the node watchdog that wait for a person and approve or reject them.
//
// Wire format (the one the edge verifies): a message is a JSON object {message_id, from_node, to_node, kind, contract_version, nonce,
// sent_at, payload, mac}; the mac is HMAC-SHA256, with the shared secret of the sending node, over the canonical JSON of the message
// without the mac (keys sorted, no spaces, non-ASCII escaped as \uXXXX, `sent_at` a float in seconds). The edge refuses a node it does
// not know, one that speaks as another, a message for someone else, another version, a bad signature, a time outside the window, a
// repeated nonce and too many messages a minute. This client signs its request, then accepts only a reply that is signed by the edge,
// addressed to this server, fresh and with a nonce not seen before.
//
// The secrets are read from a registry file of the same shape the edge reads ({"nodes": {"<node>": "<secret>"}}); the file is named by
// the environment and is never part of a repository. Nothing here prints a secret.
import crypto from "node:crypto";
import fs from "node:fs";

export const CONTRACT_VERSION = "incident-transport/1";
export const MIN_SECRET_LENGTH = 16;
const NODE_HEADER = "X-Ops-Node";

/** Which kind of message carries which operation of the edge (as the edge's own table has it). */
const OPERATION_KIND: Record<string, string> = { proposals: "incident", "proposal-decide": "ack" };

export class ChannelError extends Error {
  constructor(public code: string, public reason: string) {
    super(`${code}: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON, the way the edge (Python json.dumps(sort_keys=True, separators=(",", ":"))) writes it
// ---------------------------------------------------------------------------
/** A number as it came on the wire: kept as its text so the signature is computed over what the edge wrote. */
export class RawNumber {
  constructor(public text: string) {}
}

function quote(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (code > 0xffff) {
      const v = code - 0x10000;
      out += "\\u" + (0xd800 + (v >> 10)).toString(16).padStart(4, "0") + "\\u" + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
    } else out += "\\u" + code.toString(16).padStart(4, "0");
  }
  return out + '"';
}

function number(value: number, asFloat: boolean): string {
  if (!Number.isFinite(value)) throw new ChannelError("malformed", "a number in the message is not finite");
  if (Number.isInteger(value)) return asFloat ? value.toFixed(1) : String(value);
  return String(value);
}

function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** The canonical text of `value`. `floatKeys` names the keys (at any depth) whose whole numbers are written with ".0", as a float. */
export function canonicalJson(value: unknown, floatKeys: ReadonlySet<string> = new Set(), asFloat = false): string {
  if (value === null) return "null";
  if (value instanceof RawNumber) return value.text;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return number(value, asFloat);
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item, floatKeys, false)).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort(compareCodePoints).map((key) => quote(key) + ":" + canonicalJson(record[key], floatKeys, floatKeys.has(key))).join(",") + "}";
  }
  throw new ChannelError("malformed", "a value in the message cannot be written as JSON");
}

/** Parses JSON keeping every number as its text (so a float written as 1.0 stays 1.0 when the reply is checked). */
export function parseKeepingNumbers(text: string): unknown {
  let i = 0;
  const fail = (): never => { throw new ChannelError("malformed", "the reply is not JSON"); };
  const ws = () => { while (i < text.length && " \t\r\n".includes(text[i])) i++; };
  const str = (): string => {
    if (text[i] !== '"') fail();
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) fail();
    const raw = text.slice(i, j + 1);
    i = j + 1;
    try { return JSON.parse(raw) as string; } catch { return fail(); }
  };
  const val = (depth: number): unknown => {
    if (depth > 64) fail();
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const out: Record<string, unknown> = {}; ws();
      if (text[i] === "}") { i++; return out; }
      for (;;) {
        ws(); const key = str(); ws();
        if (text[i++] !== ":") fail();
        out[key] = val(depth + 1); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i++] === "}") return out;
        fail();
      }
    }
    if (c === "[") {
      i++; const out: unknown[] = []; ws();
      if (text[i] === "]") { i++; return out; }
      for (;;) {
        out.push(val(depth + 1)); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i++] === "]") return out;
        fail();
      }
    }
    if (c === '"') return str();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) return fail();
    i += m[0].length;
    return new RawNumber(m[0]);
  };
  const result = val(0);
  ws();
  if (i !== text.length) fail();
  return result;
}

// ---------------------------------------------------------------------------
// Registry and messages
// ---------------------------------------------------------------------------
export type Registry = Record<string, string>;

/** `{"nodes": {"<node>": "<secret of at least 16 characters>"}}`; anything else raises (the reason never holds a secret). */
export function parseRegistry(text: string): Registry {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ChannelError("registry-invalid", "the node registry is not JSON"); }
  const nodes = raw && typeof raw === "object" ? (raw as { nodes?: unknown }).nodes : undefined;
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes) || Object.keys(nodes).length === 0) {
    throw new ChannelError("registry-invalid", 'the node registry must be an object with a non-empty "nodes" object');
  }
  for (const [id, secret] of Object.entries(nodes as Record<string, unknown>)) {
    if (!id || typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
      throw new ChannelError("registry-invalid", `the secret of node ${JSON.stringify(id)} must be a string of at least ${MIN_SECRET_LENGTH} characters`);
    }
  }
  return { ...(nodes as Registry) };
}

export function loadRegistry(path: string, read: (p: string) => string = (p) => fs.readFileSync(p, "utf-8")): Registry {
  let text: string;
  try { text = read(path); } catch { throw new ChannelError("registry-unreadable", "the node registry file cannot be read"); }
  return parseRegistry(text);
}

const FLOAT_KEYS: ReadonlySet<string> = new Set(["sent_at"]);

export interface Message {
  message_id: string; from_node: string; to_node: string; kind: string; contract_version: string; nonce: string;
  sent_at: number | RawNumber; payload: Record<string, unknown>; mac?: string;
}

/** The HMAC-SHA256 (hex) of the canonical message without its mac. */
export function sign(message: Omit<Message, "mac"> & { mac?: string }, secret: string): string {
  const { mac: _mac, ...rest } = message;
  return crypto.createHmac("sha256", secret).update(canonicalJson(rest, FLOAT_KEYS), "utf-8").digest("hex");
}

function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf-8"), y = Buffer.from(b, "utf-8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sentAtSeconds(value: unknown): number {
  const n = value instanceof RawNumber ? Number(value.text) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ChannelError("malformed", "'sent_at' must be a number (unix seconds)");
  return n;
}

export interface ChannelConfig {
  url: string;
  localNode: string;
  edgeNode: string;
  registry: Registry;
  timeoutMs?: number;
  replayWindowSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number; // milliseconds
}

/** One edge node as the server sees it. Sends signed requests and accepts only signed, fresh, addressed replies with a new nonce. */
export class OpsAgentChannel {
  private seen = new Map<string, number>();
  constructor(private config: ChannelConfig) {
    for (const node of [config.localNode, config.edgeNode]) {
      if (!config.registry[node]) throw new ChannelError("unknown-identity", `${JSON.stringify(node)} is not in the node registry`);
    }
  }

  private now(): number { return (this.config.now ?? Date.now)(); }

  async request(operation: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const { url, localNode, edgeNode, registry } = this.config;
    const body: Omit<Message, "mac"> = {
      message_id: crypto.randomBytes(8).toString("hex"), from_node: localNode, to_node: edgeNode, kind: OPERATION_KIND[operation] ?? "ack",
      contract_version: CONTRACT_VERSION, nonce: crypto.randomBytes(16).toString("hex"), sent_at: this.now() / 1000, payload: { ...payload, op: operation },
    };
    const wire = { ...body, mac: sign(body, registry[localNode]) };
    let status: number;
    let raw: string;
    try {
      const response = await (this.config.fetchImpl ?? fetch)(url.replace(/\/$/, "") + "/v1/message", {
        method: "POST",
        headers: { "content-type": "application/json", [NODE_HEADER]: localNode },
        body: JSON.stringify(wire),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10000),
      });
      status = response.status;
      raw = await response.text();
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new ChannelError("unreachable", timedOut ? "the edge timed out" : "the edge cannot be reached");
    }
    const document = parseKeepingNumbers(raw);
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new ChannelError("malformed", "the reply is not a JSON object");
    const reply = document as Record<string, unknown>;
    if (!("mac" in reply)) {
      // an unsigned refusal of the edge: it names its reason, which carries no secret
      throw new ChannelError(String(reply.code ?? "refused"), String(reply.reason ?? `the edge refused the request (${status})`));
    }
    this.verifyReply(reply);
    const answer = reply.payload as Record<string, unknown>;
    if (answer.ok !== true) throw new ChannelError(String(answer.code ?? "operation-failed"), String(answer.reason ?? ""));
    const result = answer.result;
    return result && typeof result === "object" && !Array.isArray(result) ? (toPlain(result) as Record<string, unknown>) : { value: toPlain(result) };
  }

  private verifyReply(reply: Record<string, unknown>): void {
    const { localNode, edgeNode, registry } = this.config;
    for (const name of ["message_id", "from_node", "to_node", "kind", "contract_version", "nonce", "mac"]) {
      if (typeof reply[name] !== "string" || !reply[name]) throw new ChannelError("reply-malformed", `'${name}' of the reply must be a non-empty string`);
    }
    if (!reply.payload || typeof reply.payload !== "object" || Array.isArray(reply.payload)) throw new ChannelError("reply-malformed", "'payload' of the reply must be an object");
    if (reply.from_node !== edgeNode) throw new ChannelError("reply-impersonation", "the reply claims another node than the edge");
    if (reply.to_node !== localNode) throw new ChannelError("reply-wrong-recipient", "the reply is for another node");
    const version = reply.contract_version as string;
    if (version !== CONTRACT_VERSION && !version.startsWith("incident-transport/1.")) throw new ChannelError("reply-incompatible-version", "the reply speaks another version");
    const expected = sign(reply as unknown as Message, registry[edgeNode]);
    if (!sameMac(String(reply.mac), expected)) throw new ChannelError("reply-bad-signature", "the HMAC of the reply does not match the registered secret");
    const window = this.config.replayWindowSeconds ?? 120;
    const at = this.now() / 1000;
    if (Math.abs(at - sentAtSeconds(reply.sent_at)) > window) throw new ChannelError("reply-stale", `the reply is outside the ${window}s window`);
    const nonce = reply.nonce as string;
    for (const [old, seenAt] of this.seen) if (at - seenAt > window) this.seen.delete(old);
    if (this.seen.has(nonce)) throw new ChannelError("reply-replay", "the nonce of the reply was already accepted");
    this.seen.set(nonce, at);
  }

  /** The proposals of the node watchdog: those that wait for a person and those already decided. */
  proposals(): Promise<Record<string, unknown>> { return this.request("proposals"); }

  /** Approves or rejects one pending proposal; `by` is who decides (the edge records it). */
  decide(incidentId: string, decision: "approved" | "rejected", by: string): Promise<Record<string, unknown>> {
    return this.request("proposal-decide", { incidentId, decision, by });
  }
}

/** Turns the number tokens of a verified reply into plain numbers, for the clients. */
function toPlain(value: unknown): unknown {
  if (value instanceof RawNumber) return Number(value.text);
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]));
  return value;
}

// ---------------------------------------------------------------------------
// Configuration from the environment
// ---------------------------------------------------------------------------
export type Env = Record<string, string | undefined>;

/**
 * The channel as the environment describes it, or null when it is not set up (the routes then answer 503):
 * HYDRA_UMC_OPS_AGENT_URL (the edge, `transport.bind`/`port`), HYDRA_UMC_OPS_AGENT_REGISTRY_FILE (the registry file, 0600),
 * HYDRA_UMC_OPS_AGENT_LOCAL_NODE (this server, default "hydra-umc-server") and HYDRA_UMC_OPS_AGENT_EDGE_NODE (default "edge").
 */
export function channelFromEnv(env: Env = process.env, opts: { fetchImpl?: typeof fetch; read?: (p: string) => string } = {}): OpsAgentChannel | null {
  const url = (env.HYDRA_UMC_OPS_AGENT_URL ?? "").trim().replace(/\/$/, "");
  const file = (env.HYDRA_UMC_OPS_AGENT_REGISTRY_FILE ?? "").trim();
  if (!url || !file) return null;
  const timeout = Math.min(Math.max(Number(env.HYDRA_UMC_OPS_AGENT_TIMEOUT_MS) || 5000, 250), 30000);
  return new OpsAgentChannel({
    url, localNode: (env.HYDRA_UMC_OPS_AGENT_LOCAL_NODE ?? "").trim() || "hydra-umc-server",
    edgeNode: (env.HYDRA_UMC_OPS_AGENT_EDGE_NODE ?? "").trim() || "edge",
    registry: loadRegistry(file, opts.read), timeoutMs: timeout, fetchImpl: opts.fetchImpl,
  });
}
