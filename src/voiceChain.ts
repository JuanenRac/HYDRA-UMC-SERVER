// =============================================================================
// HYDRA-UMC-SERVER - src/voiceChain.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The record of the voice commands that pass through this server, for traceability in a plant: each turn and each confirmation becomes
// one entry of the signed hash-chained record (ingestLog.ts): signed with the key of THIS server and chained by hash to the entry before
// it, so a changed, removed or forged entry is found by `verify`. The voice interface keeps its own log, signed with its own key; this one
// is the copy that the server vouches for. An entry holds the request id, the intent name, the level, whether a confirmation was asked,
// the status of a confirmation and a short keyed hash of the person. It never holds the transcript, the reply text, audio, locale or address.
// Off until HYDRA_UMC_VOICE_CHAIN is "1"; a failure to write never stops a voice command.
import crypto from "node:crypto";
import { identityKey } from "./serviceIdentity";
import type { ChainedLog } from "./ingestLog";

export type Env = Record<string, string | undefined>;

export const SWITCH_VOICE_CHAIN = "HYDRA_UMC_VOICE_CHAIN";

export interface VoiceEvent {
  event: "turn" | "confirm";
  requestId: string;
  intent?: string;
  level?: string;
  requiresConfirmation?: boolean;
  status?: string;
  subject?: string;
}

const short = (value: unknown, max = 64): string => (typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : "");

/** The person as a short keyed hash (16 hex characters): the entry shows that the same person did two things without saying who. */
export function subjectHash(subject: string, env: Env = process.env): string {
  const key = identityKey(env);
  if (!subject || !key) return "";
  return crypto.createHmac("sha256", key).update(`voice-subject:${subject}`).digest("hex").slice(0, 16);
}

/** The payload of an entry; only these fields are ever written. */
export function voiceRecordPayload(e: VoiceEvent, env: Env = process.env): Record<string, unknown> {
  return {
    event: e.event === "confirm" ? "confirm" : "turn",
    request_id: short(e.requestId),
    intent: short(e.intent),
    level: short(e.level, 16),
    requires_confirmation: e.requiresConfirmation === true,
    status: short(e.status, 32),
    subject: subjectHash(e.subject ?? "", env),
  };
}

/** Writes one entry. Returns false when the switch is off or the entry could not be written (it never throws). */
export function recordVoiceEvent(log: ChainedLog | null, e: VoiceEvent, env: Env = process.env, warn: (message: string) => void = () => undefined): boolean {
  if (!log || (env[SWITCH_VOICE_CHAIN] ?? "").trim() !== "1") return false;
  try {
    log.append("voice", voiceRecordPayload(e, env));
    return true;
  } catch (error) {
    warn(`[voice-chain] an entry was not written: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
