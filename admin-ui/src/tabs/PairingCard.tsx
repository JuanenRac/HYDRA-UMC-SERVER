// =============================================================================
// HYDRA-UMC SERVER - Admin UI pairing code: PairingCard.tsx
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Draws the pairing code of this server (address, port, fingerprint of the TLS certificate, name) for the control apps. The code stays hidden
// until the administrator asks for it; the phone camera opens the link with the app, which shows what it read and asks before it keeps anything.
// =============================================================================
import { useMemo, useState } from 'react';
import { QrCode } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { buildPairingLink } from '../pairingModel';

function defaultPort(): number {
  const typed = Number(window.location.port);
  if (Number.isInteger(typed) && typed > 0) return typed;
  return window.location.protocol === 'https:' ? 443 : 80;
}

export function PairingCard({ fingerprint, t, button, input }: { fingerprint: string | null; t: (key: string) => string; button: string; input: string }) {
  const [shown, setShown] = useState(false);
  const [name, setName] = useState('HYDRA-UMC');
  const result = useMemo(
    () => buildPairingLink({ host: window.location.hostname, port: defaultPort(), fingerprint, name }),
    [fingerprint, name],
  );

  const cells = useMemo(() => {
    if (!shown || !result.ok) return null;
    const qr = qrcode(0, 'M');
    qr.addData(result.link);
    qr.make();
    const size = qr.getModuleCount();
    const dark: string[] = [];
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (qr.isDark(row, col)) dark.push(`M${col + 4} ${row + 4}h1v1h-1z`);
    return { size: size + 8, path: dark.join('') };
  }, [shown, result]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-3" data-testid="security-pairing">
      <h3 className="text-xs font-bold text-slate-200">{t('pair_title')}</h3>
      <p className="text-[10px] text-slate-500">{t('pair_help')}</p>
      {!fingerprint && <p className="text-[10px] text-amber-400">{t('pair_no_tls')}</p>}
      <label className="text-xs font-bold text-slate-200" htmlFor="pair-name">{t('pair_name_label')}</label>
      <input id="pair-name" data-testid="pair-name" type="text" maxLength={64} value={name} onChange={e => setName(e.target.value)} className={`${input} w-64`} />
      <button onClick={() => setShown(!shown)} className={button} data-testid="pair-toggle"><QrCode size={14} /> {shown ? t('pair_hide') : t('pair_show')}</button>
      {shown && !result.ok && <p role="alert" className="text-xs text-rose-400">{t(`pair_problem_${result.problem}`)}</p>}
      {shown && result.ok && cells && (
        <div className="flex flex-col gap-2">
          <svg role="img" aria-label={t('pair_title')} viewBox={`0 0 ${cells.size} ${cells.size}`} width={224} height={224} shapeRendering="crispEdges" className="bg-white rounded">
            <path d={cells.path} fill="#000" />
          </svg>
          <code className="text-[10px] text-slate-400 break-all" data-testid="pair-link">{result.link}</code>
          <p className="text-[10px] text-slate-500">{t('pair_scan_hint')}</p>
        </div>
      )}
    </div>
  );
}
