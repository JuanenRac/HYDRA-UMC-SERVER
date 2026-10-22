// =============================================================================
// HYDRA-UMC-SERVER - src/upstreamConfig.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The upstream service addresses and timeouts (voice assistant, data lake, SPI bridge,
// connector hub) and the voice turn validators, moved out of server.ts unchanged.
// Optional local cognitive boundary. Server is the only component that knows
// how to reach Voice UI; watches and phones keep using their authenticated
// Server session and never receive the Voice UI token. Leaving the URL unset
// keeps the endpoint unavailable rather than silently falling back to an
// unauthenticated or guessed process.
export const VOICE_UI_URL = (process.env.HYDRA_UMC_VOICE_UI_URL || "").replace(/\/$/, "");
export const VOICE_UI_TOKEN = process.env.HYDRA_UMC_VOICE_UI_TOKEN || "";
export const VOICE_UI_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.HYDRA_UMC_VOICE_UI_TIMEOUT_MS) || 4000, 250),
  10000,
);

// Same reasoning and same shape as VOICE_UI_URL above, for STUDIO's
// Ecosystem > Telemetry panel: Server is the only component that knows how
// to reach Datalake, so STUDIO stays a thin frontend of Server instead of a
// second client that has to know Datalake's own host/port. Datalake's own
// HTTP API (GET /query, GET /aggregate - see HYDRA-UMC-DATALAKE/src/
// hydra_umc_datalake/api.py) takes no auth of its own today (same
// same-host-only assumption as every other real service probe in this
// file), so there is no upstream token to hold here, unlike Voice UI.
export const DATALAKE_URL = (process.env.HYDRA_UMC_DATALAKE_URL || "").replace(/\/$/, "");
export const DATALAKE_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.HYDRA_UMC_DATALAKE_TIMEOUT_MS) || 4000, 250),
  10000,
);

// Same reasoning and same shape as VOICE_UI_URL/DATALAKE_URL above, for
// STUDIO's Flasher/Tester (canOta.ts's own `transport === 'hardware'`
// switch): Server is the only component that talks to the real local
// spi_bridge HTTP service (HYDRA-UMC/src/cm5_host/spi_bridge/, itself the
// only thing on the CM5 that owns the real SPI1 device + HYDRA_DATA_READY
// GPIO line). Leaving this unset keeps every /api/hardware/canota/* route
// answering 503 rather than silently pretending hardware is connected -
// same "no guessed process" reasoning as VOICE_UI_URL.
export const SPI_BRIDGE_URL = (process.env.HYDRA_UMC_SPI_BRIDGE_URL || "").replace(/\/$/, "");
export const SPI_BRIDGE_VERSION_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.HYDRA_UMC_SPI_BRIDGE_TIMEOUT_MS) || 4000, 250),
  10000,
);

// Same reasoning and same shape as VOICE_UI_URL/DATALAKE_URL/SPI_BRIDGE_URL
// above, for HYDRA-UMC-CONNECTOR-HUB's own real `serve-catalog` (Python,
// GET-only - see that project's own catalog_server.py). This is Server's
// first real client of the adapter catalog (previously only a CLI/fixture
// existed - see that project's own README "No real client integration
// yet"): Server proxies /catalog(/:id) so Studio/Suite/Updater can read
// what an external-machine adapter can do without each of them needing to
// know CONNECTOR-HUB's own host/port. No auth token of its own to hold
// here (same as Datalake) - the catalog is read-only manifest metadata,
// never a real credential (authenticationRef is a reference, never the
// secret itself - see that project's own docs/ADAPTER_MANIFEST.md).
export const CONNECTOR_HUB_URL = (process.env.HYDRA_UMC_CONNECTOR_HUB_URL || "").replace(/\/$/, "");
export const CONNECTOR_HUB_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.HYDRA_UMC_CONNECTOR_HUB_TIMEOUT_MS) || 4000, 250),
  10000,
);
// A real flash cycle (page-by-page transfer + verify) genuinely takes
// longer than a version query - bounded separately and far more generously,
// but still bounded: an unresponsive board must eventually surface as a
// real, reported failure, never hang this request forever.
export const SPI_BRIDGE_FLASH_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.HYDRA_UMC_SPI_BRIDGE_FLASH_TIMEOUT_MS) || 120000, 5000),
  600000,
);

export const VOICE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function validateVoiceTurnPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "voice turn must be a JSON object";
  }
  const candidate = payload as Record<string, unknown>;
  if (candidate.type !== "voice_turn") return "type must be voice_turn";
  if (typeof candidate.requestId !== "string" || !VOICE_REQUEST_ID.test(candidate.requestId)) {
    return "requestId must contain 1-64 letters, digits, _ or -";
  }
  if (typeof candidate.transcript !== "string" || !candidate.transcript.trim() || candidate.transcript.length > 500) {
    return "transcript must contain 1-500 characters";
  }
  if (typeof candidate.locale !== "string" || candidate.locale.length < 2 || candidate.locale.length > 35) {
    return "locale must contain 2-35 characters";
  }
  return null;
}

export function isAssistantReplyForRequest(payload: unknown, requestId: string): payload is Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const candidate = payload as Record<string, unknown>;
  return candidate.type === "assistant_reply" &&
    candidate.requestId === requestId &&
    typeof candidate.text === "string" && candidate.text.length > 0 && candidate.text.length <= 600 &&
    typeof candidate.level === "string" &&
    typeof candidate.speak === "boolean" &&
    typeof candidate.requiresConfirmation === "boolean";
}
