// =============================================================================
// HYDRA-UMC-SERVER - src/cameraPidFile.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The file of camera process numbers that lets a new server instance stop the stream processes an earlier one left running. A process number alone is not an
// identity: after a power cut the numbers of the earlier boot belong to other processes, and a number that is alive again may be anything. On Linux the file
// therefore keeps the boot identifier and the start time of every process (field 22 of /proc/<pid>/stat), and a process is stopped only when both still match.
// Where /proc does not exist (the development machines on Windows) the file keeps the numbers only, as it always did.
import fs from "fs";
import path from "path";

export interface CameraPidEntry {
  pid: number;
  start: string | null;
}

export interface CameraPidFile {
  bootId: string | null;
  entries: CameraPidEntry[];
}

export function currentBootId(procRoot = "/proc"): string | null {
  try {
    const text = fs.readFileSync(path.join(procRoot, "sys", "kernel", "random", "boot_id"), "utf-8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// The start time of a process in clock ticks after the boot, or null when it cannot be read (the process is gone, or there is no /proc).
export function processStartTicks(pid: number, procRoot = "/proc"): string | null {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf-8");
    // the command name (field 2) is in brackets and may hold spaces and brackets of its own: the fields after the LAST closing bracket are the safe ones
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = rest[19]; // field 22 of the line, counting from field 3 at index 0
    return start && /^[0-9]+$/.test(start) ? start : null;
  } catch {
    return null;
  }
}

export function serializeCameraPidFile(pids: number[], procRoot = "/proc"): string {
  const file: CameraPidFile = {
    bootId: currentBootId(procRoot),
    entries: pids.map((pid) => ({ pid, start: processStartTicks(pid, procRoot) })),
  };
  return JSON.stringify(file);
}

// The numbers of the file that may be stopped now. `alive` tells whether a number is running; on Linux a number counts only when the boot and the start time
// that were written are the ones of today, so a file from before a reboot (or the old format, which holds numbers only) stops nothing.
export function pidsToReap(raw: unknown, alive: (pid: number) => boolean, procRoot = "/proc"): number[] {
  const bootNow = currentBootId(procRoot);
  const entries: CameraPidEntry[] = [];
  let bootThen: string | null = null;
  if (Array.isArray(raw)) {
    for (const pid of raw) if (typeof pid === "number" && Number.isInteger(pid) && pid > 1) entries.push({ pid, start: null });
  } else if (raw && typeof raw === "object") {
    const file = raw as Partial<CameraPidFile>;
    bootThen = typeof file.bootId === "string" ? file.bootId : null;
    if (Array.isArray(file.entries)) {
      for (const entry of file.entries) {
        if (entry && typeof entry.pid === "number" && Number.isInteger(entry.pid) && entry.pid > 1) {
          entries.push({ pid: entry.pid, start: typeof entry.start === "string" ? entry.start : null });
        }
      }
    }
  }
  const result: number[] = [];
  for (const entry of entries) {
    if (bootNow !== null) {
      if (bootThen !== bootNow || entry.start === null) continue; // cannot be proved to be ours
      if (processStartTicks(entry.pid, procRoot) !== entry.start) continue;
    }
    if (alive(entry.pid)) result.push(entry.pid);
  }
  return result;
}
