import assert from "node:assert/strict";
import { test } from "node:test";
import { registerPowerRoutes } from "../src/routes/powerRoutes.ts";

function setup() {
  const handlers: Record<string, any> = {};
  const app: any = { post(route: string, h: unknown) { handlers[route] = h; } };
  const events: any[] = [];
  registerPowerRoutes(app, { audit: { record: (e: any) => { events.push(e); return null; } } });
  const call = (route: string, remoteAddress: string, headers: Record<string, string> = {}) => {
    let status = 200;
    const res: any = { status(c: number) { status = c; return res; }, json() { return res; } };
    handlers[route]({ path: route, ip: remoteAddress, socket: { remoteAddress }, headers }, res);
    return status;
  };
  return { call, events };
}

test("a power request from another machine is refused and audited with its address", () => {
  const t = setup();
  assert.equal(t.call("/api/system/reboot", "10.0.0.7"), 403);
  assert.equal(t.events.length, 1);
  assert.equal(t.events[0].type, "power-reboot");
  assert.equal(t.events[0].outcome, "refused");
  assert.equal(t.events[0].ip, "10.0.0.7");
  assert.ok(typeof t.events[0].detail.reason === "string");
});

test("a refused shutdown is recorded under its own type", () => {
  const t = setup();
  assert.equal(t.call("/api/system/shutdown", "10.0.0.7"), 403);
  assert.equal(t.events[0].type, "power-shutdown");
});
