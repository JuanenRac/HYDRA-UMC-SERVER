// =============================================================================
// HYDRA-UMC-SERVER - src/cameraHealth.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Is a camera's stream process really delivering frames? A bare TCP connect only says the process holds the port: a
// frozen RTSP session or a stuck capture backend keeps the port open and sends nothing, so it looked healthy and the
// supervisor never respawned it. HYDRA-UMC-VISION-STREAMER answers GET /health with whether frames are arriving right
// now (200 when they are, 503 with the state when they are not); this asks that, and falls back to the TCP check
// for a streamer that does not have the route (404), so an older install keeps working as before.
import http from "node:http";
import { probeTcp, SERVICE_PROBE_HOST, SERVICE_PROBE_TIMEOUT_MS } from "./ecosystemStatus";

export interface CameraStreamHealth {
  // the process answers on its port at all
  up: boolean;
  // true: frames are arriving; false: the port answers but no frames are; null: the streamer cannot say (older one)
  streaming: boolean | null;
  // the streamer's own word for it when it is not streaming: connecting, stalled, given_up
  state?: string;
}

export function streamHealthy(health: CameraStreamHealth): boolean {
  return health.up && health.streaming !== false;
}

export function describeUnhealthy(health: CameraStreamHealth): string {
  if (!health.up) return "no answer on its port";
  if (health.streaming === false) return `answers on its port but sends no frames (${health.state ?? "no state"})`;
  return "healthy";
}

export function probeCameraStream(
  port: number,
  host: string = SERVICE_PROBE_HOST,
  timeoutMs: number = SERVICE_PROBE_TIMEOUT_MS,
): Promise<CameraStreamHealth> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (health: CameraStreamHealth) => {
      if (settled) return;
      settled = true;
      resolve(health);
    };
    const request = http.get({ host, port, path: "/health", timeout: timeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 8192) chunks.push(chunk); // a health report is a few hundred bytes; never keep more than a few KiB
      });
      response.on("end", () => {
        if (status === 200) return finish({ up: true, streaming: true });
        if (status === 503) {
          let state: string | undefined;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            if (typeof parsed?.state === "string") state = parsed.state.slice(0, 40);
          } catch { /* an unreadable body still says "no frames" */ }
          return finish({ up: true, streaming: false, state });
        }
        // 404 or anything else: a streamer without the route, or something that is not a streamer. The port answers
        // HTTP, which is all the old check ever knew.
        return finish({ up: true, streaming: null });
      });
      response.on("error", () => finish({ up: false, streaming: null }));
    });
    request.on("timeout", () => {
      timedOut = true;
      request.destroy();
      // it accepted the connection but did not answer in time: the same as a port that answers with no frames would be
      // too strong a claim; fall back to what a TCP connect says
      void probeTcp(port, host).then((up) => finish({ up, streaming: null }));
    });
    request.on("error", () => {
      if (!timedOut) finish({ up: false, streaming: null });
    });
  });
}
