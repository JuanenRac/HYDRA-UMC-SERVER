// =============================================================================
// HYDRA-UMC SERVER - Admin UI backend API helper: api.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Every call in App.tsx goes through apiFetch() below instead of raw
// fetch() - same reasoning as HYDRA-UMC-STUDIO's own src/lib/apiBase.ts:
// relative paths in dev (proxied by vite.config.ts to localhost:3000),
// same-origin in production (this admin UI is only ever served BY the
// server it manages, from its own public/admin/ - see build-frontend.sh's
// own header comment), so this stays a relative-path fetch either way.
// The one thing this file owns beyond that: attaching the bearer token
// from localStorage to every call, and surfacing a 401 as a thrown
// ApiError the caller can catch to force back to the login screen.
// =============================================================================

const TOKEN_KEY = 'hydra_admin_token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private browsing / storage disabled - login still works, it just
    // won't survive a page reload. Better than throwing on every call.
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // See getToken() above - same silent no-op reasoning.
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    setToken(null);
    throw new ApiError(401, 'Session expired - please log in again.');
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON error body - keep the generic message above.
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
