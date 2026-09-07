// =============================================================================
// HYDRA-UMC SERVER - Admin UI Config tab: ConfigTab.tsx
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Server name reuses the SAME GET/POST /api/settings STUDIO's own
// Config.tsx already writes through (serverName lives inside that same
// tree) - round-tripped with a shallow spread so every OTHER field in the
// settings tree (controllers, robots, everything) survives untouched, not
// reconstructed from scratch here. Port is this admin UI's own thing (GET/
// PUT /api/admin/server-config, see server.ts's own resolvePort() comment
// for why it needs a restart to take effect).
// =============================================================================
import { useEffect, useState } from 'react';
import { AlertTriangle, Power, Save, Settings } from 'lucide-react';
import { apiFetch } from '../api';

export function ConfigTab({ onAuthError, isAdmin }: { onAuthError: (err: unknown) => void; isAdmin: boolean }) {
  const [settingsPayload, setSettingsPayload] = useState<any>(null);
  const [serverName, setServerName] = useState('');
  const [currentPort, setCurrentPort] = useState<number | null>(null);
  const [pendingPort, setPendingPort] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const load = async () => {
    try {
      const [settings, cfg] = await Promise.all([
        apiFetch<any>('/api/settings'),
        apiFetch<{ port: number; pendingPort: number | null }>('/api/admin/server-config'),
      ]);
      setSettingsPayload(settings);
      setServerName((settings?.settings ?? settings)?.serverName || '');
      setCurrentPort(cfg.port);
      setPendingPort(String(cfg.pendingPort ?? cfg.port));
    } catch (err) {
      onAuthError(err);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveServerName = async () => {
    if (!settingsPayload) return;
    setSaving(true);
    try {
      // Same shape STUDIO's own Config.tsx round-trips - if the fetched
      // payload nests everything under .settings, write serverName there;
      // otherwise it's flat. Either way, every OTHER field is spread back
      // exactly as received, never dropped.
      const isNested = settingsPayload && typeof settingsPayload.settings === 'object';
      const nextPayload = isNested
        ? { ...settingsPayload, settings: { ...settingsPayload.settings, serverName } }
        : { ...settingsPayload, serverName };
      await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(nextPayload) });
      setSettingsPayload(nextPayload);
      setSavedMsg('Server name saved.');
    } catch (err) {
      onAuthError(err);
    } finally {
      setSaving(false);
    }
  };

  const savePort = async () => {
    const portNum = parseInt(pendingPort, 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return;
    setSaving(true);
    try {
      await apiFetch('/api/admin/server-config', { method: 'PUT', body: JSON.stringify({ port: portNum }) });
      setSavedMsg('Port saved - restart this server for it to take effect.');
    } catch (err) {
      onAuthError(err);
    } finally {
      setSaving(false);
    }
  };

  const restartNow = async () => {
    if (!confirm('Restart this server now? Every connected device will briefly disconnect and reconnect. Only actually restarts if this process runs under a supervisor (systemd/pm2/Docker) configured to auto-restart on exit.')) return;
    try {
      await apiFetch('/api/admin/restart', { method: 'POST' });
      setSavedMsg('Restart requested.');
    } catch (err) {
      onAuthError(err);
    }
  };

  useEffect(() => {
    if (!savedMsg) return;
    const t = setTimeout(() => setSavedMsg(null), 4000);
    return () => clearTimeout(t);
  }, [savedMsg]);

  if (!isAdmin) {
    return <p className="text-xs text-slate-500">Only admin accounts can view server configuration.</p>;
  }

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <h2 className="text-sm font-bold uppercase tracking-widest text-slate-300 flex items-center gap-2">
        <Settings size={16} className="text-sky-400" /> Server Configuration
      </h2>

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Server name</label>
        <div className="flex gap-2">
          <input
            value={serverName}
            onChange={e => setServerName(e.target.value)}
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
          />
          <button
            onClick={saveServerName}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 bg-sky-500/20 hover:bg-sky-500/30 text-sky-400 border border-sky-500/30 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            <Save size={14} /> Save
          </button>
        </div>
        <p className="text-[10px] text-slate-600">Shown to every client (mDNS advertisement, GET /api/hydra-info, this admin UI's own header). Takes effect immediately - no restart needed.</p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Listen port (currently {currentPort ?? '...'})</label>
        <div className="flex gap-2">
          <input
            type="number"
            min={1}
            max={65535}
            value={pendingPort}
            onChange={e => setPendingPort(e.target.value)}
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
          />
          <button
            onClick={savePort}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 bg-sky-500/20 hover:bg-sky-500/30 text-sky-400 border border-sky-500/30 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-50"
          >
            <Save size={14} /> Save
          </button>
        </div>
        <div className="flex items-start gap-2 text-[10px] text-amber-400/90 bg-amber-950/20 border border-amber-900/40 rounded-lg p-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>Saving does NOT change the running server - this process cannot rebind its own listening socket without dropping every open connection. It takes effect on the next restart (a deployment-level `PORT` environment variable, if set, always overrides this).</span>
        </div>
        <button
          onClick={restartNow}
          className="self-start flex items-center gap-1.5 px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors"
        >
          <Power size={14} /> Restart server now
        </button>
      </div>

      {savedMsg && <p className="text-xs text-emerald-400">{savedMsg}</p>}
    </div>
  );
}
