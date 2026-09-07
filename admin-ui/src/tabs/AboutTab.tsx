// =============================================================================
// HYDRA-UMC SERVER - Admin UI About tab: AboutTab.tsx
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Same pattern as HYDRA-UMC-STUDIO's own About.tsx: fetches the server's
// own real version from GET /api/hydra-info (no auth needed - that route
// has always been public, it's the same one STUDIO/every mobile app's own
// discovery probe already calls) rather than hardcoding a number that
// would drift from the actual running build.
// =============================================================================
import { useEffect, useState } from 'react';
import { Info, Mail } from 'lucide-react';

const AUTHOR_NAME = 'JuanenRac (Electro Hobby 3D)';
const AUTHOR_EMAIL = 'electrohobby3d@gmail.com';
const LICENSE_NAME = 'GNU General Public License v3.0 (GPL-3.0)';

export function AboutTab() {
  const [version, setVersion] = useState<string | null>(null);
  const [hostname, setHostname] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/hydra-info')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (cancelled || !data) return;
        if (data.appVersion) setVersion(String(data.appVersion));
        if (data.hostname) setHostname(String(data.hostname));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex flex-col gap-4 max-w-md">
      <h2 className="text-sm font-bold uppercase tracking-widest text-slate-300 flex items-center gap-2">
        <Info size={16} className="text-sky-400" /> About
      </h2>
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-2">
        <InfoRow label="Server version" value={version ?? '...'} />
        <InfoRow label="Hostname" value={hostname ?? '...'} />
        <InfoRow label="Author" value={AUTHOR_NAME} />
        <InfoRow label="Email" value={<a href={`mailto:${AUTHOR_EMAIL}`} className="text-sky-400 hover:text-sky-300 inline-flex items-center gap-1"><Mail size={12} />{AUTHOR_EMAIL}</a>} />
        <InfoRow label="License" value={LICENSE_NAME} />
      </div>
      <p className="text-[10px] text-slate-600">
        This admin panel manages HYDRA-UMC SERVER itself (devices, logs, config, users) - robot control lives in HYDRA-UMC STUDIO, served separately from this same server at "/".
      </p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg">
      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{label}</span>
      <span className="text-xs text-slate-200 font-mono">{value}</span>
    </div>
  );
}
