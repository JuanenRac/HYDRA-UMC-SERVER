import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerWorksRoutes } from "../src/routes/worksRoutes.ts";

function setup(requireAttribution = false) {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "submit-attribution-"));
  const handlers: Record<string, any> = {};
  const app: any = {
    post(route: string, ...h: unknown[]) { handlers[`POST ${route}`] = h[h.length - 1]; },
    get(route: string, ...h: unknown[]) { handlers[`GET ${route}`] = h[h.length - 1]; },
  };
  const events: any[] = [];
  registerWorksRoutes(app, {
    authenticate: () => undefined, requireAdmin: () => undefined, infoAccess: () => undefined,
    dataPath, getSettings: () => ({ modelSubmissions: { enabled: true, requireAttribution } }),
    audit: { record: (e: any) => { events.push(e); return null; } },
  });
  const run = (key: string, req: any) => {
    let status = 200;
    let body: any;
    const res: any = { status(c: number) { status = c; return res; }, json(b: any) { body = b; return res; } };
    handlers[key]({ user: { id: "u1", username: "root", role: "admin" }, ip: "10.0.0.5", params: {}, ...req }, res);
    return { status, body };
  };
  return { events, dataPath, submit: (body: any) => run("POST /api/models/submit", { body }), list: () => run("GET /api/models", {}), download: (category: string, slug: string) => run("GET /api/models/:category/:slug/download", { params: { category, slug } }) };
}

const model = { name: "Arm", category: "robots", urdfXml: "<robot name='a'/>" };
const credit = "Base: CC-BY 4.0, by Someone (https://example.org/arm)";

test("the attribution is kept in the index, beside the model and in the download, and the audit only counts it", () => {
  const t = setup();
  assert.equal(t.submit({ ...model, attribution: `  ${credit}  ` }).status, 200);
  assert.equal(t.list().body.models[0].attribution, credit);
  const folder = path.join(t.dataPath, t.list().body.models[0].folder);
  assert.equal(fs.readFileSync(path.join(folder, "ATTRIBUTION.txt"), "utf-8"), credit + "\n");
  assert.equal(t.download("robots", "arm").body.attribution, credit);
  assert.equal(t.events[0].detail.attributionChars, credit.length);
  assert.ok(!JSON.stringify(t.events[0]).includes("CC-BY"));
});

test("a submission without attribution still works by default and leaves no credit behind", () => {
  const t = setup();
  assert.equal(t.submit({ ...model, attribution: credit }).status, 200);
  assert.equal(t.submit({ ...model, overwrite: true }).status, 200);
  const entry = t.list().body.models[0];
  assert.equal(entry.attribution, undefined);
  assert.equal(fs.existsSync(path.join(t.dataPath, entry.folder, "ATTRIBUTION.txt")), false);
});

test("an attribution that is not text or is too long is refused", () => {
  const t = setup();
  assert.equal(t.submit({ ...model, attribution: 5 }).status, 400);
  assert.equal(t.submit({ ...model, attribution: "x".repeat(8001) }).status, 400);
  assert.equal(t.submit({ ...model, attribution: "x".repeat(8000) }).status, 200);
});

test("with requireAttribution on, a submission without credit is refused and audited", () => {
  const t = setup(true);
  assert.equal(t.submit(model).status, 400);
  assert.equal(t.submit({ ...model, attribution: "   " }).status, 400);
  assert.equal(t.events[0].outcome, "refused");
  assert.equal(t.events[0].detail.reason, "attribution-required");
  assert.equal(t.submit({ ...model, attribution: credit }).status, 200);
});
