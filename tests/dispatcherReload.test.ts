import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { reloadDispatcher, resolveReload, type ReloadDeps } from "../src/dispatcherReload.ts";
import { SecurityConfig } from "../src/securityConfig.ts";

// The dispatcher is asked to read its configuration file again after the server wrote the two replanning options.

function deps(status: number | "throw", body: unknown = {}, settings = { url: "http://127.0.0.1:8090", token: "tok", timeoutMs: 3000 }) {
  const calls: { url: string; method: string; auth?: string }[] = [];
  const d: ReloadDeps = {
    settings,
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization });
      if (status === "throw") throw new Error("down");
      return { status, json: async () => body };
    },
  };
  return { d, calls };
}

test("the settings come from the environment, the address of the stop relay is the fallback and a wrong timeout is an error", () => {
  const fromEnv = resolveReload({ HYDRA_UMC_JOB_DISPATCHER_URL: "http://a:8090/", JOB_DISPATCHER_TOKEN: "t1" }, undefined, "http://file");
  assert.ok(fromEnv.ok && fromEnv.settings.url === "http://a:8090" && fromEnv.settings.token === "t1" && fromEnv.settings.timeoutMs === 3000);
  const fromFile = resolveReload({ HYDRA_UMC_JOB_DISPATCHER_TOKEN: "t2", JOB_DISPATCHER_TOKEN: "t1" }, { timeoutMs: 500 }, "http://file/");
  assert.ok(fromFile.ok && fromFile.settings.url === "http://file" && fromFile.settings.token === "t2" && fromFile.settings.timeoutMs === 500);
  const none = resolveReload({}, undefined, undefined);
  assert.ok(none.ok && none.settings.url === "");
  for (const bad of [{ timeoutMs: 50 }, { timeoutMs: 100000 }, { timeoutMs: "3" }, { timeoutMs: NaN }]) assert.ok(!resolveReload({}, bad, undefined).ok, JSON.stringify(bad));
});

test("a reload that works is a POST to the route with the token; nothing is called without an address", async () => {
  const { d, calls } = deps(200);
  assert.deepEqual(await reloadDispatcher(d), { ok: true });
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:8090/admin/reload-config", method: "POST", auth: "Bearer tok" }]);
  const empty = deps(200, {}, { url: "", token: "", timeoutMs: 3000 });
  assert.deepEqual(await reloadDispatcher(empty.d), { ok: false, reason: "no address of the dispatcher is set" });
  assert.equal(empty.calls.length, 0);
});

test("every way it can fail says why and never throws", async () => {
  const cases: [number | "throw", unknown, RegExp][] = [
    [422, { error: "configuration: bad", kept: "the previous values" }, /refused the file and kept its previous values: configuration: bad/],
    [404, {}, /without a configuration file/],
    [403, {}, /own machine/],
    [500, { error: "boom" }, /answered 500: boom/],
    ["throw", {}, /does not answer/],
  ];
  for (const [status, body, text] of cases) {
    const outcome = await reloadDispatcher(deps(status, body).d);
    assert.ok(!outcome.ok && text.test(outcome.reason), `${status}: ${JSON.stringify(outcome)}`);
  }
});

test("the replanning options trigger the reload once they are written, the snapshot shows what came of it, and nothing else triggers it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jd-reload-"));
  const file = path.join(dir, "dispatcher.json");
  let stored: any = {};
  let state: "not_configured" | "none" | "pending" | "applied" | "failed" = "none";
  let asked = 0;
  const config = new SecurityConfig({
    env: { jobDispatcherConfig: file }, load: () => ({ ...stored }), save: (f) => { stored = { ...f }; }, tlsActive: false,
    afterReplanWritten: () => { asked += 1; state = "pending"; },
    dispatcherReload: () => state,
  });
  assert.deepEqual([config.snapshot().jobDispatcher.replan.reload, config.snapshot().jobDispatcher.replan.appliesOnDispatcherRestart], ["none", true]);
  config.update({ jobDispatcher: { stopRelay: { enabled: true, robotMap: { a: 1 } } } }, "root");
  assert.equal(asked, 0, "the switch and the map are not in the file of the dispatcher");
  config.update({ jobDispatcher: { replan: { allowUnconfirmed: true } } }, "root");
  assert.equal(asked, 1);
  assert.equal(config.snapshot().jobDispatcher.replan.reload, "pending");
  assert.equal(config.snapshot().jobDispatcher.replan.appliesOnDispatcherRestart, true);
  state = "applied";
  assert.deepEqual([config.snapshot().jobDispatcher.replan.reload, config.snapshot().jobDispatcher.replan.appliesOnDispatcherRestart], ["applied", false]);
  state = "failed";
  assert.equal(config.snapshot().jobDispatcher.replan.appliesOnDispatcherRestart, true);
  // a refused change asks nothing
  assert.throws(() => config.update({ jobDispatcher: { replan: { stopAckTimeoutSeconds: 0 } } }, "root"));
  assert.equal(asked, 1);
});

test("without a way to reload, the snapshot says it is not configured and the change waits for the next start", () => {
  const config = new SecurityConfig({ env: {}, load: () => ({}), save: () => undefined, tlsActive: false });
  const replan = config.snapshot().jobDispatcher.replan;
  assert.deepEqual([replan.reload, replan.appliesOnDispatcherRestart], ["not_configured", true]);
});
