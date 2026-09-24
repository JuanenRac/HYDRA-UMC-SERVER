// =============================================================================
// HYDRA-UMC-SERVER - src/routes/upstreamRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Authenticated relays to sibling services (DATALAKE telemetry, CONNECTOR-HUB
// adapters, the CAN-OTA spi_bridge) and the connection test, moved out of
// server.ts unchanged. The upstream settings arrive through `deps` so this
// module never reads the process environment on its own.
import express from "express";
import { WebSocket } from "ws";
import { probeTcp } from "../ecosystemStatus";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface UpstreamDeps {
  authenticate: Middleware;
  requireAdmin: Middleware;
  industrialLog: (msg: string) => void;
  wsClients: Iterable<any>;
  DATALAKE_URL: string;
  DATALAKE_TIMEOUT_MS: number;
  CONNECTOR_HUB_URL: string;
  CONNECTOR_HUB_TIMEOUT_MS: number;
  SPI_BRIDGE_URL: string;
  SPI_BRIDGE_VERSION_TIMEOUT_MS: number;
  SPI_BRIDGE_FLASH_TIMEOUT_MS: number;
}

export function registerUpstreamRoutes(app: express.Express, deps: UpstreamDeps): void {
  const {
    authenticate, requireAdmin, industrialLog, wsClients, DATALAKE_URL, DATALAKE_TIMEOUT_MS, CONNECTOR_HUB_URL,
    CONNECTOR_HUB_TIMEOUT_MS, SPI_BRIDGE_URL, SPI_BRIDGE_VERSION_TIMEOUT_MS, SPI_BRIDGE_FLASH_TIMEOUT_MS,
  } = deps;

  // Real, authenticated read-only proxy to HYDRA-UMC-DATALAKE's own /query
  // and /aggregate (see DATALAKE_URL's own comment above for why this is a
  // proxy rather than STUDIO reaching Datalake's port directly). authenticate
  // only (no requireAdmin) - viewing telemetry is no more sensitive than
  // viewing a robot's live state, which every logged-in STUDIO session can
  // already do. Query params are forwarded verbatim; Datalake's own api.py
  // is the one real source of truth for what's valid (limit/bucketMs/agg/
  // etc.) - duplicating that validation here would just be a second place
  // for it to drift out of sync.
  async function proxyToDatalake(res: express.Response, path: string, query: Record<string, unknown>) {
    if (!DATALAKE_URL) {
      return res.status(503).json({ error: "HYDRA-UMC-DATALAKE is not configured on this Server", available: false });
    }
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string") qs.set(key, value);
    }
    try {
      const upstream = await fetch(`${DATALAKE_URL}${path}?${qs.toString()}`, {
        signal: AbortSignal.timeout(DATALAKE_TIMEOUT_MS),
      });
      const body = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        return res.status(upstream.status).json(body && typeof body === "object" ? body : { error: "HYDRA-UMC-DATALAKE rejected the request" });
      }
      res.json(body);
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      res.status(503).json({ error: timedOut ? "HYDRA-UMC-DATALAKE timed out" : "HYDRA-UMC-DATALAKE is unavailable" });
    }
  }

  app.get("/api/telemetry/query", authenticate, async (req, res) => {
    await proxyToDatalake(res, "/query", req.query as Record<string, unknown>);
  });

  app.get("/api/telemetry/aggregate", authenticate, async (req, res) => {
    await proxyToDatalake(res, "/aggregate", req.query as Record<string, unknown>);
  });

  // Real, authenticated read-only proxy to HYDRA-UMC-CONNECTOR-HUB's own
  // real `serve-catalog` (see CONNECTOR_HUB_URL's own comment above for
  // why this is a proxy, same shape as proxyToDatalake). A safe adapterId
  // is forwarded as a path segment, never interpolated into a query
  // string - CONNECTOR-HUB's own catalog_server.py already rejects an
  // unknown one with a real 404, which this passes straight through.
  async function proxyToConnectorHub(res: express.Response, path: string) {
    if (!CONNECTOR_HUB_URL) {
      return res.status(503).json({ error: "HYDRA-UMC-CONNECTOR-HUB is not configured on this Server", available: false });
    }
    try {
      const upstream = await fetch(`${CONNECTOR_HUB_URL}${path}`, {
        signal: AbortSignal.timeout(CONNECTOR_HUB_TIMEOUT_MS),
      });
      const body = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        return res.status(upstream.status).json(body && typeof body === "object" ? body : { error: "HYDRA-UMC-CONNECTOR-HUB rejected the request" });
      }
      res.json(body);
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      res.status(503).json({ error: timedOut ? "HYDRA-UMC-CONNECTOR-HUB timed out" : "HYDRA-UMC-CONNECTOR-HUB is unavailable" });
    }
  }

  app.get("/api/adapters", authenticate, async (req, res) => {
    await proxyToConnectorHub(res, "/catalog");
  });

  app.get("/api/adapters/:adapterId", authenticate, async (req, res) => {
    // Real safe-segment check before it ever reaches a path segment of a
    // real outbound URL - same charset CONNECTOR-HUB's own schema.py
    // requires of a real adapterId (_SAFE_ADAPTER_ID_RE), checked here too
    // rather than trusting the upstream alone to reject a malformed one.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(req.params.adapterId)) {
      return res.status(400).json({ error: "adapterId must start with an alphanumeric character and contain only letters, digits, '_' or '-'" });
    }
    await proxyToConnectorHub(res, `/catalog/${encodeURIComponent(req.params.adapterId)}`);
  });

  // Real relay to the local spi_bridge HTTP service (HYDRA-UMC/src/
  // cm5_host/spi_bridge/) - the CM5<->STM32H745 SPI-OTA link STUDIO's
  // Flasher/Tester (canOta.ts) reads via `settings.canOta.transport ===
  // 'hardware'`. Same relay shape as /api/voice/turn above: 503 when not
  // configured, never a guessed process. authenticate only for the
  // read-only version query (no more sensitive than viewing any other
  // ecosystem/telemetry status); requireAdmin for flash - writing firmware
  // is exactly the kind of action every other bridge in this ecosystem
  // gates more tightly than a read.
  app.get("/api/hardware/canota/version", authenticate, async (req, res) => {
    if (!SPI_BRIDGE_URL) {
      return res.status(503).json({ error: "the spi_bridge service is not configured on this Server", available: false });
    }
    const tier = String(req.query.tier ?? "0");
    const slot = String(req.query.slot ?? "0");
    // relay=1 tunnels through the resolved Tier 0/1 target to reach Tier 2
    // (the URTC Tool Head) - see spi_bridge's own relay_tunnel.py.
    const relay = String(req.query.relay ?? "0");
    try {
      const upstream = await fetch(
        `${SPI_BRIDGE_URL}/version?tier=${encodeURIComponent(tier)}&slot=${encodeURIComponent(slot)}&relay=${encodeURIComponent(relay)}`,
        { signal: AbortSignal.timeout(SPI_BRIDGE_VERSION_TIMEOUT_MS) },
      );
      const body = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        return res.status(upstream.status).json(body && typeof body === "object" ? body : { error: "spi_bridge rejected the request" });
      }
      res.json(body);
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      res.status(503).json({ error: timedOut ? "spi_bridge timed out" : "spi_bridge is unavailable" });
    }
  });

  app.post(
    "/api/hardware/canota/flash",
    authenticate,
    requireAdmin,
    express.raw({ type: "application/octet-stream", limit: "64mb" }),
    async (req, res) => {
      if (!SPI_BRIDGE_URL) {
        return res.status(503).json({ error: "the spi_bridge service is not configured on this Server", available: false });
      }
      const firmware = req.body;
      if (!Buffer.isBuffer(firmware) || firmware.length === 0) {
        return res.status(400).json({ error: "request body must be a non-empty application/octet-stream firmware image" });
      }
      const qs = new URLSearchParams();
      for (const key of ["tier", "slot", "relay", "hardware_id", "version_major", "version_minor"]) {
        if (typeof req.query[key] === "string") qs.set(key, req.query[key] as string);
      }
      const username = (req as any).user?.username ?? "unknown";
      industrialLog(`[CANOTA] flash requested by=${username} tier=${qs.get("tier")} slot=${qs.get("slot")} bytes=${firmware.length}`);

      let upstream: Response;
      try {
        upstream = await fetch(`${SPI_BRIDGE_URL}/flash?${qs.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: firmware,
          signal: AbortSignal.timeout(SPI_BRIDGE_FLASH_TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        return res.status(503).json({ error: timedOut ? "spi_bridge timed out" : "spi_bridge is unavailable" });
      }
      if (!upstream.ok || !upstream.body) {
        return res.status(502).json({ error: "spi_bridge rejected the flash request" });
      }

      // spi_bridge streams real newline-delimited JSON progress - each
      // line is broadcast to every connected WS client as it arrives
      // (`type: "canota_progress"`, same envelope shape as every other WS
      // message this server sends) so Flasher.tsx can show real, live
      // progress instead of polling. This HTTP response only reports
      // whether the cycle finished - the real progress goes out over WS.
      let finalPhase = "unknown";
      let buffered = "";
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let newlineIndex: number;
          while ((newlineIndex = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newlineIndex);
            buffered = buffered.slice(newlineIndex + 1);
            if (!line.trim()) continue;
            const progress = JSON.parse(line);
            finalPhase = progress.phase ?? finalPhase;
            const msg = JSON.stringify({ type: "canota_progress", payload: progress });
            for (const client of wsClients) {
              if (client.readyState === WebSocket.OPEN) client.send(msg);
            }
          }
        }
      } catch (error) {
        industrialLog(`[CANOTA] flash stream error by=${username}: ${error}`);
        return res.status(502).json({ error: "spi_bridge progress stream failed" });
      }
      industrialLog(`[CANOTA] flash finished by=${username} phase=${finalPhase}`);
      res.json({ success: finalPhase === "done", finalPhase });
    },
  );

  // Real "Test Connection" for STUDIO's Config > Integrations panel
  // (OpenPnP/CNC/Laser/ROS2/Printer3D bridges) - the "real, working
  // integrations (not just text)" gap: those cards used to only save an
  // ip/port to settings.json with zero verification either way. This is
  // deliberately a bare TCP reachability probe (probeTcp, the same real
  // primitive getEcosystemStatus() uses above) rather than anything
  // bridge-specific - a generic "is anything listening at host:port"
  // check works uniformly across all 5+ bridges without this server
  // needing to know any of their individual real HTTP APIs, and stays
  // correct as those APIs evolve independently. Requires a real session
  // (authenticate) since, unlike the ecosystem scan above, this takes
  // client-supplied host/port - an unauthenticated version would let
  // anyone use this server as a blind network-reachability oracle
  // against arbitrary hosts.
  app.post("/api/integrations/test-connection", authenticate, async (req, res) => {
    const { host, port } = req.body || {};
    // A conservative hostname/IPv4 allowlist pattern (letters/digits/dots/
    // hyphens only, max 253 chars per RFC 1035) - not full RFC validation,
    // just enough to refuse anything that isn't plausibly a host (no
    // whitespace, no URL scheme/path, no shell-metacharacter-looking
    // input) before it ever reaches net.createConnection.
    const validHost = typeof host === "string" && host.length > 0 && host.length <= 253 && /^[A-Za-z0-9.-]+$/.test(host);
    const validPort = typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535;
    if (!validHost || !validPort) {
      res.status(400).json({ error: "host must be a valid hostname/IP string and port an integer 1-65535" });
      return;
    }
    const reachable = await probeTcp(port, host);
    res.json({ reachable });
  });
}
