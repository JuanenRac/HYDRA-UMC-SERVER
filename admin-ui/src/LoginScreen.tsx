// =============================================================================
// HYDRA-UMC SERVER - Admin UI login screen: LoginScreen.tsx
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
import { useState } from 'react';
import { Server, ShieldAlert } from 'lucide-react';
import { apiFetch, ApiError } from './api';

export function LoginScreen({ onLogin, onError }: { onLogin: (token: string) => void; onError: (msg: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true);
    setLocalError(null);
    try {
      const res = await apiFetch<{ success: boolean; token: string; role: string }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onLogin(res.token);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Login failed - is the server reachable?';
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-6 flex flex-col gap-4">
        <div className="flex flex-col items-center gap-2 mb-2">
          <Server className="text-sky-400" size={36} />
          <h1 className="text-lg font-black uppercase tracking-widest text-center">
            HYDRA<span className="text-emerald-500">-UM</span><span className="text-rose-500">C</span>{' '}
            <span className="text-sky-400 font-medium">Server Admin</span>
          </h1>
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">Server administration - not robot control</p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Username</label>
          <input
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoFocus
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
          />
        </div>

        {localError && (
          <div className="flex items-center gap-2 text-rose-400 text-xs bg-rose-950/40 border border-rose-900 rounded-lg px-3 py-2">
            <ShieldAlert size={14} /> {localError}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="bg-sky-500 hover:bg-sky-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-bold uppercase tracking-widest text-sm rounded-lg py-2.5 transition-colors"
        >
          {busy ? 'Signing in...' : 'Sign in'}
        </button>

        <p className="text-[10px] text-slate-600 text-center">Default seed account: admin / admin - change it from Users after your first sign-in.</p>
      </form>
    </div>
  );
}
