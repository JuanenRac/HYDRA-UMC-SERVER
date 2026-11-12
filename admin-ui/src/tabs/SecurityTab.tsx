// =============================================================================
// HYDRA-UMC SERVER - Admin UI Security tab: SecurityTab.tsx
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The nine access switches and the options of the job dispatcher, read from and sent to GET/PUT /api/admin/server-config (administrators
// only), the same answer HYDRA-UMC-STUDIO and HYDRA-UMC-SUITE show in their Server Admin screens. A switch fixed by the environment of the
// server is locked; the value that lowers the protection asks for a confirmation first; only what changed is sent. The logic is in
// securityModel.ts and the sentences, in the eight languages, in i18n.ts.
// =============================================================================
import { useEffect, useMemo, useState } from 'react';
import { Lock, Save, ShieldCheck } from 'lucide-react';
import { ApiError, apiFetch } from '../api';
import { PairingCard } from './PairingCard';
import { readTlsFingerprint } from '../pairingModel';
import { detectLanguage, translate, type Language } from '../i18n';
import {
  JWT_ALGORITHMS, PRESENCE_ACTIONS, isLocked, jwtAlgorithmPatch, readJwtAlgorithm, readJwtKeys, type JwtAlgorithm, type JwtAlgorithmState, type JwtKeyRow, jobDispatcherNeedsConfirmation, jobDispatcherPatch, needsConfirmation, parseRobotMapText, presenceActionPatch, readJobDispatcher,
  RATE_LIMIT_FIELDS, rateLimitsPatch, readRateLimits, type RateLimitKey, type RateLimitsState,
  readPresenceAction, readSwitches, robotMapToText, switchPatch, warningKeys, type JobDispatcherState, type PresenceAction, type PresenceActionState, type SwitchState,
} from '../securityModel';

function savedLanguage(): string | null {
  try {
    return localStorage.getItem('hydra_admin_lang');
  } catch {
    return null;
  }
}

export function SecurityTab({ onAuthError, isAdmin }: { onAuthError: (err: unknown) => void; isAdmin: boolean }) {
  const language: Language = useMemo(() => detectLanguage(savedLanguage(), typeof navigator !== 'undefined' ? navigator.language : null), []);
  const t = (key: string) => translate(language, key);

  const [switches, setSwitches] = useState<SwitchState[]>([]);
  const [dispatcher, setDispatcher] = useState<JobDispatcherState | null>(null);
  const [presence, setPresence] = useState<PresenceActionState | null>(null);
  const [jwt, setJwt] = useState<JwtAlgorithmState | null>(null);
  const [jwtKeys, setJwtKeys] = useState<JwtKeyRow[]>([]);
  const [limits, setLimits] = useState<RateLimitsState | null>(null);
  const [limitTexts, setLimitTexts] = useState<Record<RateLimitKey, string> | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [relay, setRelay] = useState(false);
  const [mapText, setMapText] = useState('');
  const [allow, setAllow] = useState(false);
  const [timeoutText, setTimeoutText] = useState('30');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const apply = (snapshot: unknown) => {
    setSwitches(readSwitches(snapshot));
    setFingerprint(readTlsFingerprint(snapshot));
    const jd = readJobDispatcher(snapshot);
    setDispatcher(jd);
    setPresence(readPresenceAction(snapshot));
    const rl = readRateLimits(snapshot);
    setLimits(rl);
    setLimitTexts(rl ? (Object.fromEntries(RATE_LIMIT_FIELDS.map(({ key }) => [key, String(rl[key].value)])) as Record<RateLimitKey, string>) : null);
    const algorithm = readJwtAlgorithm(snapshot);
    setJwt(algorithm);
    if (algorithm?.algorithm === 'EdDSA') void loadKeys();
    else setJwtKeys([]);
    if (jd) {
      setRelay(jd.relayEnabled);
      setMapText(robotMapToText(jd.robotMap));
      setAllow(jd.allowUnconfirmed);
      setTimeoutText(String(jd.timeoutSeconds));
    }
  };

  const loadKeys = async () => {
    try {
      setJwtKeys(readJwtKeys(await apiFetch<unknown>('/api/admin/jwt-keys')));
    } catch {
      setJwtKeys([]);
    }
  };

  const rotate = async () => {
    if (!window.confirm(t('jwt_rotate_confirm'))) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setJwtKeys(readJwtKeys(await apiFetch<unknown>('/api/admin/jwt-keys/rotate', { method: 'POST' })));
      setMessage(t('jwt_rotated'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthError(err);
      else setError(t('jwt_rotate_error'));
    } finally {
      setBusy(false);
    }
  };

  const load = async () => {
    try {
      apply(await apiFetch<unknown>('/api/admin/server-config'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthError(err);
      else setError(t('load_error'));
    }
  };

  useEffect(() => { if (isAdmin) void load(); }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (patch: unknown) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const answer = await apiFetch<{ warnings?: unknown }>('/api/admin/server-config', { method: 'PUT', body: JSON.stringify(patch) });
      apply(answer);
      const warnings = warningKeys(answer.warnings);
      setMessage(warnings.length > 0 ? t(warnings[warnings.length - 1]) : t('saved'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthError(err);
      else setError(err instanceof Error ? err.message : t('load_error'));
      void load();
    } finally {
      setBusy(false);
    }
  };

  const toggle = (state: SwitchState, next: boolean) => {
    if (needsConfirmation(state.def, state.value, next) && state.def.confirm && !window.confirm(t(state.def.confirm))) return;
    void send(switchPatch(state.def, next, true));
  };

  const saveLimits = () => {
    if (!limits || !limitTexts) return;
    const patch = rateLimitsPatch(limits, limitTexts);
    if (!patch) {
      setMessage('');
      setError(t('rl_invalid'));
      return;
    }
    if (Object.keys(patch.rateLimits).length === 0) return;
    void send(patch);
  };

  const saveDispatcher = () => {
    if (!dispatcher) return;
    const patch = jobDispatcherPatch({ relayEnabled: relay, robotMapText: mapText, replanEditable: dispatcher.replanEditable, allowUnconfirmed: allow, timeoutText });
    if (!patch) {
      setMessage('');
      setError(parseRobotMapText(mapText) === null ? t('jd_map_invalid') : t('jd_timeout_invalid'));
      return;
    }
    if (jobDispatcherNeedsConfirmation(dispatcher, patch) && !window.confirm(t('jd_confirm'))) return;
    void send(patch);
  };

  if (!isAdmin) return <p className="text-xs text-slate-500">{t('admin_only')}</p>;

  const input = 'bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500';
  const button = 'self-start flex items-center gap-1.5 px-4 py-2 bg-sky-500/20 hover:bg-sky-500/30 disabled:opacity-40 text-sky-400 border border-sky-500/30 rounded-lg text-xs font-bold uppercase tracking-wider';

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <h2 className="text-sm font-bold uppercase tracking-widest text-slate-300 flex items-center gap-2">
        <ShieldCheck size={16} className="text-sky-400" /> {t('tab')}
      </h2>
      <p className="text-[11px] text-slate-500">{t('intro')}</p>

      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-3" data-testid="security-switches">
        <h3 className="text-xs font-bold text-slate-200">{t('switches_title')}</h3>
        {switches.map(state => (
          <div key={state.def.id} className="flex flex-col gap-0.5">
            <label className="flex items-start gap-2 text-xs font-bold text-slate-200">
              <input type="checkbox" data-testid={`switch-${state.def.id}`} checked={state.value} disabled={busy || isLocked(state.source)} onChange={e => toggle(state, e.target.checked)} className="mt-0.5" />
              <span>{t(state.def.label)}</span>
              {isLocked(state.source) && <Lock size={12} className="text-amber-400 mt-0.5" />}
            </label>
            <span className="text-[10px] text-slate-500 pl-6">{t(`source_${state.source}`)}</span>
          </div>
        ))}
      </div>

      {limits && limitTexts && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-3" data-testid="security-rate-limits">
          <h3 className="text-xs font-bold text-slate-200">{t('rl_title')}</h3>
          <p className="text-[10px] text-slate-500">{t('rl_help')}</p>
          {RATE_LIMIT_FIELDS.map(({ key, label }) => (
            <div key={key} className="flex flex-col gap-0.5">
              <label className="text-xs font-bold text-slate-200 flex items-center gap-2" htmlFor={`rl-${key}`}>
                {t(label)}
                {isLocked(limits[key].source) && <Lock size={12} className="text-amber-400" />}
              </label>
              <input id={`rl-${key}`} data-testid={`rl-${key}`} type="text" inputMode="numeric" value={limitTexts[key]} disabled={busy || isLocked(limits[key].source)} onChange={e => setLimitTexts({ ...limitTexts, [key]: e.target.value })} className={`${input} w-32`} />
              <span className="text-[10px] text-slate-500">{limits[key].min} - {limits[key].max} · {t(`source_${limits[key].source}`)}</span>
            </div>
          ))}
          <button onClick={saveLimits} disabled={busy} className={button} data-testid="rl-save"><Save size={14} /> {t('rl_save')}</button>
        </div>
      )}

      {presence && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-2" data-testid="security-presence">
          <label className="text-xs font-bold text-slate-200 flex items-center gap-2" htmlFor="presence-action">
            {t('presence_action_title')}
            {isLocked(presence.source) && <Lock size={12} className="text-amber-400" />}
          </label>
          <select id="presence-action" data-testid="presence-action" value={presence.action} disabled={busy || isLocked(presence.source)} onChange={e => void send(presenceActionPatch(e.target.value as PresenceAction))} className={input}>
            {PRESENCE_ACTIONS.map(action => <option key={action} value={action}>{t(`presence_action_${action}`)}</option>)}
          </select>
          <span className="text-[10px] text-slate-500">{t(`source_${presence.source}`)}</span>
        </div>
      )}

      {jwt && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-2" data-testid="security-jwt">
          <label className="text-xs font-bold text-slate-200 flex items-center gap-2" htmlFor="jwt-algorithm">
            {t('jwt_algorithm_title')}
            {isLocked(jwt.source) && <Lock size={12} className="text-amber-400" />}
          </label>
          <select id="jwt-algorithm" data-testid="jwt-algorithm" value={jwt.algorithm} disabled={busy || isLocked(jwt.source)} onChange={e => void send(jwtAlgorithmPatch(e.target.value as JwtAlgorithm))} className={input}>
            {JWT_ALGORITHMS.map(algorithm => <option key={algorithm} value={algorithm}>{t(`jwt_algorithm_${algorithm.toLowerCase()}`)}</option>)}
          </select>
          <span className="text-[10px] text-slate-500">{t(`source_${jwt.source}`)}</span>
          {jwt.algorithm === 'EdDSA' && (
            <div className="flex flex-col gap-1" data-testid="jwt-keys">
              <h3 className="text-xs font-bold text-slate-200">{t('jwt_keys_title')}</h3>
              {jwtKeys.map(key => (
                <span key={key.kid} className="text-[11px] text-slate-400 font-mono">
                  {key.kid} - {key.active ? t('jwt_key_active') : `${t('jwt_key_retired')} ${key.acceptedUntil ? new Date(key.acceptedUntil * 1000).toLocaleString() : ''}`}
                </span>
              ))}
              <button type="button" data-testid="jwt-rotate" disabled={busy} onClick={() => void rotate()} className={button}>{t('jwt_rotate')}</button>
            </div>
          )}
        </div>
      )}

      {dispatcher && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-3" data-testid="security-dispatcher">
          <h3 className="text-xs font-bold text-slate-200">{t('jd_title')}</h3>
          <label className="flex items-start gap-2 text-xs font-bold text-slate-200">
            <input type="checkbox" data-testid="jd-relay" checked={relay} disabled={busy || isLocked(dispatcher.relaySource)} onChange={e => setRelay(e.target.checked)} className="mt-0.5" />
            <span>{t('jd_relay_label')}</span>
            {isLocked(dispatcher.relaySource) && <Lock size={12} className="text-amber-400 mt-0.5" />}
          </label>
          <span className="text-[10px] text-slate-500 pl-6">{t(`source_${dispatcher.relaySource}`)}</span>
          <p className="text-[10px] text-slate-500">{t('jd_relay_help')}</p>
          <label className="text-xs font-bold text-slate-200" htmlFor="jd-map">{t('jd_map_label')}</label>
          <textarea id="jd-map" data-testid="jd-map" rows={4} value={mapText} placeholder={t('jd_map_placeholder')} disabled={busy} onChange={e => setMapText(e.target.value)} className={`${input} font-mono`} />
          <p className="text-[10px] text-slate-500">{t('jd_map_help')}</p>
          <h4 className="text-xs font-bold text-slate-200">{t('jd_replan_title')}</h4>
          <label className="flex items-start gap-2 text-xs font-bold text-slate-200">
            <input type="checkbox" data-testid="jd-allow" checked={allow} disabled={busy || !dispatcher.replanEditable} onChange={e => setAllow(e.target.checked)} className="mt-0.5" />
            <span>{t('jd_allow_label')}</span>
          </label>
          <label className="text-xs font-bold text-slate-200" htmlFor="jd-timeout">{t('jd_timeout_label')}</label>
          <input id="jd-timeout" data-testid="jd-timeout" type="text" inputMode="decimal" value={timeoutText} disabled={busy || !dispatcher.replanEditable} onChange={e => setTimeoutText(e.target.value)} className={`${input} w-32`} />
          <p className="text-[10px] text-slate-500">{dispatcher.replanEditable ? t('jd_replan_help') : t('jd_not_editable')}</p>
          <button onClick={saveDispatcher} disabled={busy} className={button}><Save size={14} /> {t('jd_save')}</button>
        </div>
      )}

      <PairingCard fingerprint={fingerprint} t={t} button={button} input={input} />

      {message && <p className="text-xs text-emerald-400">{message}</p>}
      {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
    </div>
  );
}
