// =============================================================================
// HYDRA-UMC-SERVER - src/cameraProbe.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Real IP-camera probing and PTZ: RTSP path discovery plus the PSIA and
// Hi3510 PTZ conventions. Moved out of server.ts unchanged so the entry
// point stays about wiring, not protocol details.

import http from "http";
import net from "net";
import crypto from "crypto";
import { hi3510Action } from "./serverPolicy";

// --- Camera capture: real per-camera --device argument, RTSP path
// discovery, and USB device discovery for the process supervisor
// (reconcileCameraProcesses(), inside startServer()) ------------------

// CameraSettings/computeDeviceArg now live in ./serverPolicy (see that
// module's own header comment) - moved so this genuinely pure config-to-
// CLI-arg translation is directly unit-testable without spawning a real
// server process, same real gap this move closes for several sibling
// functions below.

// Real RTSP paths this ecosystem has actually seen work, in the order
// worth trying: `/11`/`/12`
// (Hipcam RealServer, verified against .210/.211) and `/profile0`
// (YGTek RTSP Server, verified against .203/.204) are both real,
// confirmed paths from THIS ecosystem's own hardware, not guessed;
// the rest are common real paths from other OEM firmware families,
// tried after those two so the already-proven ones win first.
//
// Deliberately does NOT include a bare `/` - caught live via real user
// feedback on the multi-stream picker this list also feeds (see
// discoverRtspPath()'s own comment): on a real Hipcam unit here, `/`
// answered a real 200 OK ALONGSIDE the genuine `/11`/`/12` pair, not a
// third real distinct stream - a bare root path is effectively a
// generic default/catch-all on many RTSP servers, prone to aliasing
// whatever `/11` already serves rather than naming anything new. Real,
// specific paths belonging to an actual named vendor convention
// (`/Streaming/Channels/1`, the Dahua-style query string, etc.) don't
// have that same "matches everything" failure mode, so they stay.
export const RTSP_PATH_CANDIDATES = [
  "/11", "/12", "/profile0", "/live", "/h264", "/stream1",
  "/Streaming/Channels/1", "/cam/realmonitor?channel=1&subtype=0",
];

export interface RtspDescribeResult {
  ok: boolean;
  // Every real candidate that answered 200 OK, in the order
  // RTSP_PATH_CANDIDATES lists them - a real camera on this ecosystem's
  // own network can expose more than one real stream at once, so this
  // scan never stops at the first match. STUDIO/SUITE's own Config UI
  // persists this full list client-side as a camera's own
  // `discoveredStreamPaths`, to build an honest Main/Sub/Sub N stream
  // picker. `paths[0]` is what a caller should treat as "the" path for
  // backward compatibility with the single-path callers that predate
  // this.
  paths: string[];
  triedPaths: string[];
  error?: string;
}

// One real RTSP OPTIONS+DESCRIBE round trip (RFC 2617 Digest, no `qop` -
// the exact real handshake already verified by hand against this
// ecosystem's own cameras) for
// a single candidate path. Returns the response status line's code, or
// throws/rejects on a real connection failure (caller treats that as
// "this path didn't answer", not fatal to the overall discovery scan).
export function rtspDescribeOnce(host: string, port: number, rtspPath: string, username: string, password: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = `rtsp://${host}:${port}${rtspPath}`;
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 2500);
    let stage: "unauth" | "auth" = "unauth";
    let buffer = "";
    socket.once("connect", () => {
      socket.write(`DESCRIBE ${url} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (!buffer.includes("\r\n\r\n")) return; // wait for the full header block
      const statusMatch = buffer.match(/^RTSP\/1\.0 (\d{3})/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      if (stage === "unauth" && status === 401) {
        const challenge = buffer.match(/WWW-Authenticate:\s*Digest\s+(.+)/i);
        const realmMatch = challenge?.[1].match(/realm="([^"]+)"/);
        const nonceMatch = challenge?.[1].match(/nonce="([^"]+)"/);
        if (!realmMatch || !nonceMatch || !username) {
          clearTimeout(timer);
          socket.destroy();
          resolve(status); // no real credentials to retry with, or camera doesn't use Digest - report the 401 as-is
          return;
        }
        const realm = realmMatch[1];
        const nonce = nonceMatch[1];
        const ha1 = crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest("hex");
        const ha2 = crypto.createHash("md5").update(`DESCRIBE:${url}`).digest("hex");
        const response = crypto.createHash("md5").update(`${ha1}:${nonce}:${ha2}`).digest("hex");
        const authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${url}", response="${response}"`;
        stage = "auth";
        buffer = "";
        socket.write(`DESCRIBE ${url} RTSP/1.0\r\nCSeq: 2\r\nAuthorization: ${authHeader}\r\nAccept: application/sdp\r\n\r\n`);
        return;
      }
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    });
    socket.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// Tries EVERY real candidate path, one at a time with a short pause
// between attempts - the same rate-limit caution already documented in
// memory (a real camera on this ecosystem's own network silently drops
// a connection after repeated authenticated attempts in a tight loop).
// Deliberately does NOT stop at the first 200 OK: a real IP camera here
// can expose more than one real stream at once (this ecosystem's own
// Hipcam units really do answer both `/11` main and `/12` sub), and the
// caller needs the REAL full set to build an honest Main/Sub/Sub N
// stream picker, not just whichever one happened to be tried first.
// Never invents a path: an exhausted list with nothing found is
// reported honestly, listing exactly what was tried either way.
export async function discoverRtspPath(host: string, port: number, username: string, password: string): Promise<RtspDescribeResult> {
  const tried: string[] = [];
  const found: string[] = [];
  for (const candidate of RTSP_PATH_CANDIDATES) {
    tried.push(candidate);
    try {
      const status = await rtspDescribeOnce(host, port, candidate, username, password);
      if (status === 200) {
        found.push(candidate);
      }
    } catch {
      // connection failure on this one candidate - move on to the next, not fatal to the scan
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (found.length > 0) return { ok: true, paths: found, triedPaths: tried };
  return { ok: false, paths: [], triedPaths: tried, error: "none of the known real RTSP paths answered with 200 OK" };
}

export interface PsiaResult {
  ok: boolean;
  statusCode: number;
  body: string;
  error?: string;
}

// One real HTTP auth round trip against this ecosystem's own PSIA
// camera HTTP API - Digest (RFC 2617, no qop, same real handshake
// already verified by hand against .203/.204) OR Basic, decided by
// the real WWW-Authenticate scheme the camera itself sends back on its
// first, unauthenticated 401 - never assumed. Real bug fixed here,
// found live against .210/.211: those two units' own PTZ HTTP API
// challenges with `WWW-Authenticate: Basic realm="..."` (no `nonce` at
// all), while .203/.204's RTSP Digest handshake is unrelated - a
// completely different port/protocol on the same physical camera. The
// old code only ever tried to parse a Digest challenge, so a Basic
// challenge's missing `nonce` fell straight into the "no matching
// Digest challenge was available" honest-failure branch, surfacing to
// STUDIO/SUITE as a real, permanent 401/auth-failure on every PTZ
// command against those cameras even with the exact right password.
export function psiaRequest(host: string, port: number, method: string, urlPath: string, username: string, password: string, body?: string): Promise<PsiaResult> {
  return new Promise((resolve) => {
    const doRequest = (authHeader?: string) => {
      const headers: Record<string, string> = { "Content-Type": "application/xml" };
      if (authHeader) headers["Authorization"] = authHeader;
      if (body) headers["Content-Length"] = String(Buffer.byteLength(body));
      const req = http.request({ host, port, method, path: urlPath, headers, timeout: 4000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode === 401 && !authHeader) {
            const challenge = res.headers["www-authenticate"];
            const challengeStr = Array.isArray(challenge) ? challenge[0] : challenge;
            if (challengeStr && /^\s*Basic\b/i.test(challengeStr)) {
              if (!username) {
                resolve({ ok: false, statusCode: res.statusCode ?? 401, body: data, error: "camera requires Basic authentication and no username was configured for it" });
                return;
              }
              const basic = Buffer.from(`${username}:${password}`).toString("base64");
              doRequest(`Basic ${basic}`);
              return;
            }
            const realmMatch = challengeStr?.match(/realm="([^"]+)"/);
            const nonceMatch = challengeStr?.match(/nonce="([^"]+)"/);
            if (!realmMatch || !nonceMatch || !username) {
              resolve({ ok: false, statusCode: res.statusCode ?? 401, body: data, error: "camera requires authentication and none (or no matching Digest/Basic challenge) was available" });
              return;
            }
            const realm = realmMatch[1];
            const nonce = nonceMatch[1];
            const ha1 = crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest("hex");
            const ha2 = crypto.createHash("md5").update(`${method}:${urlPath}`).digest("hex");
            const response = crypto.createHash("md5").update(`${ha1}:${nonce}:${ha2}`).digest("hex");
            doRequest(`Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${urlPath}", response="${response}"`);
            return;
          }
          resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, statusCode: res.statusCode ?? 0, body: data });
        });
      });
      req.on("error", (err) => resolve({ ok: false, statusCode: 0, body: "", error: err.message }));
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, statusCode: 0, body: "", error: "timeout" }); });
      if (body) req.write(body);
      req.end();
    };
    doRequest();
  });
}

// One real GET against the Hi3510 CGI PTZ convention (`/cgi-bin/hi3510/
// ptzctrl.cgi?-step=0&-act=<action>&-speed=<1-63>`) - the REAL, live-
// verified API this ecosystem's own PTZ-capable cameras (.210/.211,
// "Server: Hipcam", genuine Hi3510 chipset - confirmed live via their
// own `cgi-bin/hi3510/param.cgi` reference in their served HTML) answer
// with a real `[Succeed]set ok.` body, HTTP Basic auth (never Digest -
// their own PSIA-shaped 401 challenge, tried first below, turned out to
// just be this same firmware's generic web-login wall guarding an
// unimplemented path, not a real PSIA server). Uses plain http.get
// rather than psiaRequest()'s own Digest-then-retry flow: Basic auth
// can be sent pre-emptively in one round trip, no challenge needed.
export function hi3510PtzRequest(host: string, port: number, username: string, password: string, action: string, speed: number): Promise<PsiaResult> {
  return new Promise((resolve) => {
    const auth = username ? `${username}:${password}@` : "";
    const url = `http://${auth}${host}:${port}/cgi-bin/hi3510/ptzctrl.cgi?-step=0&-act=${encodeURIComponent(action)}&-speed=${speed}`;
    const req = http.get(url, { timeout: 4000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ ok: (res.statusCode ?? 0) === 200 && /\[Succeed\]/.test(data), statusCode: res.statusCode ?? 0, body: data }));
    });
    req.on("error", (err) => resolve({ ok: false, statusCode: 0, body: "", error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, statusCode: 0, body: "", error: "timeout" }); });
  });
}

// hi3510Action now lives in ./serverPolicy (see that module's own header
// comment) - the pan/tilt/zoom-magnitudes-to-CGI-direction mapping that
// used to be declared here moved there unchanged, so it's directly
// unit-testable.

// Real PTZ control - IP cameras only, this ecosystem's own USB cameras
// have no pan/tilt/zoom hardware to speak of. Tries this ecosystem's
// own real, live-verified Hi3510 CGI convention first (hi3510PtzRequest
// above - the actual protocol .210/.211's real PTZ hardware speaks),
// falling back to the PSIA XML API (psiaRequest) for a camera that
// genuinely doesn't answer the Hi3510 path - never assumes one family
// over the other, tries the real one first and reports whichever
// actually answered. A camera with no PTZ hardware at all answers
// honestly on both attempts (this firmware returns a real HTTP error
// for a channel that doesn't support it) - reported back as-is, never
// pretended to work.
export async function sendPtzCommand(host: string, httpPort: number, username: string, password: string, channel: number, pan: number, tilt: number, zoom: number): Promise<PsiaResult> {
  const action = hi3510Action(pan, tilt, zoom);
  const magnitude = Math.max(Math.abs(pan), Math.abs(tilt), Math.abs(zoom));
  const speed = Math.max(1, Math.min(63, Math.round((magnitude / 100) * 63) || 45));
  const hi3510Result = await hi3510PtzRequest(host, httpPort, username, password, action ?? "stop", speed);
  if (hi3510Result.ok) return hi3510Result;
  const body = `<PTZData version="1.0" xmlns="urn:psialliance-org"><pan>${pan}</pan><tilt>${tilt}</tilt><zoom>${zoom}</zoom></PTZData>`;
  const psiaResult = await psiaRequest(host, httpPort, "PUT", `/PSIA/PTZ/channels/${channel}/continuous`, username, password, body);
  if (psiaResult.ok) return psiaResult;
  // Neither real convention worked - the Hi3510 attempt is the more
  // specific, more likely-correct error for THIS ecosystem's own real
  // hardware (see this function's own comment), so it wins when both
  // failed rather than whichever happened to run last.
  return hi3510Result.statusCode !== 0 ? hi3510Result : psiaResult;
}
