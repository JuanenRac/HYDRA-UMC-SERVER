// =============================================================================
// HYDRA-UMC-SERVER - src/recordingLimits.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The limits of a camera recording and the pieces the recording loop needs to keep them: the decision to stop (time, size of the file, size of all the
// recordings together), a counter of the frames that reads them while they are written (so that stopping does not read the whole file into memory),
// and the size of a folder. The values are settings of Server Admin (camera.recordingMaxSeconds, recordingMaxBytes, recordingQuotaBytes) behind the
// switch camera.limitRecordings.
import fs from "fs";
import path from "path";

export interface RecordingLimits {
  /** Whether the limits are kept (camera.limitRecordings; default yes). */
  enabled: boolean;
  /** Longest recording, in seconds (default 10 minutes). */
  maxSeconds: number;
  /** Largest file of one recording, in bytes (default 500 MB). */
  maxBytes: number;
  /** Largest size of all the recordings of all the cameras together, in bytes (default 5 GB). */
  quotaBytes: number;
}

export const DEFAULT_RECORDING_LIMITS: RecordingLimits = { enabled: true, maxSeconds: 600, maxBytes: 500_000_000, quotaBytes: 5_000_000_000 };

export type StopReason = "" | "duration" | "size" | "quota";

/** Why a recording must stop now ("" when it may go on). `others` is the size of the recordings that are already on disk, this one not counted. */
export function recordingStopReason(limits: RecordingLimits, elapsedMs: number, fileBytes: number, others: number): StopReason {
  if (!limits.enabled) return "";
  if (elapsedMs >= limits.maxSeconds * 1000) return "duration";
  if (fileBytes >= limits.maxBytes) return "size";
  if (others + fileBytes >= limits.quotaBytes) return "quota";
  return "";
}

/** Counts the frames of a multipart MJPEG stream as the bytes arrive: the same Content-Length reading as the count of a finished file, without keeping the file. */
export class MjpegFrameCounter {
  frames = 0;
  /** True when a part had no Content-Length: the count cannot be trusted and the caller reads the file once, as it did before. */
  broken = false;
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    if (this.broken) return;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let offset = 0;
    while (offset < this.pending.length) {
      const headerEnd = this.pending.indexOf("\r\n\r\n", offset);
      if (headerEnd === -1) break;
      const match = this.pending.subarray(offset, headerEnd).toString("ascii").match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.broken = true;
        this.pending = Buffer.alloc(0);
        return;
      }
      const payloadStart = headerEnd + 4;
      const end = payloadStart + Number(match[1]);
      if (this.pending.length < end) break;
      this.frames++;
      offset = end;
    }
    this.pending = offset > 0 ? this.pending.subarray(offset) : this.pending;
  }
}

/** The total size in bytes of the files below a folder (0 when it does not exist). */
export function directorySize(folder: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* a file that vanished is not counted */
      }
    }
  }
  return total;
}
