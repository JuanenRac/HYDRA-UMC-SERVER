import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { describeUnhealthy, probeCameraStream, streamHealthy } from "../src/cameraHealth.ts";

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}
const close = (server: http.Server | net.Server) =>
  new Promise<void>((resolve) => { server.close(() => resolve()); (server as any).closeAllConnections?.(); });

function streamer(status: number, body: string): http.Server {
  return http.createServer((req, res) => {
    if (req.url !== "/health") { res.writeHead(404); res.end(); return; }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  });
}

test("a streamer that reports frames arriving is healthy", async () => {
  const server = streamer(200, JSON.stringify({ state: "streaming", healthy: true }));
  const port = await listen(server);
  try {
    const health = await probeCameraStream(port);
    assert.deepEqual(health, { up: true, streaming: true });
    assert.equal(streamHealthy(health), true);
  } finally { await close(server); }
});

test("a streamer that holds its port but sends no frames is NOT healthy, and says why", async () => {
  for (const state of ["stalled", "connecting", "given_up"]) {
    const server = streamer(503, JSON.stringify({ state, healthy: false }));
    const port = await listen(server);
    try {
      const health = await probeCameraStream(port);
      assert.equal(health.up, true);
      assert.equal(health.streaming, false);
      assert.equal(health.state, state);
      assert.equal(streamHealthy(health), false, state);
      assert.ok(describeUnhealthy(health).includes(`sends no frames (${state})`), describeUnhealthy(health));
    } finally { await close(server); }
  }
});

test("an unreadable 503 body still means no frames", async () => {
  const server = streamer(503, "<html>not json</html>");
  const port = await listen(server);
  try {
    const health = await probeCameraStream(port);
    assert.equal(health.streaming, false);
    assert.equal(health.state, undefined);
    assert.match(describeUnhealthy(health), /no state/);
  } finally { await close(server); }
});

test("a streamer without the route keeps the old meaning: the port answers, so it is up", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const port = await listen(server);
  try {
    const health = await probeCameraStream(port);
    assert.deepEqual(health, { up: true, streaming: null });
    assert.equal(streamHealthy(health), true);
  } finally { await close(server); }
});

test("a closed port is down", async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  const health = await probeCameraStream(port);
  assert.deepEqual(health, { up: false, streaming: null });
  assert.equal(streamHealthy(health), false);
  assert.match(describeUnhealthy(health), /no answer/);
});

test("a port that accepts and never answers falls back to the TCP check", async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => { sockets.push(socket); }); // accepts, says nothing
  const port = await listen(server);
  try {
    const health = await probeCameraStream(port, "127.0.0.1", 150);
    assert.deepEqual(health, { up: true, streaming: null });
  } finally { sockets.forEach((s) => s.destroy()); await close(server); }
});

test("a huge body is not kept in memory", async () => {
  const server = streamer(503, "x".repeat(2_000_000));
  const port = await listen(server);
  try {
    const health = await probeCameraStream(port);
    assert.equal(health.streaming, false);
  } finally { await close(server); }
});
