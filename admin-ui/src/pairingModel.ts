// =============================================================================
// HYDRA-UMC SERVER - Admin UI pairing link: pairingModel.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The text the pairing code of the Security tab carries, which the control apps read and check before they keep anything:
//
//     hydra-umc://pair?host=192.168.0.180&port=3000&fp=<64 hex digits>&name=Workshop
//
// This file only builds and checks the text (the limits are the ones of the apps' command contract); it draws and sends nothing.
// =============================================================================

export const PAIRING = { scheme: 'hydra-umc', host: 'pair', maxPayloadChars: 600, nameMax: 64, portMin: 1, portMax: 65535 } as const;

export type PairingProblem = 'host' | 'port' | 'fingerprint' | 'name' | 'too_long';

export interface PairingInput {
  host: string;
  port: number;
  /** The SHA-256 of the TLS certificate in any of the usual spellings, or null/empty for a server without TLS. */
  fingerprint: string | null;
  name: string;
}

export type PairingResult = { ok: true; link: string } | { ok: false; problem: PairingProblem };

const HOST_NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9A-Fa-f:]{2,45}$/;

/** The canonical fingerprint (64 lowercase hex digits), or null when the text is not a SHA-256. Colons and spaces between the pairs are dropped. */
export function normalizeFingerprint(text: string): string | null {
  const hex = text.replace(/[:\s-]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

function validHost(host: string): boolean {
  const v4 = IPV4.exec(host);
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255);
  if (host.includes(':')) return IPV6.test(host);
  return HOST_NAME.test(host);
}

export function buildPairingLink(input: PairingInput): PairingResult {
  const host = input.host.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!host || !validHost(host)) return { ok: false, problem: 'host' };
  if (!Number.isInteger(input.port) || input.port < PAIRING.portMin || input.port > PAIRING.portMax) return { ok: false, problem: 'port' };
  const rawFingerprint = (input.fingerprint ?? '').trim();
  const fingerprint = rawFingerprint === '' ? null : normalizeFingerprint(rawFingerprint);
  if (rawFingerprint !== '' && fingerprint === null) return { ok: false, problem: 'fingerprint' };
  const name = input.name.trim();
  // eslint-disable-next-line no-control-regex
  if (name.length > PAIRING.nameMax || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return { ok: false, problem: 'name' };
  const query = [`host=${encodeURIComponent(host)}`, `port=${input.port}`];
  if (fingerprint) query.push(`fp=${fingerprint}`);
  if (name) query.push(`name=${encodeURIComponent(name)}`);
  const link = `${PAIRING.scheme}://${PAIRING.host}?${query.join('&')}`;
  return link.length > PAIRING.maxPayloadChars ? { ok: false, problem: 'too_long' } : { ok: true, link };
}

/** The fingerprint of the certificate the server serves, from the answer of GET /api/admin/server-config (null without TLS). */
export function readTlsFingerprint(snapshot: unknown): string | null {
  const tls = (snapshot as { tls?: { enabled?: unknown; fingerprint256?: unknown } } | null)?.tls;
  return tls && tls.enabled === true && typeof tls.fingerprint256 === 'string' ? normalizeFingerprint(tls.fingerprint256) : null;
}
