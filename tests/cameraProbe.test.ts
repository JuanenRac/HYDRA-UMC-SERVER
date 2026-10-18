import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { hi3510PtzRequest, psiaRequest, rtspDescribeOnce, sendPtzCommand } from "../src/cameraProbe.ts";

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}
const close = (server: http.Server | net.Server) =>
  new Promise<void>((resolve) => { server.close(() => resolve()); (server as any).closeAllConnections?.(); });

test("psiaRequest answers a Basic challenge with a Basic header and succeeds", async () => {
  const seen: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (!req.headers.authorization) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="cam"' }); res.end(); return; }
    res.writeHead(200); res.end("ok");
  });
  const port = await listen(server);
  try {
    const result = await psiaRequest("127.0.0.1", port, "GET", "/x", "admin", "pw");
    assert.equal(result.ok, true);
    assert.equal(seen[1], "Basic " + Buffer.from("admin:pw").toString("base64"));
  } finally { await close(server); }
});

test("psiaRequest computes a correct RFC 2617 Digest response", async () => {
  let accepted = false;
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (!auth) { res.writeHead(401, { "WWW-Authenticate": 'Digest realm="r1", nonce="n1"' }); res.end(); return; }
    const expected = md5(`${md5("admin:r1:pw")}:n1:${md5("PUT:/ptz")}`);
    accepted = auth.includes(`response="${expected}"`);
    res.writeHead(accepted ? 200 : 403); res.end();
  });
  const port = await listen(server);
  try {
    const result = await psiaRequest("127.0.0.1", port, "PUT", "/ptz", "admin", "pw", "<a/>");
    assert.equal(accepted, true);
    assert.equal(result.ok, true);
  } finally { await close(server); }
});

test("psiaRequest reports an honest failure when the camera wants auth and no username is configured", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="cam"' }); res.end(); });
  const port = await listen(server);
  try {
    const result = await psiaRequest("127.0.0.1", port, "GET", "/x", "", "");
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 401);
    assert.match(result.error ?? "", /no username/);
  } finally { await close(server); }
});

test("psiaRequest with an unrecognised challenge does not loop and returns the 401", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.writeHead(401, { "WWW-Authenticate": "Bearer" }); res.end(); });
  const port = await listen(server);
  try {
    const result = await psiaRequest("127.0.0.1", port, "GET", "/x", "admin", "pw");
    assert.equal(result.ok, false);
    assert.equal(hits, 1);
  } finally { await close(server); }
});

test("psiaRequest turns a refused connection into ok:false with statusCode 0", async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  const result = await psiaRequest("127.0.0.1", port, "GET", "/x", "a", "b");
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 0);
  assert.ok(result.error);
});

test("hi3510PtzRequest requires both a 200 and the success marker", async () => {
  const urls: string[] = [];
  let body = "[Succeed]set ok.";
  const server = http.createServer((req, res) => { urls.push(req.url ?? ""); res.writeHead(200); res.end(body); });
  const port = await listen(server);
  try {
    const good = await hi3510PtzRequest("127.0.0.1", port, "", "", "left", 30);
    assert.equal(good.ok, true);
    assert.equal(urls[0], "/cgi-bin/hi3510/ptzctrl.cgi?-step=0&-act=left&-speed=30");
    body = "[Error]";
    const bad = await hi3510PtzRequest("127.0.0.1", port, "", "", "left", 30);
    assert.equal(bad.ok, false);
    assert.equal(bad.statusCode, 200);
  } finally { await close(server); }
});

test("sendPtzCommand falls back to PSIA when Hi3510 fails, and prefers the Hi3510 error when both fail", async () => {
  const paths: string[] = [];
  let psiaOk = true;
  const server = http.createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith("/cgi-bin/hi3510")) { res.writeHead(404); res.end("nope"); return; }
    res.writeHead(psiaOk ? 200 : 500); res.end();
  });
  const port = await listen(server);
  try {
    const ok = await sendPtzCommand("127.0.0.1", port, "", "", 2, 50, 0, 0);
    assert.equal(ok.ok, true);
    assert.ok(paths.includes("PUT /PSIA/PTZ/channels/2/continuous"));
    psiaOk = false;
    const both = await sendPtzCommand("127.0.0.1", port, "", "", 1, 50, 0, 0);
    assert.equal(both.ok, false);
    assert.equal(both.statusCode, 404, "the more specific Hi3510 failure wins");
  } finally { await close(server); }
});

test("sendPtzCommand sends a stop with a bounded speed", async () => {
  const urls: string[] = [];
  const server = http.createServer((req, res) => { urls.push(req.url ?? ""); res.writeHead(200); res.end("[Succeed]"); });
  const port = await listen(server);
  try {
    const result = await sendPtzCommand("127.0.0.1", port, "", "", 1, 0, 0, 0);
    assert.equal(result.ok, true);
    assert.match(urls[0], /-act=stop&-speed=45$/);
    await sendPtzCommand("127.0.0.1", port, "", "", 1, 1000, 0, 0);
    assert.match(urls[1], /-speed=63$/);
  } finally { await close(server); }
});

test("rtspDescribeOnce returns the status, retries with a Digest answer on 401, and reports 401 without credentials", async () => {
  let secondAuth = "";
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      const text = chunk.toString("latin1");
      const auth = text.match(/Authorization: (.+)\r\n/);
      if (!auth) {
        socket.write('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="rt", nonce="nn"\r\n\r\n');
      } else {
        secondAuth = auth[1];
        socket.write("RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n");
      }
    });
  });
  const port = await listen(server);
  try {
    assert.equal(await rtspDescribeOnce("127.0.0.1", port, "/11", "u", "p"), 200);
    const expected = md5(`${md5("u:rt:p")}:nn:${md5(`DESCRIBE:rtsp://127.0.0.1:${port}/11`)}`);
    assert.ok(secondAuth.includes(`response="${expected}"`));
    assert.equal(await rtspDescribeOnce("127.0.0.1", port, "/11", "", ""), 401);
  } finally { await close(server); }
});

test("rtspDescribeOnce rejects on a refused connection", async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  await assert.rejects(rtspDescribeOnce("127.0.0.1", port, "/11", "", ""));
});
