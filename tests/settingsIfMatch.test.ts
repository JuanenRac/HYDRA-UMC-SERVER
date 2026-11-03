import assert from "node:assert/strict";
import { test } from "node:test";
import { registerSettingsRoutes } from "../src/routes/settings.ts";
import { settingsRevision } from "../src/serverPolicy.ts";

function settingsApp(initial: any) {
  const handlers: Record<string, (req: any, res: any) => Promise<unknown> | unknown> = {};
  const app: any = {
    get(route: string, ...chain: unknown[]) { handlers[`GET ${route}`] = chain[chain.length - 1] as any; },
    post(route: string, ...chain: unknown[]) { handlers[`POST ${route}`] = chain[chain.length - 1] as any; },
    put(route: string, ...chain: unknown[]) { handlers[`PUT ${route}`] = chain[chain.length - 1] as any; },
  };
  let current = initial;
  registerSettingsRoutes(app, {
    authenticate: () => undefined,
    requireAdmin: () => undefined,
    loadFullSettingsFromDisk: () => current,
    getSettings: () => current,
    applySettingsUpdate: async (payload: any) => { current = payload; },
  });
  const call = async (key: string, req: any = {}) => {
    let status = 200;
    let json: any;
    const headers: Record<string, string> = {};
    const res: any = { setHeader(k: string, v: string) { headers[k] = v; }, status(code: number) { status = code; return res; }, json(value: any) { json = value; return res; } };
    await handlers[key]({ headers: {}, body: {}, user: { role: "admin" }, ...req }, res);
    return { status, json, headers };
  };
  return { call, current: () => current };
}

const tree = { racks: [{ id: "r1" }], controllers: [] };
const next = { racks: [{ id: "r1" }, { id: "r2" }], controllers: [] };

test("GET /api/settings answers the ETag that PUT asks back", async () => {
  const t = settingsApp(tree);
  const r = await t.call("GET /api/settings");
  assert.equal(r.headers.ETag, `"${settingsRevision(tree)}"`);
});

test("PUT /api/settings without If-Match answers 428 and changes nothing", async () => {
  const t = settingsApp(tree);
  for (const headers of [{}, { "if-match": "" }, { "if-match": "*" }]) {
    const r = await t.call("PUT /api/settings", { headers, body: next });
    assert.equal(r.status, 428);
    assert.equal(r.json.code, "if_match_required");
    assert.match(r.json.error, /If-Match/);
  }
  assert.equal(t.current(), tree);
});

test("PUT /api/settings with a stale If-Match answers 412 with the current revision and changes nothing", async () => {
  const t = settingsApp(tree);
  const r = await t.call("PUT /api/settings", { headers: { "if-match": '"0000000000000000"' }, body: next });
  assert.equal(r.status, 412);
  assert.equal(r.json.code, "settings_changed");
  assert.equal(r.json.revision, settingsRevision(tree));
  assert.equal(t.current(), tree);
});

test("PUT /api/settings with the current ETag saves and answers the new ETag; the old one is then stale", async () => {
  const t = settingsApp(tree);
  const etag = (await t.call("GET /api/settings")).headers.ETag;
  const ok = await t.call("PUT /api/settings", { headers: { "if-match": etag }, body: next });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.success, true);
  assert.equal(ok.headers.ETag, `"${settingsRevision(next)}"`);
  assert.equal(t.current(), next);
  const again = await t.call("PUT /api/settings", { headers: { "if-match": etag }, body: tree });
  assert.equal(again.status, 412);
  assert.equal(t.current(), next);
});

test("a weak or listed If-Match is understood", async () => {
  const t = settingsApp(tree);
  const rev = settingsRevision(tree);
  const r = await t.call("PUT /api/settings", { headers: { "if-match": `"zzz", W/"${rev}"` }, body: next });
  assert.equal(r.status, 200);
});
