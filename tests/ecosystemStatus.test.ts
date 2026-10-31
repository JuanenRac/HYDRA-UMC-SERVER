import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getEcosystemStatus, probeHttp, probeService, probeTcp } from "../src/ecosystemStatus.ts";

// Characterisation of the existing status scan: what it reads from the manifests, which probes it runs and how it
// answers when nothing is there. It only touches a temporary directory and sockets of its own on 127.0.0.1.

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

function manifest(root: string, dir: string, body: Record<string, unknown>) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, "hydra-umc.project.json"), JSON.stringify(body));
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-eco-status-"));
  const previous = { root: process.env.HYDRA_UMC_ECOSYSTEM_ROOT, registry: process.env.HYDRA_UMC_PORTS_REGISTRY };
  process.env.HYDRA_UMC_ECOSYSTEM_ROOT = root;
  process.env.HYDRA_UMC_PORTS_REGISTRY = "off";
  try {
    return await run(root);
  } finally {
    if (previous.root === undefined) delete process.env.HYDRA_UMC_ECOSYSTEM_ROOT; else process.env.HYDRA_UMC_ECOSYSTEM_ROOT = previous.root;
    if (previous.registry === undefined) delete process.env.HYDRA_UMC_PORTS_REGISTRY; else process.env.HYDRA_UMC_PORTS_REGISTRY = previous.registry;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the HTTP probe is true only for a 2xx answer and the TCP probe only for an open port", async () => {
  const { server, port } = await listen((req, res) => { res.statusCode = req.url === "/ok" ? 200 : req.url === "/bad" ? 503 : 404; res.end("x"); });
  try {
    assert.equal(await probeHttp(port, "/ok"), true);
    assert.equal(await probeHttp(port, "/bad"), false);
    assert.equal(await probeHttp(port, "/missing"), false);
    assert.equal(await probeTcp(port), true);
    assert.equal(await probeService(port, "/ok"), true);
    assert.equal(await probeService(port, null), true);
  } finally {
    server.close();
  }
  assert.equal(await probeTcp(port), false);
  assert.equal(await probeHttp(port, "/ok"), false);
});

test("the scan reads each manifest, probes only the services that declare one, skips a broken manifest and sorts by family and name", async () => {
  const { server, port } = await listen((_req, res) => { res.statusCode = 200; res.end("{}"); });
  try {
    await withRoot(async (root) => {
      manifest(root, "b-service", { name: "B-SERVICE", family: "hydra", version: "1.2.3.4", role: "service", service: { port, health_path: "/health" } });
      manifest(root, "a-library", { name: "A-LIBRARY", family: "hydra", version: "0.1.0.0", maturity: "established" });
      manifest(root, "c-down", { name: "C-DOWN", family: "urtc", service: { port: 1 } });
      manifest(root, "d-badport", { name: "D-BADPORT", family: "urtc", service: { port: 99999, health_path: "/x" } });
      fs.mkdirSync(path.join(root, "broken"));
      fs.writeFileSync(path.join(root, "broken", "hydra-umc.project.json"), "{ not json");
      fs.mkdirSync(path.join(root, "no-manifest"));

      const status = await getEcosystemStatus();
      assert.equal(status.available, true);
      assert.deepEqual(status.projects.map((p) => p.name), ["A-LIBRARY", "B-SERVICE", "C-DOWN", "D-BADPORT"]);
      const [library, service, down, badPort] = status.projects;
      assert.equal(library.live, null);
      assert.equal(library.servicePort, null);
      assert.equal(library.maturity, "established");
      assert.equal(service.live, true);
      assert.equal(service.serviceHost, "127.0.0.1");
      assert.equal(service.serviceHealthPath, "/health");
      assert.equal(service.version, "1.2.3.4");
      assert.equal(down.live, false);
      assert.equal(down.serviceHealthPath, null);
      assert.equal(badPort.servicePort, null);
      assert.equal(badPort.live, null);
      assert.ok(!Number.isNaN(Date.parse(status.scannedAt)));
    });
  } finally {
    server.close();
  }
});

test("a root that does not exist gives available false instead of an error", async () => {
  const previous = process.env.HYDRA_UMC_ECOSYSTEM_ROOT;
  process.env.HYDRA_UMC_ECOSYSTEM_ROOT = path.join(os.tmpdir(), "hydra-eco-status-missing-root");
  try {
    const status = await getEcosystemStatus();
    assert.equal(status.available, false);
    assert.deepEqual(status.projects, []);
  } finally {
    if (previous === undefined) delete process.env.HYDRA_UMC_ECOSYSTEM_ROOT; else process.env.HYDRA_UMC_ECOSYSTEM_ROOT = previous;
  }
});
