// =============================================================================
// HYDRA-UMC-SERVER - src/ws.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The live connection hub (settings and robot delta broadcasts) and the WebSocket endpoint
// with its heartbeat, moved out of server.ts unchanged.
import http from "http";
import jwt from "jsonwebtoken";
import { WebSocketServer, WebSocket } from "ws";
import { realSettings, WS_TOKEN_SUBPROTOCOL, wsTokenFromSubprotocol, redactSettingsSecrets } from "./serverPolicy";
import { findUser, effectiveTokenVersion, effectiveId } from "./users";
import { authFailuresTotal, setWsClientsSource } from "./metrics";
import { JWT_SECRET } from "./auth";
import { setupDiscovery } from "./runtime";

export function createWsHub(deps: { setSettings: (payload: any) => void }) {
  const { setSettings } = deps;
  // Every open WebSocket client (the browser UI itself, plus any remote
  // clients - HYDRA-UMC SUITE, the mobile control apps) - broadcastSettings()
  // pushes to all of them on every write, whichever path (REST POST or a
  // WS "settings" message, see the WebSocketServer setup below) produced
  // it. This is what makes "modify a running job from SUITE" actually
  // show up live in an already-open browser tab instead of only on that
  // tab's own next 500ms debounced re-fetch (which never happens today -
  // the browser client only fetches /api/settings once, on mount).
  const wsClients = new Set<WebSocket>();
  // src/metrics.ts's own hydra_ws_clients_connected gauge reads this lazily
  // on every /metrics scrape via this getter - wsClients only exists inside
  // startServer(), so this is registered here rather than at module load
  // (compare setSystemMetricsSource(getSystemMetrics) above, which doesn't
  // need to wait for anything).
  setWsClientsSource(() => wsClients.size);
  // Only an administrator's connection receives the credentials of the IP cameras.
  const clientMaySeeSecrets = (client: WebSocket): boolean => (client as any).meta?.role === "admin";

  function broadcastSettings(payload: any, deltaOnly: boolean = false, originator?: WebSocket) {
    setSettings(payload);
    const type = deltaOnly ? "delta" : "settings";
    // schema: 1 = today's actual behavior ("delta" is still a full-tree
    // payload, just like "settings"). Purely additive: every client today
    // already ignores unknown fields on this message, so shipping this
    // alone changes nothing for anyone - it only gives a future
    // server/client pair a version to negotiate against before "delta"
    // ever means a real partial patch.
    const msg = JSON.stringify({ type, payload, schema: 1 });
    // an operator's connection gets the tree without the credentials of the IP cameras
    const safeMsg = JSON.stringify({ type, payload: redactSettingsSecrets(payload), schema: 1 });
    for (const client of wsClients) {
      if (client !== originator && client.readyState === WebSocket.OPEN) {
        client.send(clientMaySeeSecrets(client) ? msg : safeMsg);
      }
    }
    const newServerName = realSettings(payload)?.serverName;
    if (newServerName) setupDiscovery(newServerName);
  }

  /**
   * Real targeted delta broadcast for a write that already went through
   * POST /api/robot/:id/command's own validated switch/case (see that
   * route's own comment on `deltas` below - a delta is only ever built
   * FROM a validated write, never from a generic before/after diff of
   * the tree). `deltas` is one entry per
   * affected robot (self + combinedWith) for this single command.
   *
   * Per connection: a client that declared schema 2 on its /ws query
   * string (see the `?remoteApiVersion=` handling above) gets the real
   * small `patch` payload, one message per affected robot. Every other
   * client (schema 1 - every client deployed before this change, since
   * none of them send that query param yet) gets exactly what it got
   * before this function existed: the full tree under `type: "delta"`,
   * `schema: 1`. Both branches run in the same loop so the two client
   * populations never see a different final state, only a different wire
   * size to get there.
   */
  function broadcastRobotDelta(
    deltas: { controllerId: string; robotId: number; patch: Record<string, unknown>; cameraId?: number; cameraPatch?: Record<string, unknown> }[],
    fullPayload: any
  ) {
    setSettings(fullPayload);
    const fullMsg = JSON.stringify({ type: "delta", schema: 1, payload: fullPayload });
    const safeFullMsg = JSON.stringify({ type: "delta", schema: 1, payload: redactSettingsSecrets(fullPayload) });
    for (const client of wsClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if ((client as any).schema >= 2) {
        for (const d of deltas) {
          const msg: Record<string, unknown> = { type: "delta", schema: 2, controllerId: d.controllerId, robotId: d.robotId, patch: d.patch };
          if (d.cameraId !== undefined) {
            msg.cameraId = d.cameraId;
            msg.cameraPatch = d.cameraPatch;
          }
          client.send(JSON.stringify(msg));
        }
      } else {
        client.send(clientMaySeeSecrets(client) ? fullMsg : safeFullMsg);
      }
    }
  }

  return { wsClients, broadcastSettings, broadcastRobotDelta };
}

export type WsHub = ReturnType<typeof createWsHub>;

/** Attaches /ws to the shared listener: token check, the first settings push, the admin-only settings message and the heartbeat. */
export function attachWebSocketServer(
  httpServer: http.Server,
  deps: {
    wsClients: Set<WebSocket>;
    getSettings: () => any;
    applySettingsUpdate: (payload: any, originatorWs?: WebSocket) => Promise<void>;
    WS_QUERY_TOKEN_ALLOWED: boolean;
  },
) {
  const { wsClients, getSettings, applySettingsUpdate, WS_QUERY_TOKEN_ALLOWED } = deps;
  // A client may send its token as a subprotocol (`Sec-WebSocket-Protocol: hydra.bearer, <token>`), which keeps it out of the address that proxies and logs record; the server
  // answers with the `hydra.bearer` subprotocol only. `/ws?token=` is refused unless the installation opts back in with HYDRA_UMC_WS_QUERY_TOKEN=allow.
  const wss = new WebSocketServer({ server: httpServer, path: "/ws", handleProtocols: protocols => (protocols.has(WS_TOKEN_SUBPROTOCOL) ? WS_TOKEN_SUBPROTOCOL : false) });

  wss.on("connection", (ws, req) => {
    // The token: the subprotocol; the query string (?token=...) only when the installation opted back in for the clients that have not moved yet
    const url = new URL(req.url || "", "http://localhost");
    const subprotocolToken = wsTokenFromSubprotocol(req.headers["sec-websocket-protocol"]);
    if (!subprotocolToken && url.searchParams.has("token") && !WS_QUERY_TOKEN_ALLOWED) {
      authFailuresTotal.inc({ reason: "ws_query_token_refused" });
      ws.send(JSON.stringify({ error: "Access denied: a token in the address is not accepted, send it as the hydra.bearer subprotocol" }));
      setTimeout(() => ws.close(1008, "Access denied: token in the address"), 100);
      return;
    }
    const token = subprotocolToken ?? (WS_QUERY_TOKEN_ALLOWED ? url.searchParams.get("token") : null);

    if (!token) {
      authFailuresTotal.inc({ reason: "ws_no_token" });
      ws.send(JSON.stringify({ error: "Access denied: No token provided" }));
      setTimeout(() => ws.close(1008, "Access denied: No token provided"), 100);
      return;
    }

    // Same explicit HS256 pin as authenticate()'s own jwt.verify() above -
    // see that call site's own comment for why.
    jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }, (err: any, decoded: any) => {
      if (err) {
        authFailuresTotal.inc({ reason: "ws_token_invalid" });
        ws.send(JSON.stringify({ error: "Access denied: Invalid token" }));
        setTimeout(() => ws.close(1008, "Access denied: Invalid token"), 100);
        return;
      }

      // Same real re-check authenticate() runs for HTTP,
      // applied at WS connect time too - a signature-valid token whose
      // account was deleted, or whose tokenVersion has since moved on
      // (password/role changed), must not even open the connection.
      // (ws as any).tokenVersion is cached below so the heartbeat
      // interval can re-check this SAME connection periodically too,
      // without re-verifying the JWT signature on every tick.
      // Same real identity check authenticate() runs for HTTP -
      // see its own comment for why tokenVersion alone is not enough.
      const currentUser = findUser(decoded?.username || "");
      if (!currentUser || effectiveTokenVersion(currentUser) !== decoded?.tokenVersion || effectiveId(currentUser) !== decoded?.id) {
        authFailuresTotal.inc({ reason: "ws_session_revoked" });
        ws.send(JSON.stringify({ error: "Access denied: this session is no longer valid, please log in again" }));
        setTimeout(() => ws.close(1008, "Access denied: session revoked"), 100);
        return;
      }
      decoded.role = currentUser.role; // never trust the token's own stale role claim below

      wsClients.add(ws);
      // Schema this CLIENT declared it understands, via the same
      // ?remoteApiVersion= query param name GET /api/hydra-info reports
      // back (see REMOTE_API_VERSION's own comment above) - defaults to 1
      // (today's full-tree-under-"delta" behavior) for any connection that
      // doesn't send it, which is every client deployed before this change.
      // Read once at connect time, not re-checked per message - a client
      // that wants to change what it declares reconnects, same as any
      // other capability negotiated at handshake time.
      const declaredSchema = parseInt(url.searchParams.get("remoteApiVersion") || "1", 10);
      (ws as any).schema = declaredSchema >= 2 ? 2 : 1;
      // Per-connection metadata for the admin UI's "connected devices" list
      // (GET /api/admin/clients below) - nothing here is used for any
      // access-control decision (that's still decoded.role, checked at the
      // point each action happens, same as before this existed), purely
      // informational display data.
      (ws as any).meta = {
        username: decoded?.username || null,
        role: decoded?.role || null,
        remoteAddress: req.socket.remoteAddress || null,
        connectedAt: new Date().toISOString(),
        remoteApiVersion: (ws as any).schema,
      };
      // This connection's own claimed session generation,
      // re-checked against the account's CURRENT one on every heartbeat
      // tick below - a password/role change or account deletion that
      // happens WHILE this socket is open must still close it, not wait
      // for the client to reconnect on its own.
      (ws as any).authTokenVersion = decoded?.tokenVersion;
      // This connection's own claimed real identity, re-checked
      // against the account's CURRENT one on every heartbeat tick below,
      // same reasoning as authTokenVersion above.
      (ws as any).authUserId = decoded?.id;
      // Heartbeat state for this connection - see the
      // setInterval below for why this exists.
      (ws as any).isAlive = true;
      ws.on("pong", () => { (ws as any).isAlive = true; });
      // New connection immediately gets the current state, same shape as a
      // broadcast - a client (e.g. HYDRA-UMC SUITE, freshly connected to one
      // controller in a swarm) doesn't have to also do a separate REST GET
      // /api/settings just to get its first real payload.
      ws.send(JSON.stringify({ type: "settings", payload: decoded?.role === "admin" ? getSettings() : redactSettingsSecrets(getSettings()) }));

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg && msg.type === "settings" && msg.payload) {
            // This WS path is a second route to the exact
            // same full-tree overwrite the REST POST /api/settings performs,
            // and jwt.verify() above only checks
            // signature validity - not role - so without this check an
            // "operator" token could just open a WebSocket and send this
            // message to do the one thing requireAdmin exists to stop it
            // from doing over REST. Same admin-only rule, enforced here too.
            // A live lookup, not the connection's own
            // possibly-stale `decoded.role` from connect time - a
            // demotion takes effect on this very next message, not only
            // once the next heartbeat tick happens to close the socket.
            const liveUser = findUser(decoded?.username || "");
            if (!liveUser || liveUser.role !== "admin") {
              ws.send(JSON.stringify({ error: "Access denied: admin privileges required" }));
              return;
            }
            await applySettingsUpdate(msg.payload, ws); // Skip originator to avoid echo
          }
        } catch (e) {
          console.error("Malformed WebSocket message", e);
        }
      });

      ws.on("close", () => wsClients.delete(ws));
      ws.on("error", () => wsClients.delete(ws));
    });
  });

  // Application-level heartbeat: TCP alone doesn't notice a
  // client that vanished without a clean close (laptop went to sleep, Wi-Fi
  // dropped, phone app was killed) - that socket looks OPEN to `ws` and
  // stays in wsClients indefinitely, silently eating a slot in every
  // broadcastSettings() loop, until the OS's own TCP keepalive eventually
  // times out (minutes, and disabled/very long by default on most stacks).
  // Every open connection gets ping()'d on this interval; the `pong`
  // handler above marks it alive again. A connection that was already
  // marked not-alive when its next ping would fire never answered the
  // previous one in time, so it's a half-open socket - terminate() it
  // (skips the graceful close handshake, which a half-open socket can't
  // complete anyway) rather than waiting on TCP. unref() so this timer
  // alone never keeps the process running past a real shutdown signal.
  const HEARTBEAT_INTERVAL_MS = 30000;
  const heartbeatTimer = setInterval(() => {
    for (const ws of wsClients) {
      if ((ws as any).isAlive === false) {
        ws.terminate();
        wsClients.delete(ws);
        continue;
      }
      // The same real re-check as WS connect time, run again
      // on every heartbeat tick - a password/role change or account
      // deletion that happens WHILE this socket is already open closes
      // it here instead of leaving an already-revoked session connected
      // indefinitely until the client happens to reconnect on its own.
      const username = (ws as any).meta?.username;
      if (username) {
        const currentUser = findUser(username);
        // Same real identity check as WS connect time above.
        if (!currentUser || effectiveTokenVersion(currentUser) !== (ws as any).authTokenVersion || effectiveId(currentUser) !== (ws as any).authUserId) {
          authFailuresTotal.inc({ reason: "ws_session_revoked" });
          ws.close(1008, "Access denied: session revoked");
          wsClients.delete(ws);
          continue;
        }
      }
      (ws as any).isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}
