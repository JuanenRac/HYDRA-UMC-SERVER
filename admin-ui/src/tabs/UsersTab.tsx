// =============================================================================
// HYDRA-UMC SERVER - Admin UI Users tab: UsersTab.tsx
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Thin UI over the account-management routes server.ts already exposed
// (GET/POST/PUT/DELETE /api/users, requireAdmin - see that file's own
// comment on those routes) before this admin UI existed - nothing new on
// the backend for this tab, just the first real UI for it.
// =============================================================================
import { useEffect, useState } from 'react';
import { Plus, Trash2, UserCog, Users as UsersIcon } from 'lucide-react';
import { apiFetch } from '../api';

interface UserEntry {
  username: string;
  role: 'admin' | 'operator';
}

export function UsersTab({ onAuthError, currentUsername }: { onAuthError: (err: unknown) => void; currentUsername?: string }) {
  const [users, setUsers] = useState<UserEntry[] | null>(null);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'operator'>('operator');
  const [editing, setEditing] = useState<string | null>(null);
  const [editPassword, setEditPassword] = useState('');
  const [editRole, setEditRole] = useState<'admin' | 'operator'>('operator');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await apiFetch<{ users: UserEntry[] }>('/api/users');
      setUsers(res.users);
    } catch (err) {
      onAuthError(err);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername || !newPassword) return;
    setBusy(true);
    try {
      await apiFetch('/api/users', { method: 'POST', body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }) });
      setNewUsername('');
      setNewPassword('');
      setNewRole('operator');
      await load();
    } catch (err) {
      onAuthError(err);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (u: UserEntry) => {
    setEditing(u.username);
    setEditPassword('');
    setEditRole(u.role);
  };

  const saveEdit = async (username: string) => {
    setBusy(true);
    try {
      const body: any = { role: editRole };
      if (editPassword) body.password = editPassword;
      await apiFetch(`/api/users/${encodeURIComponent(username)}`, { method: 'PUT', body: JSON.stringify(body) });
      setEditing(null);
      await load();
    } catch (err) {
      onAuthError(err);
    } finally {
      setBusy(false);
    }
  };

  const removeUser = async (username: string) => {
    if (!confirm(`Delete account "${username}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      await apiFetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      onAuthError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <h2 className="text-sm font-bold uppercase tracking-widest text-slate-300 flex items-center gap-2">
        <UsersIcon size={16} className="text-sky-400" /> User Accounts
      </h2>

      {users === null ? (
        <p className="text-xs text-slate-500">Loading...</p>
      ) : (
        <div className="flex flex-col gap-2">
          {users.map(u => (
            <div key={u.username} className="bg-slate-900 border border-slate-800 rounded-lg px-4 py-3">
              {editing === u.username ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-200">{u.username}</span>
                    <select
                      value={editRole}
                      onChange={e => setEditRole(e.target.value as 'admin' | 'operator')}
                      className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 outline-none"
                    >
                      <option value="operator">operator</option>
                      <option value="admin">admin</option>
                    </select>
                  </div>
                  <input
                    type="password"
                    placeholder="New password (leave blank to keep current)"
                    value={editPassword}
                    onChange={e => setEditPassword(e.target.value)}
                    className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-500"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => saveEdit(u.username)}
                      disabled={busy}
                      className="flex-1 bg-sky-500/20 hover:bg-sky-500/30 text-sky-400 border border-sky-500/30 rounded-lg text-xs font-bold uppercase tracking-wider py-1.5 transition-colors disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg text-xs font-bold uppercase tracking-wider py-1.5 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm font-bold text-slate-200">
                      {u.username} {u.username === currentUsername && <span className="text-[10px] text-slate-600">(you)</span>}
                    </span>
                    <span className={`text-[10px] font-bold uppercase ${u.role === 'admin' ? 'text-sky-400' : 'text-amber-400'}`}>{u.role}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button onClick={() => startEdit(u)} className="text-slate-500 hover:text-sky-400 transition-colors" title="Edit">
                      <UserCog size={16} />
                    </button>
                    <button
                      onClick={() => removeUser(u.username)}
                      disabled={u.username === currentUsername}
                      className="text-slate-500 hover:text-rose-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      title={u.username === currentUsername ? "Can't delete your own account" : 'Delete'}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <form onSubmit={createUser} className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <Plus size={14} /> New account
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <input
            placeholder="Username"
            value={newUsername}
            onChange={e => setNewUsername(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
          />
          <select
            value={newRole}
            onChange={e => setNewRole(e.target.value as 'admin' | 'operator')}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none"
          >
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <input
          type="password"
          placeholder="Password"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
        />
        <button
          type="submit"
          disabled={busy || !newUsername || !newPassword}
          className="bg-sky-500 hover:bg-sky-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-bold uppercase tracking-widest text-xs rounded-lg py-2 transition-colors"
        >
          Create account
        </button>
      </form>
    </div>
  );
}
