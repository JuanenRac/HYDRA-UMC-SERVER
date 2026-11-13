import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CONFIRMABLE_ACTIONS,
  MAX_TTL_SECONDS,
  confirmationEnabled,
  issueConfirmation,
  loadConfirmationKey,
  parseConfirmationRequest,
} from "../src/humanConfirmation.ts";
import { registerConfirmationRoutes } from "../src/routes/confirmationRoutes.ts";

const KEY = Buffer.from("k".repeat(40));
const NOW = 1_800_000_000_000;

function decode(token: string): { head: any; body: any; ok: (key: Buffer) => boolean } {
  const [h, b, s] = token.split(".");
  const read = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  return { head: read(h), body: read(b), ok: (key) => crypto.createHmac("sha256", key).update(`${h}.${b}`).digest("base64url") === s };
}

test("a token has the claims the bridges check and verifies with its key only", () => {
  const issued = issueConfirmation(KEY, { username: "ana", role: "operator" }, { action: "TAKEOFF", jobId: "job-1", ttlSeconds: 60 }, NOW);
  const { head, body, ok } = decode(issued.token);
  assert.deepEqual(head, { alg: "HS256", typ: "JWT" });
  assert.equal(body.purpose, "human-confirmation");
  assert.equal(body.sub, "ana");
  assert.equal(body.role, "operator");
  assert.equal(body.act, "TAKEOFF");
  assert.equal(body.job, "job-1");
  assert.equal(body.exp - body.iat, 60);
  assert.equal(issued.expires_at, body.exp);
  assert.equal(issued.single_use, true);
  assert.equal(ok(KEY), true);
  assert.equal(ok(Buffer.from("z".repeat(40))), false);
});

test("every token has its own jti", () => {
  const a = decode(issueConfirmation(KEY, { username: "a", role: "operator" }, { action: "ARM", jobId: "j", ttlSeconds: 5 }, NOW).token).body.jti;
  const b = decode(issueConfirmation(KEY, { username: "a", role: "operator" }, { action: "ARM", jobId: "j", ttlSeconds: 5 }, NOW).token).body.jti;
  assert.notEqual(a, b);
});

test("the request needs confirm true, a known action, a clean job id and a bounded lifetime", () => {
  const good = parseConfirmationRequest({ action: "WALK_TO", job_id: "job:1", confirm: true });
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.request.ttlSeconds, 60);
  const bad: Array<[unknown, string]> = [
    [null, "invalid-confirmation-request"],
    [[], "invalid-confirmation-request"],
    [{ action: "WALK_TO", job_id: "j" }, "confirmation-not-confirmed"],
    [{ action: "WALK_TO", job_id: "j", confirm: "true" }, "confirmation-not-confirmed"],
    [{ action: "FLY", job_id: "j", confirm: true }, "invalid-confirmation-action"],
    [{ action: "ARM", job_id: "a b", confirm: true }, "invalid-confirmation-job"],
    [{ action: "ARM", job_id: "", confirm: true }, "invalid-confirmation-job"],
    [{ action: "ARM", job_id: "j", confirm: true, ttl_seconds: MAX_TTL_SECONDS + 1 }, "invalid-confirmation-ttl"],
    [{ action: "ARM", job_id: "j", confirm: true, ttl_seconds: 0 }, "invalid-confirmation-ttl"],
    [{ action: "ARM", job_id: "j", confirm: true, ttl_seconds: 1.5 }, "invalid-confirmation-ttl"],
    [{ action: "ARM", job_id: "j", confirm: true, extra: 1 }, "invalid-confirmation-request"],
  ];
  for (const [body, code] of bad) {
    const parsed = parseConfirmationRequest(body);
    assert.equal(parsed.ok, false, JSON.stringify(body));
    assert.equal(!parsed.ok && parsed.code, code, JSON.stringify(body));
  }
  for (const action of CONFIRMABLE_ACTIONS) assert.equal(parseConfirmationRequest({ action, job_id: "j", confirm: true }).ok, true, action);
});

test("the route is off unless a plain yes switches it on", () => {
  assert.equal(confirmationEnabled(undefined), false);
  for (const word of ["1", "true", "on", "yes", " ON "]) assert.equal(confirmationEnabled(word), true, word);
  for (const word of ["0", "off", "no", "2", "enable", ""]) assert.equal(confirmationEnabled(word), false, word);
});

test("the key comes from a file, at least 32 characters; a missing or short one is no key", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "hy-conf-"));
  try {
    const file = path.join(folder, "key");
    assert.equal(loadConfirmationKey(file), null);
    assert.equal(loadConfirmationKey(undefined), null);
    fs.writeFileSync(file, "short");
    assert.equal(loadConfirmationKey(file), null);
    fs.writeFileSync(file, `${"q".repeat(40)}\n`);
    assert.equal(loadConfirmationKey(file)?.toString(), "q".repeat(40));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// a stand-in for express: it keeps the handlers of the route and runs the chain
function mount(deps: { enabled: boolean; key: Buffer | null; role?: string }) {
  let chain: Array<(req: any, res: any, next: any) => unknown> = [];
  const app: any = { post: (_path: string, ...handlers: Array<(req: any, res: any, next: any) => unknown>) => { chain = handlers; } };
  const audit: any[] = [];
  registerConfirmationRoutes(app, {
    authenticate: (_req, _res, next) => next(),
    requireOperator: (_req, _res, next) => next(),
    enabled: () => deps.enabled,
    key: () => deps.key,
    audit: { record: (entry) => audit.push(entry) },
    now: () => NOW,
  });
  const call = (body: unknown) => {
    const result: { status: number; json?: any; headers: Record<string, string> } = { status: 200, headers: {} };
    const res: any = {
      status(code: number) { result.status = code; return res; },
      json(value: unknown) { result.json = value; return res; },
      end() { return res; },
      setHeader(name: string, value: string) { result.headers[name] = value; },
    };
    const req: any = { body, user: { id: "u1", username: "ana", role: deps.role ?? "operator" }, ip: "127.0.0.1" };
    let index = 0;
    const next = (): unknown => (index < chain.length ? chain[index++](req, res, next) : undefined);
    next();
    return result;
  };
  return { call, audit };
}

const GOOD = { action: "TAKEOFF", job_id: "job-1", confirm: true };

test("the route answers 404 while it is off, and issues nothing", () => {
  const { call, audit } = mount({ enabled: false, key: KEY });
  assert.equal(call(GOOD).status, 404);
  assert.equal(audit.length, 0);
});

test("the route issues a token, no-store, and audits the issue without the token", () => {
  const { call, audit } = mount({ enabled: true, key: KEY });
  const answer = call(GOOD);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["Cache-Control"], "no-store");
  assert.equal(decode(answer.json.token).ok(KEY), true);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, "ok");
  assert.equal(JSON.stringify(audit[0]).includes(answer.json.token), false);
});

test("an administrator is named administrator in the token, the way the bridges expect", () => {
  const { call } = mount({ enabled: true, key: KEY, role: "admin" });
  assert.equal(decode(call(GOOD).json.token).body.role, "administrator");
});

test("without a usable key the route answers 503; a bad body answers 400; both are audited", () => {
  const noKey = mount({ enabled: true, key: null });
  const missing = noKey.call(GOOD);
  assert.equal(missing.status, 503);
  assert.equal(missing.json.code, "confirmation-key-missing");
  assert.equal(noKey.audit[0].outcome, "refused");
  const withKey = mount({ enabled: true, key: KEY });
  const refused = withKey.call({ action: "TAKEOFF", job_id: "job-1" });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "confirmation-not-confirmed");
  assert.equal(withKey.audit[0].outcome, "refused");
});
