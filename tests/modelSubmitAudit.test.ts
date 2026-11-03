import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerWorksRoutes } from "../src/routes/worksRoutes.ts";

function setup(enabled = true) {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "submit-audit-"));
  let handler: any;
  const app: any = { post(route: string, ...h: unknown[]) { if (route === "/api/models/submit") handler = h[h.length - 1]; }, get() {} };
  const events: any[] = [];
  registerWorksRoutes(app, {
    authenticate: () => undefined, requireAdmin: () => undefined, infoAccess: () => undefined,
    dataPath, getSettings: () => ({ modelSubmissions: { enabled } }),
    audit: { record: (e: any) => { events.push(e); return null; } },
  });
  const call = (body: any) => {
    let status = 200;
    const res: any = { status(c: number) { status = c; return res; }, json() { return res; } };
    handler({ body, user: { id: "u1", username: "root", role: "admin" }, ip: "10.0.0.5" }, res);
    return status;
  };
  return { call, events, dataPath };
}

const model = { name: "My Arm", category: "robots", urdfXml: "<robot name='secret-geometry'/>", meshFiles: [{ filename: "a.stl", base64: "AAAA" }] };

test("an accepted submission is audited with the account, address, model, category and whether it replaces, and never the content", () => {
  const t = setup();
  assert.equal(t.call(model), 200);
  assert.equal(t.events.length, 1);
  const e = t.events[0];
  assert.equal(e.type, "model-submit");
  assert.equal(e.outcome, "ok");
  assert.equal(e.username, "root");
  assert.equal(e.ip, "10.0.0.5");
  assert.deepEqual(e.detail, { name: "my-arm", category: "robots", replaces: false, meshFiles: 1 });
  assert.ok(!JSON.stringify(e).includes("secret-geometry"));
  assert.ok(!JSON.stringify(e).includes("AAAA"));
});

test("a replacement is audited as replaces:true, and a collision without overwrite as refused", () => {
  const t = setup();
  t.call(model);
  assert.equal(t.call(model), 409);
  assert.equal(t.events[1].outcome, "refused");
  assert.equal(t.call({ ...model, overwrite: true }), 200);
  assert.equal(t.events[2].outcome, "ok");
  assert.equal(t.events[2].detail.replaces, true);
});

test("a submission refused because the switch is off is audited", () => {
  const t = setup(false);
  assert.equal(t.call(model), 403);
  assert.equal(t.events[0].outcome, "refused");
  assert.equal(t.events[0].detail.reason, "submissions-disabled");
});
