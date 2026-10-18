/**
 * Short-lived tickets for the camera pictures: an `<img>` or a video element cannot send an `Authorization` header, so the live stream and the saved photos and recordings used to be
 * open to everybody on the LAN. A signed-in client now asks for a ticket (POST /api/camera/ticket) and puts it in the picture's address (`?ticket=...`): the ticket says who asked
 * and until when (five minutes), it is signed with a key derived from the server's own secret, and it opens nothing else.
 * The pictures demand it by default; an installation opts out with HYDRA_UMC_CAMERA_AUTH=open so that a client that does not ask for tickets yet keeps working until it does.
 * Copyright (C) 2026 JuanenRac (Electro Hobby 3D). GPL-3.0-or-later.
 */
import crypto from "node:crypto";

export const MEDIA_TICKET_SECONDS = 300;

function signature(key: Buffer, username: string, expiresAt: number): string {
  return crypto.createHmac("sha256", key).update(`hydra-media-ticket-v1|${username}|${expiresAt}`).digest("base64url");
}

/** The key the tickets are signed with: derived from the server's own secret, so that it is never the secret itself. */
export function mediaTicketKey(serverSecret: string): Buffer {
  return crypto.createHmac("sha256", serverSecret).update("hydra-media-ticket-key-v1").digest();
}

export function issueMediaTicket(key: Buffer, username: string, nowMs: number): { ticket: string; expiresInSeconds: number } {
  const expiresAt = Math.floor(nowMs / 1000) + MEDIA_TICKET_SECONDS;
  const encodedUser = Buffer.from(username, "utf8").toString("base64url");
  return { ticket: `${encodedUser}.${expiresAt}.${signature(key, username, expiresAt)}`, expiresInSeconds: MEDIA_TICKET_SECONDS };
}

/** The user name a valid, unexpired ticket was issued to, or null. */
export function verifyMediaTicket(key: Buffer, ticket: unknown, nowMs: number): string | null {
  if (typeof ticket !== "string" || ticket.length > 512) return null;
  const parts = ticket.split(".");
  if (parts.length !== 3) return null;
  const [encodedUser, expiry, given] = parts;
  const expiresAt = Number(expiry);
  if (!Number.isInteger(expiresAt) || expiresAt * 1000 < nowMs) return null;
  let username: string;
  try { username = Buffer.from(encodedUser, "base64url").toString("utf8"); } catch { return null; }
  if (!username) return null;
  const expected = Buffer.from(signature(key, username, expiresAt));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return username;
}

/** Do the pictures of the cameras demand a signed-in client? Off unless the installation asks for it (see the file header). */
export function cameraAuthRequired(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "required";
}

/** Do the pictures of the cameras demand a ticket or a signed-in client? Yes, unless the installation opts out with `open` (also `off`, `false`, `0`, `no`, `allow`). */
export function cameraAuthRequiredByDefault(value: string | undefined): boolean {
  return !["open", "off", "false", "0", "no", "allow"].includes((value ?? "").trim().toLowerCase());
}
