// =============================================================================
// HYDRA-UMC-SERVER - src/watchReleaseNotice.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// What each phone said about telling its watch of a newer release of the app. Information only: it is shown to an administrator and changes nothing anywhere.
// Kept in data/ with a limit on the number of phones; a damaged file is treated as empty.
import fs from "node:fs";
import path from "node:path";

export const MAX_NOTICE_DEVICES = 64;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export interface WatchNoticeEntry {
  device_id: string;
  platform: "android" | "ios";
  username: string;
  notifies_watch: boolean;
  updated_at: string;
}

/** The entry of a request body, or the reason it is refused. */
export function parseWatchNotice(body: unknown): { ok: true; value: Pick<WatchNoticeEntry, "device_id" | "platform" | "notifies_watch"> } | { ok: false; error: string } {
  const { device_id: deviceId, platform, notifies_watch: notifies } = (body ?? {}) as Record<string, unknown>;
  if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) return { ok: false, error: "device_id must be 1 to 64 letters, digits and . _ : -" };
  if (platform !== "android" && platform !== "ios") return { ok: false, error: "platform must be android or ios" };
  if (typeof notifies !== "boolean") return { ok: false, error: "notifies_watch must be true or false" };
  return { ok: true, value: { device_id: deviceId, platform, notifies_watch: notifies } };
}

export class WatchReleaseNotices {
  private entries: WatchNoticeEntry[] = [];

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(stored)) {
        this.entries = stored.filter((e): e is WatchNoticeEntry => parseWatchNotice(e).ok && typeof e.username === "string" && typeof e.updated_at === "string").slice(0, MAX_NOTICE_DEVICES);
      }
    } catch {
      this.entries = [];
    }
  }

  list(): WatchNoticeEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Newest first, one entry per account and phone; the oldest is dropped when there are too many. */
  record(username: string, value: Pick<WatchNoticeEntry, "device_id" | "platform" | "notifies_watch">): void {
    const entry: WatchNoticeEntry = { ...value, username, updated_at: new Date(this.now()).toISOString() };
    this.entries = [entry, ...this.entries.filter((e) => !(e.username === username && e.device_id === value.device_id))].slice(0, MAX_NOTICE_DEVICES);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}
