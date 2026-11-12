// =============================================================================
// HYDRA-UMC-SERVER - src/twinRelay.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// A relay for the live state the twin pushes over its own WebSocket. The twin asks for an Authorization header on the opening
// request and refuses a request that carries an Origin, and a browser can send neither: it can only send a subprotocol, and the
// panels only speak to this server. So the panels open `/api/twin/ws` here with the same `hydra.bearer` subprotocol as `/ws`; this
// server checks the session, opens the twin's socket with the person's own token in a header, and passes what the twin pushes on.
// Nothing a client sends reaches the twin (the twin only pushes). Off until HYDRA_UMC_TWIN_WS_URL is set.
import type { IncomingMessage } from "http";
import { WebSocket } from "ws";
import { WS_TOKEN_SUBPROTOCOL, wsTokenFromSubprotocol } from "./serverPolicy";
import { authFailuresTotal } from "./metrics";

export const TWIN_RELAY_PATH = "/api/twin/ws";
/** How many panels may watch the twin at once through this server. */
export const TWIN_RELAY_MAX_SESSIONS = 8;
const UPSTREAM_HANDSHAKE_MS = 5000;
/** A panel that falls this far behind is dropped rather than buffered for ever. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_UPSTREAM_MESSAGE_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 30000;

/** The answer of the session check: `recheck` tells later whether the same session is still valid (the account may change meanwhile). */
export type SessionCheck = { ok: true; recheck: () => boolean } | { ok: false; reason: string };

export interface TwinRelayDeps {
  /** The ws:// or wss:// address of the twin's push route (empty or invalid: the relay is off). */
  twinWsUrl: string;
  verifySession: (token: string) => Promise<SessionCheck>;
  heartbeatMs?: number;
}

/** The address to open, or null when it is empty, not ws/wss, or carries credentials. */
export function normalizeTwinWsUrl(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

let activeSessions = 0;
/** For tests: how many relays are open now. */
export function activeTwinRelaySessions(): number {
  return activeSessions;
}

function refuse(ws: WebSocket, code: number, message: string) {
  try { ws.send(JSON.stringify({ error: message })); } catch { /* the client is gone */ }
  setTimeout(() => { try { ws.close(code, message.slice(0, 100)); } catch { /* already closed */ } }, 100);
}

/** Serves one panel connection that was opened on TWIN_RELAY_PATH. */
export function handleTwinRelay(ws: WebSocket, req: IncomingMessage, deps: TwinRelayDeps): void {
  const token = wsTokenFromSubprotocol(req.headers["sec-websocket-protocol"]);
  if (!token) {
    authFailuresTotal.inc({ reason: "ws_no_token" });
    refuse(ws, 1008, `Access denied: send the token as the ${WS_TOKEN_SUBPROTOCOL} subprotocol`);
    return;
  }
  void deps.verifySession(token).then((session) => {
    if (!session.ok) {
      authFailuresTotal.inc({ reason: "ws_token_invalid" });
      refuse(ws, 1008, `Access denied: ${session.reason}`);
      return;
    }
    const target = normalizeTwinWsUrl(deps.twinWsUrl);
    if (!target) {
      refuse(ws, 1013, "The twin is not configured on this Server");
      return;
    }
    if (activeSessions >= TWIN_RELAY_MAX_SESSIONS) {
      refuse(ws, 1013, "Too many panels are watching the twin");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    activeSessions++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeSessions--;
      clearInterval(timer);
      try { upstream.terminate(); } catch { /* not open */ }
    };

    // The person's own token goes to the twin in the header it asks for; no Origin is sent.
    const upstream = new WebSocket(target, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: UPSTREAM_HANDSHAKE_MS,
      followRedirects: false,
      maxPayload: MAX_UPSTREAM_MESSAGE_BYTES,
    });

    let alive = true;
    ws.on("pong", () => { alive = true; });
    const timer = setInterval(() => {
      if (!alive || !session.recheck()) {
        ws.terminate();
        release();
        return;
      }
      alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }, deps.heartbeatMs ?? HEARTBEAT_MS);
    timer.unref?.();

    upstream.on("message", (data, isBinary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.close(1013, "This panel is too slow for the twin");
        release();
        return;
      }
      ws.send(data as any, { binary: isBinary });
    });
    const upstreamGone = (message: string) => {
      if (released) return;
      if (ws.readyState === WebSocket.OPEN) refuse(ws, 1011, message);
      release();
    };
    upstream.on("error", () => upstreamGone("The twin is unavailable"));
    upstream.on("unexpected-response", () => upstreamGone("The twin refused the connection"));
    upstream.on("close", () => upstreamGone("The twin closed the connection"));

    // What the panel sends is never forwarded: the twin only pushes.
    ws.on("message", () => { /* ignored */ });
    ws.on("close", release);
    ws.on("error", release);
  });
}
