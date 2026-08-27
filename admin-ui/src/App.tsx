// =============================================================================
// HYDRA-UMC SERVER - Admin UI root component: App.tsx
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Server/fleet administration - devices connected to this server, its own
// log file, its own port/name, and its own user accounts. Deliberately NOT
// robot control (that stays HYDRA-UMC STUDIO-only) - see src/server.ts's
// own header comment for why this exists at all as an exception to this
// server's normally-headless design.
//
// Kept intentionally simple (one file, a handful of inline components, no
// router - just a tab index in local state) for what is a small, low-
// traffic internal tool, not a redesign target: same reasoning
// HYDRA-UMC-FLASHER/TESTER apply to their own single-window Tkinter UIs.
// English only for now, unlike every other UI in this ecosystem (see this
// project's own CHANGELOG.md for that gap, tracked, not silently dropped).
// =============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Cpu, FileText, Info, LogOut, Server, Settings, Users } from 'lucide-react';
import { apiFetch, ApiError, getToken, setToken } from './api';
import { LoginScreen } from './LoginScreen';
import { DevicesTab } from './tabs/DevicesTab';
import { LogsTab } from './tabs/LogsTab';
import { ConfigTab } from './tabs/ConfigTab';
import { UsersTab } from './tabs/UsersTab';
import { AboutTab } from './tabs/AboutTab';

export type Role = 'admin' | 'operator';
type Tab = 'devices' | 'logs' | 'config' | 'users' | 'about';

/** Decodes the JWT payload without verifying it - display purposes only (username/role for the header), never a trust boundary. Every real authorization decision happens server-side, same as every other client in this ecosystem. */
function decodeTokenPayload(token: string): { username?: string; role?: Role } | null {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export function App() {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [identity, setIdentity] = useState<{ username?: string; role?: Role } | null>(() => {
    const t = getToken();
    return t ? decodeTokenPayload(t) : null;
  });
  const [tab, setTab] = useState<Tab>('devices');
  const [globalError, setGlobalError] = useState<string | null>(null);

  const handleLogin = useCallback((newToken: string) => {
    setToken(newToken);
    setTokenState(newToken);
    setIdentity(decodeTokenPayload(newToken));
  }, []);

  const handleLogout = useCallback(() => {
    setToken(null);
    setTokenState(null);
    setIdentity(null);
  }, []);

  // A 401 anywhere below (ApiError with status 401) means the token
  // expired or was revoked server-side - force back to the login screen
  // instead of leaving every tab stuck silently failing. Each tab reports
  // this up via onAuthError rather than each duplicating this logic.
  const handleAuthError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      handleLogout();
    } else if (err instanceof Error) {
      setGlobalError(err.message);
    }
  }, [handleLogout]);

  useEffect(() => {
    if (!globalError) return;
    const timer = setTimeout(() => setGlobalError(null), 6000);
    return () => clearTimeout(timer);
  }, [globalError]);

  if (!token || !identity) {
    return <LoginScreen onLogin={handleLogin} onError={setGlobalError} />;
  }

  const isAdmin = identity.role === 'admin';

  const tabs: { id: Tab; label: string; icon: typeof Cpu; adminOnly?: boolean }[] = [
    { id: 'devices', label: 'Devices', icon: Cpu },
    { id: 'logs', label: 'Logs', icon: FileText },
    { id: 'config', label: 'Config', icon: Settings },
    { id: 'users', label: 'Users', icon: Users, adminOnly: true },
    { id: 'about', label: 'About', icon: Info },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Server className="text-sky-400" size={22} />
          <span className="font-black uppercase tracking-widest text-sm">
            HYDRA<span className="text-emerald-500">-UM</span><span className="text-rose-500">C</span>{' '}
            <span className="text-sky-400 font-medium">Server Admin</span>
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-slate-400">
            {identity.username} <span className="text-slate-600">|</span>{' '}
            <span className={isAdmin ? 'text-sky-400' : 'text-amber-400'}>{identity.role}</span>
          </span>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 text-slate-400 hover:text-rose-400 transition-colors font-bold uppercase tracking-wider"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </header>

      {globalError && (
        <div className="bg-rose-950/60 border-b border-rose-900 text-rose-300 text-xs px-6 py-2">
          {globalError}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <nav className="w-48 border-r border-slate-800 bg-slate-900/50 p-3 flex flex-col gap-1 shrink-0">
          {tabs.filter(t => !t.adminOnly || isAdmin).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors text-left ${
                tab === id ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'text-slate-400 hover:bg-slate-800 border border-transparent'
              }`}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-y-auto p-6">
          {tab === 'devices' && <DevicesTab onAuthError={handleAuthError} />}
          {tab === 'logs' && <LogsTab onAuthError={handleAuthError} />}
          {tab === 'config' && <ConfigTab onAuthError={handleAuthError} isAdmin={isAdmin} />}
          {tab === 'users' && isAdmin && <UsersTab onAuthError={handleAuthError} currentUsername={identity.username} />}
          {tab === 'about' && <AboutTab />}
        </main>
      </div>
    </div>
  );
}

export { apiFetch };
