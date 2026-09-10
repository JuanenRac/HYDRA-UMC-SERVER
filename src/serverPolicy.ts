// =============================================================================
// HYDRA-UMC-SERVER - Pure policy/translation helpers extracted from server.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Found while auditing the code: server.ts (the
// single busiest, most business-critical file in this ecosystem) had zero
// direct unit tests - only the real, valuable but end-to-end
// tools/verify_*_contract.mjs scripts, each spinning up a whole real server
// process. Several of its own functions are genuinely pure (no request/
// response object, no outer mutable state, no I/O) - some already sat at
// module scope inside server.ts (remoteAccessAllowed, realSettings,
// computeDeviceArg, hi3510Action), others were declared INSIDE
// startServer()'s own closure despite never touching anything from that
// closure (cameraFingerprint, safeIdSegment, slugify, cameraStreamPort).
// Both groups are moved here, unchanged, so they are independently
// importable and directly unit-testable (see tests/serverPolicy.test.ts)
// without needing to spawn a real server process. server.ts imports every
// one of these back and calls them exactly as it did before this move.

// Per-client remote-access toggles (Config > Remote Access in the browser
// UI, src/store.tsx's own SystemSettings.remoteAccess) - 5 independent
// toggles (SUITE/Android/iOS/Watch/DSI) instead of one combined switch, so
// e.g. Android access can be revoked without also blocking SUITE. Each of
// the 5 real clients sends its own `X-Hydra-Client: suite|android|ios|
// watch|dsi` request header (see each project's own network client) - a
// request with NO such header (a plain browser tab, curl, or any other
// unidentified caller) is never gated here, since this check only exists
// to control the 5 named remote apps, not this same server's own browser
// UI (which never sends that header and reaches this same route from
// About.tsx's own version check). "watch" is distinct from "android":
// HYDRA-UMC-WATCH has no direct connection of its own - it relays through
// the paired phone's own HydraApiClient, which sends this specific header
// only for the 2 real Watch-relay calls (POST /api/voice/turn, GET
// /api/watch/system-status), not for the phone app's own ordinary traffic
// - so Watch access can be revoked without also blocking that same
// phone's direct Android access.
//
// Real gap found and fixed here while auditing the code:
// HYDRA-UMC-DSI's own hydra_api_client.dart already sends
// `X-Hydra-Client: dsi` on every request (see that file's own header
// comment - it was written anticipating this gate) but this function
// never recognized "dsi" as one of the gated client types, so a DSI kiosk
// request fell into the same "no such header" bucket as an ungated
// browser tab and always passed regardless of the Remote Access toggle
// state - the toggle for DSI (added to store.tsx/Config.tsx in the same
// pass) previously had no server-side enforcement whatsoever.
export function remoteAccessAllowed(settings: any, clientType: string | undefined): boolean {
  if (clientType !== "suite" && clientType !== "android" && clientType !== "ios" && clientType !== "watch" && clientType !== "dsi") return true;
  const ra = settings?.remoteAccess;
  if (!ra) return true; // no config saved at all yet - matches this feature's own original always-on default
  const specific = ra[clientType];
  if (specific !== undefined) return specific !== false;
  return ra.enabled !== false; // legacy singular toggle, only consulted if this client's own flag was never set
}

// The real wire shape POST/GET /api/settings and the WS "settings"/"delta"
// payload all use is { settings: SystemSettings, controllers, activeControllerId }
// (see docs/REMOTE_API.md section 2c, src/store.tsx's own POST body) - every
// SystemSettings field (serverName, remoteAccess, modelSubmissions, ...)
// lives ONE LEVEL DEEPER than `controllers`/`activeControllerId`. Reading
// lastKnownSettings.serverName / lastKnownSettings.remoteAccess directly
// (instead of lastKnownSettings.settings.serverName /
// lastKnownSettings.settings.remoteAccess) is always undefined against the
// real payload shape - a trap it's easy to fall into at any call site that
// reads lastKnownSettings (the mDNS name at startup/on every write, and
// this exact remoteAccessAllowed() call), which would silently make the
// per-client Remote Access toggles do nothing (remoteAccessAllowed() would
// always see `settings` as undefined and therefore always return true) and
// make a server rename from Config > Identity never actually update its
// own mDNS advertisement. This helper is the one place that gets it right,
// used everywhere below instead of reaching into either shape directly.
export function realSettings(payload: any): any {
  return payload?.settings ?? payload;
}

// The exact shape HYDRA-UMC-STUDIO's own Config.tsx (configTab ===
// 'cameras') and HYDRA-UMC-SUITE's own CameraCard already write into
// controller.cameras[] - see store.tsx's own CameraState interface and
// models.py's own CameraView, both already field-complete and
// camelCase-matched to this. Loosely typed here (matching the rest of
// this file's own settings handling, which is `any` throughout) rather
// than introducing a stricter type only this one function would honor.
export interface CameraSettings {
  sourceType?: "usb" | "ip";
  hardwareSource?: string;
  ipHost?: string;
  rtspPort?: number;
  rtspPath?: string;
  ipUsername?: string;
  ipPassword?: string;
  // The real on/off switch (Vision Center's own "toggle connection"
  // button) - checked by reconcileCameraProcesses() itself, NOT by
  // cameraFingerprint() below (this field toggling shouldn't count as
  // "the connection config changed", it's a separate stop/start
  // decision - see that function's own comment).
  connected?: boolean;
}

// Translates a camera's real config into the exact string
// `hydra-umc-vision-streamer stream serve --device <this>` expects -
// see that project's own config.py CameraConfig/rtsp_url(). Returns
// null (never throws, never guesses) when the config can't honestly be
// turned into a real device argument, so the caller can report a real
// "unrecognized device" status instead of spawning something wrong.
export function computeDeviceArg(camera: CameraSettings): string | null {
  if (camera.sourceType === "ip") {
    const host = (camera.ipHost || "").trim();
    if (!host) return null;
    const port = Number.isInteger(camera.rtspPort) && camera.rtspPort! > 0 ? camera.rtspPort! : 554;
    const rawPath = (camera.rtspPath || "/").trim();
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const user = camera.ipUsername ? encodeURIComponent(camera.ipUsername) : "";
    const pass = camera.ipPassword ? encodeURIComponent(camera.ipPassword) : "";
    const auth = user || pass ? `${user}:${pass}@` : "";
    return `rtsp://${auth}${host}:${port}${path}`;
  }
  // "usb", or sourceType absent (every pre-existing camera entry from
  // before this field existed defaults to usb, matching STUDIO/SUITE's
  // own `sourceType ?? "usb"` fallback).
  const raw = (camera.hardwareSource || "").trim();
  if (!raw) return null;
  if (/^\/dev\/video\d+$/.test(raw)) return raw; // real V4L2 path (Linux/CM5)
  if (/^\d+$/.test(raw)) return raw; // already a bare device index (Windows/OpenCV)
  const seedMatch = raw.match(/^USB_DEV_(\d+)$/);
  if (seedMatch) return seedMatch[1]; // this app's own default-seed placeholder (createDefaultCameras()), not a real path - the index it encodes IS real
  return null; // genuinely unrecognized format - don't guess
}

// One real fingerprint of the connection-relevant fields of a camera's own
// config (deliberately excludes `connected` - see CameraSettings' own
// comment on that field) - reconcileCameraProcesses() compares this
// against the fingerprint its running process was started with to decide
// whether a config change means "restart the capture process" or "nothing
// that process cares about changed".
export function cameraFingerprint(camera: CameraSettings): string {
  return JSON.stringify({
    sourceType: camera.sourceType ?? "usb",
    hardwareSource: camera.hardwareSource ?? null,
    ipHost: camera.ipHost ?? null,
    rtspPort: camera.rtspPort ?? null,
    rtspPath: camera.rtspPath ?? null,
    ipUsername: camera.ipUsername ?? null,
    ipPassword: camera.ipPassword ?? null,
  });
}

// One real camera's own MJPEG proxy port - deterministic (8100 + id - 1)
// so camera 1 -> 8100, camera 2 -> 8101, etc., up to the documented
// 8-camera cap, with no separate port-mapping config file needed for a v0
// this small. Shared by GET /api/camera/:id/stream and the camera process
// supervisor, so the two can never disagree about which port a given
// camera's own mjpeg_server.py instance is really listening on.
export function cameraStreamPort(id: number): number {
  return 8100 + (id - 1);
}

// Translates the same discrete pan/tilt/zoom magnitudes the PSIA path
// takes (each -100..100, 0/0/0 = stop - see CamerasView.tsx's own
// PTZ button grid, which only ever sends one axis at a time plus its
// own diagonals) into a real Hi3510 `-act=` direction. Never guesses a
// diagonal from independently-arriving pan+tilt - CamerasView.tsx's own
// buttons are single-axis by construction, so treating "both non-zero"
// as impossible here and falling back to whichever axis is non-zero
// first is honest, not a real limitation of this camera's own API
// (which does support the 4 diagonals, unused by this UI today).
export function hi3510Action(pan: number, tilt: number, zoom: number): string | null {
  if (pan < 0) return "left";
  if (pan > 0) return "right";
  if (tilt > 0) return "up";
  if (tilt < 0) return "down";
  if (zoom > 0) return "zoomin";
  if (zoom < 0) return "zoomout";
  return "stop";
}

// Filesystem-safe rendering of a controller/robot id for use as a path
// segment in getPointsPath() (server.ts) - controller ids are client-
// supplied (POST /api/settings writes controllers[].id as given, see that
// route), so this can't just interpolate one raw into a path: anything
// outside this allowlist (a literal ".."/"/" segment, most obviously)
// becomes a single "_" instead, closing off path traversal without ever
// rejecting the write outright (an id this function would need to touch
// already isn't achievable through the STUDIO/SUITE/mobile UIs, which
// only ever set it to an IP or hostname - this is defense in depth
// against a malformed/adversarial direct API caller, not a UI validation
// gap).
export function safeIdSegment(id: unknown): string {
  const s = String(id ?? "");
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 128) : "_";
}

// Real slug generation for a submitted model's own folder name (POST
// /api/models/submit) - lowercase, non-alphanumeric runs collapsed to a
// single hyphen, leading/trailing hyphens trimmed. Never empty: a name
// that slugifies to nothing (e.g. all punctuation/whitespace) becomes
// "model" rather than an unusable empty folder name.
export function slugify(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "model";
}
