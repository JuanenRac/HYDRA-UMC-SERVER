// =============================================================================
// HYDRA-UMC SERVER - Admin UI Logs tab: LogsTab.tsx
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Polling "real-time" log window (GET /api/admin/logs?lines=N) - not a
// WebSocket tail. Deliberately simpler: this is a low-traffic admin
// screen, and a 3s poll of the last N lines already reads as "live" for a
// human watching it, without adding a second WS protocol on top of the
// robot-control one just for this.
// =============================================================================
import { useEffect, useRef, useState } from 'react';
import { FileText, Pause, Play } from 'lucide-react';
import { apiFetch } from '../api';

const POLL_MS = 3000;
const LINES = 300;

export function LogsTab({ onAuthError }: { onAuthError: (err: unknown) => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [live, setLive] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  const load = async () => {
    try {
      const res = await apiFetch<{ lines: string[] }>(`/api/admin/logs?lines=${LINES}`);
      setLines(res.lines);
    } catch (err) {
      onAuthError(err);
    }
  };

  useEffect(() => {
    load();
    if (!live) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // Auto-scroll to the newest line, but only if the viewer was already at
  // (or near) the bottom before this update - scrolling out from under
  // someone who scrolled up to read an older line would make the log
  // viewer actively hostile to use.
  useEffect(() => {
    const el = boxRef.current;
    if (el && wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const handleScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="flex flex-col gap-4 h-full max-w-5xl">
      <div className="flex items-center justify-between shrink-0">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-300 flex items-center gap-2">
          <FileText size={16} className="text-sky-400" /> Server Log
        </h2>
        <button
          onClick={() => setLive(l => !l)}
          className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-colors"
        >
          {live ? <><Pause size={12} /> Pause</> : <><Play size={12} /> Resume</>}
        </button>
      </div>

      <div
        ref={boxRef}
        onScroll={handleScroll}
        className="flex-1 min-h-[400px] max-h-[70vh] overflow-y-auto bg-black/60 border border-slate-800 rounded-lg p-3 font-mono text-[11px] text-slate-400 leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-slate-600">No log entries yet.</p>
        ) : (
          lines.map((line, i) => <div key={i} className="whitespace-pre-wrap break-all">{line}</div>)
        )}
      </div>

      <p className="text-[10px] text-slate-600 shrink-0">
        Last {LINES} lines of this server's own log file{live ? `, refreshing every ${POLL_MS / 1000}s` : ' (paused)'}.
      </p>
    </div>
  );
}
