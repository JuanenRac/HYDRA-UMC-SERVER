import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { test } from "node:test";
import { Aedes } from "aedes";
import { connect as mqttConnect } from "mqtt";
import { SecurityConfig, SecurityConfigError, type SecurityFile } from "../src/securityConfig.ts";
import { registerInfoRoutes } from "../src/routes/infoRoutes.ts";
import { registerCommandRoutes } from "../src/routes/commandRoutes.ts";
import { MqttBridge, resolveMqttSettings, safetyTopic } from "../src/mqttBridge.ts";

function makeConfig(env: any = {}, initial: SecurityFile = {}) {
  let stored: SecurityFile = { ...initial };
  const logs: string[] = [];
  const config = new SecurityConfig({ env, load: () => ({ ...stored }), save: (file) => { stored = { ...file }; }, tlsActive: false, log: (m) => logs.push(m) });
  return { config, logs, stored: () => stored };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${message}`);
    await wait(15);
  }
}

// ---- the two switches ------------------------------------------------------------------------------------------------------------------------------

test("the open health route and the announcement of a global stop are off by default and only the exact word 1 switches them on", () => {
  const { config } = makeConfig();
  assert.equal(config.healthOpen(), false);
  assert.equal(config.globalStopPublished(), false);
  assert.deepEqual(config.snapshot().health.open, { value: false, source: "default" });
  assert.deepEqual(config.snapshot().safety.publishGlobalStop, { value: false, source: "default" });
  assert.equal(makeConfig({ healthOpen: "1" }).config.healthOpen(), true);
  assert.equal(makeConfig({ safetyPublishStop: "1" }).config.globalStopPublished(), true);
  for (const word of ["true", "yes", "on", "0", ""]) {
    assert.equal(makeConfig({ healthOpen: word }).config.healthOpen(), false, word);
    assert.equal(makeConfig({ safetyPublishStop: word }).config.globalStopPublished(), false, word);
  }
});

test("an administrator can open /health and allow the announcement; it is saved, logged and warned about", () => {
  const { config, logs, stored } = makeConfig();
  const opened = config.update({ health: { open: true } }, "root");
  assert.deepEqual(opened.warnings, ["health_open"]);
  assert.equal(config.healthOpen(), true);
  assert.deepEqual(stored().health, { open: true });
  assert.match(logs.at(-1)!, /opened GET \/health/);
  const closed = config.update({ health: { open: false } }, "root");
  assert.deepEqual(closed.warnings, []);
  assert.equal(config.healthOpen(), false);
  assert.match(logs.at(-1)!, /closed GET \/health/);

  const announced = config.update({ safety: { publishGlobalStop: true } }, "root");
  assert.deepEqual(announced.warnings, ["global_stop_published"]);
  assert.equal(config.globalStopPublished(), true);
  assert.deepEqual(stored().safety, { publishGlobalStop: true });
  assert.match(logs.at(-1)!, /allowed announcing a global stop/);
  // the other saved options are kept
  assert.deepEqual(stored().health, { open: false });
});

test("the two options refuse a value that is not true or false, a patch that is not an object, and a value fixed by the environment", () => {
  const { config } = makeConfig();
  const bad400 = (e: unknown) => e instanceof SecurityConfigError && e.status === 400;
  for (const value of ["yes", 1, null]) {
    assert.throws(() => config.update({ health: { open: value } }, "root"), bad400);
    assert.throws(() => config.update({ safety: { publishGlobalStop: value } }, "root"), bad400);
  }
  assert.throws(() => config.update({ health: [] }, "root"), bad400);
  assert.throws(() => config.update({ safety: "on" }, "root"), bad400);
  assert.throws(() => makeConfig({ healthOpen: "1" }).config.update({ health: { open: false } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /HEALTH_OPEN/.test(e.message));
  assert.throws(() => makeConfig({ safetyPublishStop: "0" }).config.update({ safety: { publishGlobalStop: true } }, "root"), (e: unknown) => e instanceof SecurityConfigError && e.status === 409 && /SAFETY_PUBLISH_STOP/.test(e.message));
});

// ---- GET /health ------------------------------------------------------------------------------------------------------------------------------------

function infoApp(healthOpen?: () => boolean) {
  const routes = new Map<string, (req: any, res: any) => void>();
  const app: any = { get(route: string, ...handlers: any[]) { routes.set(route, handlers[handlers.length - 1]); } };
  registerInfoRoutes(app, { infoAccess: (_req, _res, next) => next(), getSettings: () => ({ controllers: [] }), REMOTE_API_VERSION: 2, healthOpen });
  const call = () => {
    const out: { status: number; body?: any } = { status: 200 };
    const res: any = { status(code: number) { out.status = code; return res; }, end() { return res; }, json(value: any) { out.body = value; return res; } };
    routes.get("/health")!({ headers: {} }, res);
    return out;
  };
  return call;
}

test("GET /health looks as if it did not exist while the switch is off, and without it", () => {
  assert.equal(infoApp(() => false)().status, 404);
  assert.equal(infoApp()().status, 404);
});

test("GET /health answers a HealthReport with no version, host or counts once the switch is on", () => {
  const answer = infoApp(() => true)();
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.body).sort(), ["checks", "schema_version", "service", "state", "timestamp_utc"]);
  assert.equal(answer.body.schema_version, "1.0");
  assert.equal(answer.body.state, "READY");
  assert.deepEqual(answer.body.checks, { process: "ok" });
  assert.ok(!Number.isNaN(Date.parse(answer.body.timestamp_utc)));
});

// ---- the global stop and its announcement -------------------------------------------------------------------------------------------------------

function stopApp(options: { announce?: (reason: string) => boolean; release?: (reason: string) => boolean }) {
  const routes = new Map<string, any[]>();
  const app: any = { post(route: string, ...handlers: unknown[]) { routes.set(route, handlers); } };
  const logs: string[] = [];
  const audit: any[] = [];
  const settings = { controllers: [{ id: "c1", robots: [{ id: 1, name: "A", playbackState: { isPlaying: true } }] }] };
  const admin = (_req: any, _res: any, next: any) => next();
  registerCommandRoutes(app, {
    authenticate: () => undefined,
    getSettings: () => settings,
    industrialLog: (m: string) => { logs.push(m); },
    isReservationActive: () => false,
    queueSettingsWrite: async () => undefined,
    broadcastRobotDelta: () => undefined,
    startServerPlayback: () => undefined,
    stopServerPlayback: () => undefined,
    audit: { record: (entry: any) => { audit.push(entry); } } as any,
    announceGlobalStop: options.announce,
    announceGlobalStopReleased: options.release,
    requireAdmin: admin,
  } as any);
  const run = async (route: string, user: any = { id: "u1", username: "alice", role: "operator" }) => {
    const handlers = routes.get(route)!;
    let body: any;
    const res: any = { json: (value: any) => { body = value; return res; } };
    await handlers[handlers.length - 1]({ user, ip: "10.0.0.7" }, res);
    return body;
  };
  return { run, logs, audit, settings, routes };
}

test("a global stop without an announcement keeps its answer exactly as it was", async () => {
  const t = stopApp({});
  const body = await t.run("/api/stop-all");
  assert.equal(body.success, true);
  assert.equal("announced" in body, false);
});

test("a global stop announces itself after the stop is applied, and the answer says whether it went out", async () => {
  const seen: string[] = [];
  let playingWhenAnnounced: unknown;
  let t: ReturnType<typeof stopApp>;
  t = stopApp({ announce: (reason) => { seen.push(reason); playingWhenAnnounced = (t.settings.controllers[0].robots[0] as any).playbackState.isPlaying; return true; } });
  const body = await t.run("/api/stop-all");
  assert.deepEqual(seen, ["global stop by alice"]);
  assert.equal(playingWhenAnnounced, false, "the robots were already stopped in memory when the announcement went out");
  assert.equal(body.announced, true);
  assert.equal((await stopApp({ announce: () => false }).run("/api/stop-all")).announced, false);
});

test("an announcement that throws never breaks the stop", async () => {
  const t = stopApp({ announce: () => { throw new Error("broker gone"); } });
  const body = await t.run("/api/stop-all");
  assert.equal(body.success, true);
  assert.equal(body.stoppedCount, 1);
  assert.equal(body.announced, false);
  assert.ok(t.logs.some((line) => /announcement failed \(broker gone\)/.test(line)));
});

test("the release of the global stop is recorded and says whether the announcement went out", async () => {
  const t = stopApp({ release: () => true });
  const body = await t.run("/api/stop-all/release", { id: "a1", username: "root", role: "admin" });
  assert.deepEqual(body, { success: true, announced: true });
  assert.equal(t.audit.at(-1).type, "stop-all-release");
  assert.equal(t.audit.at(-1).outcome, "ok");
  const none = stopApp({});
  assert.deepEqual(await none.run("/api/stop-all/release", { id: "a1", username: "root", role: "admin" }), { success: true, announced: false });
  assert.equal(none.audit.at(-1).outcome, "failed");
});

test("the release route sits behind the administrator guard, after the sign-in", () => {
  const t = stopApp({});
  const chain = t.routes.get("/api/stop-all/release")!;
  assert.equal(chain.length, 3);
});

// ---- the retained SafetyState on a real broker -------------------------------------------------------------------------------------------------

test("the bridge publishes the SafetyState retained on <prefix>/safety/estop, and a late subscriber still gets it", async () => {
  const broker = new Aedes();
  await broker.listen();
  const server: Server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const url = `mqtt://127.0.0.1:${(server.address() as { port: number }).port}`;
  const bridge = new MqttBridge({
    settings: { ...resolveMqttSettings({}, {}), url, minStateIntervalMs: 20 },
    getSettings: () => ({ controllers: [] }),
    allowedCommands: new Set(),
    log: () => undefined,
  });
  try {
    assert.equal(bridge.publishSafety("SAFE_STOP", "x"), false, "not connected yet: nothing goes out and the caller is told");
    bridge.start();
    await until(() => bridge.isConnected(), "the bridge connects");
    assert.equal(bridge.publishSafety("SAFE_STOP", "global stop by alice"), true);
    const late: { topic: string; text: string; retain: boolean }[] = [];
    const client = mqttConnect(url, { reconnectPeriod: 0 });
    client.on("message", (topic, payload, packet) => late.push({ topic, text: payload.toString("utf8"), retain: packet.retain }));
    await new Promise<void>((resolve) => client.on("connect", () => client.subscribe(safetyTopic(bridge.prefix), { qos: 1 }, () => resolve())));
    await until(() => late.length >= 1, "the retained state reaches a late subscriber");
    assert.equal(late[0].topic, "hydra/swarm/safety/estop");
    assert.equal(late[0].retain, true);
    const state = JSON.parse(late[0].text);
    assert.deepEqual(Object.keys(state).sort(), ["reason", "schema_version", "source", "state", "timestamp_utc"]);
    assert.equal(state.schema_version, "1.0");
    assert.equal(state.state, "SAFE_STOP");
    assert.equal(state.source, "hydra-umc-server");
    assert.equal(bridge.publishSafety("READY", "global stop released"), true);
    await until(() => late.length >= 2, "the release reaches the subscriber");
    assert.equal(JSON.parse(late[1].text).state, "READY");
    await new Promise<void>((resolve) => client.end(true, () => resolve()));
  } finally {
    await bridge.stop();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
