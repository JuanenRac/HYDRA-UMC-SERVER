// =============================================================================
// HYDRA-UMC-SERVER - src/jogSequence.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Order of the motion commands of one client. Two requests sent one after the other over HTTP can arrive in the
// other order (a retry, a second connection, a slow proxy), so a jog sent BEFORE a stop could reach the robot AFTER
// it and move it again. A client that numbers its motion commands (`seq`, a growing positive integer) gets that
// protected: a jog, table move or joints command whose number is not above the highest one the server has seen from
// the same account and controller for that robot is refused, and a stop with a number raises that mark so that
// every older motion command is refused from then on. A stop itself is never refused for its number.
//
// The number is optional: a client that sends none is handled exactly as before. Nothing is kept on disk; the
// marks are forgotten after an hour without a command, and at most MAX_ENTRIES are kept (the oldest is dropped).
// =============================================================================

export const MAX_ENTRIES = 1024;
export const IDLE_FORGET_MS = 60 * 60 * 1000;

/** A usable sequence number: an integer from 1 up to 2^53 - 1. Anything else is not one. */
export function parseSequence(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export class JogSequence {
  private marks = new Map<string, { seq: number; at: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  private key(robotId: number, userId: unknown, controllerId: string | undefined): string {
    return `${robotId}|${String(userId)}|${controllerId ?? ""}`;
  }

  private forgetOld(now: number): void {
    for (const [key, mark] of this.marks) {
      if (now - mark.at > IDLE_FORGET_MS) this.marks.delete(key);
    }
    while (this.marks.size >= MAX_ENTRIES) {
      const oldest = this.marks.keys().next().value;
      if (oldest === undefined) break;
      this.marks.delete(oldest);
    }
  }

  /** Records a motion command with this number; false (with the highest number seen) when it is not above the mark, in which case nothing is recorded. */
  accept(robotId: number, userId: unknown, controllerId: string | undefined, seq: number): { ok: true } | { ok: false; last: number } {
    const now = this.clock();
    this.forgetOld(now);
    const key = this.key(robotId, userId, controllerId);
    const mark = this.marks.get(key);
    if (mark && seq <= mark.seq) return { ok: false, last: mark.seq };
    this.marks.delete(key);
    this.marks.set(key, { seq, at: now });
    return { ok: true };
  }

  /** A stop with a number raises the mark (never lowers it); it is never refused. */
  noteStop(robotId: number, userId: unknown, controllerId: string | undefined, seq: number): void {
    const now = this.clock();
    this.forgetOld(now);
    const key = this.key(robotId, userId, controllerId);
    const mark = this.marks.get(key);
    this.marks.delete(key);
    this.marks.set(key, { seq: Math.max(seq, mark?.seq ?? 0), at: now });
  }

  size(): number {
    return this.marks.size;
  }
}
