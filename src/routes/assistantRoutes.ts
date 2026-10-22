// =============================================================================
// HYDRA-UMC-SERVER - src/routes/assistantRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The voice turn relay and the watch status payload, moved out of server.ts unchanged.
import express from "express";
import { realSettings, remoteAccessAllowed } from "../serverPolicy";
import { getSystemMetrics } from "../systemMetrics";
import { industrialLog } from "../runtime";
import { VOICE_UI_URL, VOICE_UI_TOKEN, VOICE_UI_TIMEOUT_MS, validateVoiceTurnPayload, isAssistantReplyForRequest } from "../upstreamConfig";

type Middleware = (req: any, res: any, next: any) => unknown;

export function registerAssistantRoutes(app: express.Express, deps: { authenticate: Middleware; getSettings: () => any }): void {
  const { authenticate, getSettings } = deps;
  // Real spoken "status" text for the voice assistant's own status intent -
  // see this function's one real call site (POST /api/voice/turn) for why
  // this exists at all. Reuses the exact same real sources
  // GET /api/hydra-info (controller/robot counts) and
  // GET /api/watch/system-status (CPU/memory/uptime) already read from -
  // never a second, competing computation of either. `robotIdEntity`, when
  // present ("status of robot N"), is answered honestly from this Server's
  // own real registered-robot list - there is no real per-robot LIVE
  // telemetry available at this relay step yet, so this never fabricates
  // an online/offline claim for one, only whether it's actually registered.
  async function buildVoiceStatusText(entities: unknown): Promise<string> {
    const s = getSettings();
    const controllers = Array.isArray(s?.controllers) ? s.controllers : [];
    const controllerCount = controllers.length;
    const robotCount = controllers.reduce(
      (n: number, c: any) => n + (Array.isArray(c.robots) ? c.robots.length : 0),
      0,
    );
    const metrics = await getSystemMetrics();
    const summary = `${controllerCount} controller${controllerCount === 1 ? "" : "s"}, ` +
      `${robotCount} robot${robotCount === 1 ? "" : "s"} configured. ` +
      `CPU load ${metrics.cpu_load}%, memory ${metrics.memory_usage}%, uptime ${metrics.uptime}s.`;

    const robotIdRaw = entities && typeof entities === "object" ? (entities as Record<string, unknown>).robot_id : undefined;
    if (typeof robotIdRaw !== "string") return summary;
    const robotId = parseInt(robotIdRaw, 10);
    let found = false;
    for (const c of controllers) {
      if (Array.isArray(c.robots) && c.robots.some((r: any) => r.id === robotId)) {
        found = true;
        break;
      }
    }
    const robotNote = found
      ? `Robot ${robotId} is registered on this Server. `
      : `Robot ${robotId} is not registered on this Server. `;
    return robotNote + summary;
  }

  // Authenticated, non-actuating relay for a recognised voice turn. The
  // phone/watch presents its ordinary Server JWT; the Server alone holds the
  // local Voice UI token. This is intentionally REST rather than a robot
  // command route, and it never translates an intent into movement.
  app.post("/api/voice/turn", authenticate, async (req, res) => {
    // Real per-client gate (Config > Remote Access, remoteAccessAllowed()'s
    // own header comment above) - the paired phone sends
    // X-Hydra-Client: watch only for this relayed-on-the-Watch's-behalf
    // call, never for its own ordinary Android traffic, so disabling Watch
    // access here cannot also lock that same phone out of its own session.
    if (!remoteAccessAllowed(realSettings(getSettings()), req.headers["x-hydra-client"] as string | undefined)) {
      return res.status(404).end();
    }
    const validationError = validateVoiceTurnPayload(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    if (!VOICE_UI_URL) {
      return res.status(503).json({ error: "HYDRA-UMC-VOICE-UI is not configured on this Server" });
    }

    const requestId = req.body.requestId as string;
    try {
      const upstream = await fetch(`${VOICE_UI_URL}/v1/voice/turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(VOICE_UI_TOKEN ? { authorization: `Bearer ${VOICE_UI_TOKEN}` } : {}),
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(VOICE_UI_TIMEOUT_MS),
      });
      const reply = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        console.warn(`[VOICE] gateway rejected requestId=${requestId} status=${upstream.status}`);
        return res.status(502).json({ error: "HYDRA-UMC-VOICE-UI rejected the voice turn" });
      }
      if (!isAssistantReplyForRequest(reply, requestId)) {
        console.error(`[VOICE] gateway contract failure requestId=${requestId}`);
        return res.status(502).json({ error: "HYDRA-UMC-VOICE-UI returned an invalid assistant reply" });
      }
      // Real gap found live: HYDRA-UMC-VOICE-UI's own gateway.py is a
      // deliberately pure/stateless intent classifier (its own docstring:
      // "an authenticated Server ... integration can replace the response
      // policy without changing the wire shape") - a real "status" turn
      // came back as a canned "Live telemetry will be supplied by the
      // authenticated HYDRA-UMC gateway" placeholder, never actual data,
      // because nothing ever supplied it. This Server already has the
      // real data (the same getSystemMetrics()/getSettings().controllers
      // GET /api/watch/system-status and GET /api/hydra-info themselves
      // read from) and already owns this relay step - the natural, real
      // place to fill that promise in, without VOICE-UI ever needing
      // outbound network access of its own.
      if (reply.intent && (reply.intent as any).name === "status") {
        reply.text = await buildVoiceStatusText((reply.intent as any).entities);
      }
      // Do not log the transcript or reply text: both can contain operator
      // information. The correlation ID and safety fields are sufficient for
      // operational diagnosis.
      industrialLog(`[VOICE] requestId=${requestId} level=${reply.level} confirmation=${reply.requiresConfirmation}`);
      res.set("Cache-Control", "no-store").json(reply);
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      console.error(`[VOICE] gateway unavailable requestId=${requestId} reason=${timedOut ? "timeout" : "connection"}`);
      res.status(503).json({ error: timedOut ? "HYDRA-UMC-VOICE-UI timed out" : "HYDRA-UMC-VOICE-UI is unavailable" });
    }
  });

  // Small, authenticated status payload shared by phone/watch surfaces. It
  // exposes health only, never full settings, usernames or machine paths.
  app.get("/api/watch/system-status", authenticate, async (req, res) => {
    // Same real per-client gate as POST /api/voice/turn above - see that
    // route's own comment.
    if (!remoteAccessAllowed(realSettings(getSettings()), req.headers["x-hydra-client"] as string | undefined)) {
      return res.status(404).end();
    }
    const metrics = await getSystemMetrics();
    const level = metrics.temp_is_real && (metrics.temp ?? 0) >= 80
      ? "CRITICAL"
      : metrics.temp_is_real && (metrics.temp ?? 0) >= 70
        ? "WARNING"
        : "NOMINAL";
    res.set("Cache-Control", "no-store").json({
      type: "system_status",
      headline: level === "NOMINAL" ? "HYDRA-UMC Server online" : "HYDRA-UMC Server temperature warning",
      detail: `CPU load ${metrics.cpu_load} · memory ${metrics.memory_usage}% · uptime ${metrics.uptime}s`,
      level,
      speak: level !== "NOMINAL",
    });
  });
}
