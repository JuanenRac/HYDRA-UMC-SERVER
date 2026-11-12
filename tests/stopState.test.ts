// The one stop state for the apps: the physical stop together with the global stop. Read only, off unless the watch is switched on, and a silent bridge is never read as a released stop.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StopState, bridgeFetcher, parseBridgeEstop, stopWatchIntervalMs, unify, type BridgeEstop, type StopStateSnapshot } from "../src/stopState";

function make(answers: Array<BridgeEstop | null | "throw">) {
  const seen: StopStateSnapshot[] = [];
  let i = 0;
  let clock = 1000;
  const state = new StopState({
    fetchPhysical: async () => {
      const next = answers[Math.min(i++, answers.length - 1)];
      if (next === "throw") throw new Error("bridge down");
      return next;
    },
    onChange: (s) => seen.push(s),
    now: () => (clock += 10),
  });
  return { state, seen };
}

const latched: BridgeEstop = { online: true, latched: true, linkOk: true };
const ready: BridgeEstop = { online: true, latched: false, linkOk: true };

describe("the answer of the bridge", () => {
  it("is read only when it is well formed", () => {
    assert.deepEqual(parseBridgeEstop({ online: true, latched: true, link_ok: true }), { online: true, latched: true, linkOk: true });
    assert.deepEqual(parseBridgeEstop({ online: true, latched: false }), { online: true, latched: false, linkOk: null });
    assert.deepEqual(parseBridgeEstop({ online: false, latched: null }), { online: false, latched: null, linkOk: null });
    for (const bad of [null, undefined, 3, "x", [], {}, { online: "yes" }, { online: true }, { online: true, latched: "no" }]) {
      assert.equal(parseBridgeEstop(bad), null, JSON.stringify(bad));
    }
  });
});

describe("the interval of the watch", () => {
  it("is off unless the variable holds a whole number from 500 to 60000", () => {
    assert.equal(stopWatchIntervalMs({}), 0);
    assert.equal(stopWatchIntervalMs({ HYDRA_UMC_ESTOP_WATCH_MS: "" }), 0);
    assert.equal(stopWatchIntervalMs({ HYDRA_UMC_ESTOP_WATCH_MS: "0" }), 0);
    assert.equal(stopWatchIntervalMs({ HYDRA_UMC_ESTOP_WATCH_MS: "499" }), 0);
    assert.equal(stopWatchIntervalMs({ HYDRA_UMC_ESTOP_WATCH_MS: "500" }), 500);
    assert.equal(stopWatchIntervalMs({ HYDRA_UMC_ESTOP_WATCH_MS: " 2000 " }), 2000);
    assert.equal(stopWatchIntervalMs({ HYDRA_UMC_ESTOP_WATCH_MS: "60000" }), 60000);
    assert.equal(stopWatchIntervalMs({ HYDRA_UMC_ESTOP_WATCH_MS: "60001" }), 0);
    assert.equal(stopWatchIntervalMs({ HYDRA_UMC_ESTOP_WATCH_MS: "1e3" }), 0);
    assert.equal(stopWatchIntervalMs({ HYDRA_UMC_ESTOP_WATCH_MS: "-5" }), 0);
  });
});

describe("the unified state", () => {
  it("is STOPPED when either stop is on, READY only when the physical stop is known to be released, UNKNOWN otherwise", () => {
    assert.equal(unify("latched", "ready"), "STOPPED");
    assert.equal(unify("ready", "stopped"), "STOPPED");
    assert.equal(unify("latched", "stopped"), "STOPPED");
    assert.equal(unify("unknown", "stopped"), "STOPPED");
    assert.equal(unify("ready", "ready"), "READY");
    assert.equal(unify("unknown", "ready"), "UNKNOWN");
  });

  it("starts unknown, with the schema, no source and no change", () => {
    const { state } = make([ready]);
    assert.deepEqual(state.snapshot(), { schema: 1, state: "UNKNOWN", physical: "unknown", software: "ready", physicalLinkOk: null, source: "none", changedAt: 0 });
  });
});

describe("following the bridge", () => {
  it("takes a latched stop and its release, and tells the clients of each change once", async () => {
    const { state, seen } = make([latched, latched, ready, ready]);
    await state.poll();
    assert.equal(state.snapshot().state, "STOPPED");
    assert.equal(state.snapshot().source, "brain-telemetry");
    assert.equal(state.snapshot().physicalLinkOk, true);
    await state.poll();
    assert.equal(seen.length, 1, "the same answer is not a change");
    await state.poll();
    assert.equal(state.snapshot().state, "READY");
    await state.poll();
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((s) => s.state), ["STOPPED", "READY"]);
    assert.ok(seen[1].changedAt > seen[0].changedAt);
  });

  it("never reads a silent, failing or unintelligible bridge as a released stop", async () => {
    for (const bad of [null, "throw" as const, { online: false, latched: null, linkOk: null }]) {
      const { state, seen } = make([latched, bad]);
      await state.poll();
      await state.poll();
      assert.equal(state.snapshot().physical, "unknown");
      assert.equal(state.snapshot().state, "UNKNOWN");
      assert.equal(state.snapshot().source, "none");
      assert.equal(seen.length, 2);
    }
  });

  it("a silent bridge does not hide a global stop", async () => {
    const { state } = make([null]);
    state.setSoftware(true);
    await state.poll();
    assert.equal(state.snapshot().state, "STOPPED");
    assert.equal(state.snapshot().software, "stopped");
  });

  it("the global stop and its release are tracked and announced, also without the watch", () => {
    const { state, seen } = make([null]);
    state.setSoftware(true);
    state.setSoftware(true);
    assert.equal(seen.length, 1);
    state.setSoftware(false);
    assert.deepEqual(seen.map((s) => s.state), ["STOPPED", "UNKNOWN"]);
  });

  it("the global stop released does not release a latched physical stop", async () => {
    const { state } = make([latched]);
    state.setSoftware(true);
    await state.poll();
    state.setSoftware(false);
    assert.equal(state.snapshot().state, "STOPPED");
    assert.equal(state.snapshot().physical, "latched");
  });

  it("a failure of the listener never reaches the poll or the stop", async () => {
    const state = new StopState({ fetchPhysical: async () => latched, onChange: () => { throw new Error("socket closed"); } });
    await state.poll();
    state.setSoftware(true);
    assert.equal(state.snapshot().state, "STOPPED");
  });

  it("two polls at once make one reading", async () => {
    let calls = 0;
    const state = new StopState({ fetchPhysical: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return latched; }, onChange: () => {} });
    await Promise.all([state.poll(), state.poll()]);
    assert.equal(calls, 1);
  });

  it("start with an interval of 0 does nothing, and stop is safe to repeat", async () => {
    let calls = 0;
    const state = new StopState({ fetchPhysical: async () => { calls++; return ready; }, onChange: () => {} });
    state.start(0);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 0);
    state.stop();
    state.stop();
  });
});

describe("asking the bridge", () => {
  const fakeFetch = (handler: (url: string, init: any) => Response | Promise<Response>): typeof fetch => (async (url: any, init: any) => handler(String(url), init)) as unknown as typeof fetch;

  it("reads GET /estop with the headers of the service and a timeout", async () => {
    let seenUrl = "";
    let seenHeaders: any;
    let seenSignal: any;
    const fetcher = bridgeFetcher("http://127.0.0.1:8765/", () => ({ Authorization: "Bearer t" }), 2000, fakeFetch((url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      seenSignal = init.signal;
      return new Response(JSON.stringify({ online: true, latched: true, link_ok: false }), { status: 200 });
    }));
    assert.deepEqual(await fetcher(), { online: true, latched: true, linkOk: false });
    assert.equal(seenUrl, "http://127.0.0.1:8765/estop");
    assert.deepEqual(seenHeaders, { Authorization: "Bearer t" });
    assert.ok(seenSignal);
  });

  it("is null without an address, on an error status, on a body that is not JSON and on a network failure", async () => {
    assert.equal(await bridgeFetcher("", () => ({}), 100, fakeFetch(() => new Response("{}")))(), null);
    assert.equal(await bridgeFetcher("http://x", () => ({}), 100, fakeFetch(() => new Response("{}", { status: 503 })))(), null);
    assert.equal(await bridgeFetcher("http://x", () => ({}), 100, fakeFetch(() => new Response("not json", { status: 200 })))(), null);
    assert.equal(await bridgeFetcher("http://x", () => ({}), 100, fakeFetch(() => { throw new Error("refused"); }))(), null);
  });
});
