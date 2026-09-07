// =============================================================================
// HYDRA-UMC SERVER - Admin UI Devices tab: DevicesTab.tsx
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Lists every currently-open WebSocket connection to this server (GET
// /api/admin/clients - see server.ts's own header comment on that route
// for exactly what this is and isn't). Polled rather than pushed over its
// own WebSocket - this is a low-traffic admin screen, not the robot
// control path, so a periodic REST poll is simpler and sufficient.
// =============================================================================
import { useEffect, useState } from 'react';
import { Radio, RefreshCw } from 'lucide-react';
import { apiFetch } from '../api';

interface ClientInfo {
  username: string | null;
  role: string | null;
  remoteAddress: string | null;
  connectedAt: string | null;
  remoteApiVersion: number | null;
  connected: boolean;
}

const POLL_MS = 5000;

export function DevicesTab({ onAuthError }: { onAuthError: (err: unknown) => void }) {
  const [clients, setClients] = useState<ClientInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ clients: ClientInfo[] }>('/api/admin/clients');
      setClients(res.clients);
    } catch (err) {
      onAuthError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-300 flex items-center gap-2">
          <Radio size={16} className="text-emerald-400" /> Connected Devices
        </h2>
        <button onClick={load} className="text-slate-500 hover:text-slate-300 transition-colors" title="Refresh now">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {clients === null ? (
        <p className="text-xs text-slate-500">Loading...</p>
      ) : clients.length === 0 ? (
        <p className="text-xs text-slate-500">No devices connected right now.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {clients.map((c, i) => (
            <div key={i} className="bg-slate-900 border border-slate-800 rounded-lg px-4 py-3 flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-bold text-slate-200">{c.username || 'unknown'}</span>
                <span className="text-[10px] text-slate-500 font-mono">{c.remoteAddress || 'unknown address'}</span>
              </div>
              <div className="flex items-center gap-4 text-[10px] text-slate-500">
                <span className={c.role === 'admin' ? 'text-sky-400 font-bold uppercase' : 'text-amber-400 font-bold uppercase'}>{c.role || '?'}</span>
                <span>Schema v{c.remoteApiVersion ?? '?'}</span>
                <span>{c.connectedAt ? new Date(c.connectedAt).toLocaleTimeString() : ''}</span>
                <span className={`w-2 h-2 rounded-full ${c.connected ? 'bg-emerald-500' : 'bg-rose-500'}`} title={c.connected ? 'Open' : 'Closing'} />
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-slate-600">
        This is every live WebSocket connection to this server (STUDIO tabs, mobile apps, HYDRA-UMC SUITE, ...) - not the robot roster itself.
        Refreshes every {POLL_MS / 1000}s.
      </p>
    </div>
  );
}
