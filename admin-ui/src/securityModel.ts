// =============================================================================
// HYDRA-UMC SERVER - Admin UI security options (the logic, no screen): securityModel.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// What the Security tab shows and sends. It has no dependency on React or the browser, so the server tests (tests/adminUiSecurity.test.ts) check it.
// The options are those of GET/PUT /api/admin/server-config: nine switches that each start on the conservative value, and the job dispatcher
// section (the delivery of its stop requests, the map of robots, and the two options of its replanning).
// =============================================================================

export type Source = 'env' | 'config' | 'default';

export interface SwitchDef {
  /** `section.key`, as in the answer of the server. */
  id: string;
  section: string;
  key: string;
  /** The value that lowers the protection of the server (asks for a confirmation); null when neither value does. */
  riskyWhen: boolean | null;
  /** The key of the text for the label. */
  label: string;
  /** The key of the sentence shown when the server answers with the warning of this switch, if it has one. */
  warning: string | null;
  /** The key of the question asked before the risky value is saved, if there is one. */
  confirm: string | null;
  /** The warning code the server sends when the risky value is saved. */
  warningCode: string | null;
}

export const SWITCHES: readonly SwitchDef[] = [
  { id: 'health.open', section: 'health', key: 'open', riskyWhen: true, label: 'sw_health_open', warning: 'warn_health_open', confirm: 'confirm_health_open', warningCode: 'health_open' },
  { id: 'safety.publishGlobalStop', section: 'safety', key: 'publishGlobalStop', riskyWhen: null, label: 'sw_publish_stop', warning: null, confirm: null, warningCode: 'global_stop_published' },
  { id: 'connections.recordAddress', section: 'connections', key: 'recordAddress', riskyWhen: true, label: 'sw_record_address', warning: 'warn_record_address', confirm: 'confirm_record_address', warningCode: 'connection_address_recorded' },
  { id: 'camera.open', section: 'camera', key: 'open', riskyWhen: true, label: 'sw_camera_open', warning: 'warn_camera_open', confirm: 'confirm_exposure', warningCode: 'camera_open' },
  { id: 'websocket.allowQueryToken', section: 'websocket', key: 'allowQueryToken', riskyWhen: true, label: 'sw_ws_token', warning: 'warn_ws_token', confirm: 'confirm_exposure', warningCode: 'ws_query_token_allowed' },
  { id: 'logging.redactSecrets', section: 'logging', key: 'redactSecrets', riskyWhen: false, label: 'sw_log_redaction', warning: 'warn_log_redaction', confirm: 'confirm_exposure', warningCode: 'log_redaction_off' },
  { id: 'voice.requireSignature', section: 'voice', key: 'requireSignature', riskyWhen: null, label: 'sw_voice_signature', warning: null, confirm: null, warningCode: null },
  { id: 'camera.credentialsViaEnv', section: 'camera', key: 'credentialsViaEnv', riskyWhen: false, label: 'sw_camera_env', warning: 'warn_camera_env', confirm: 'confirm_install', warningCode: 'camera_credentials_in_arguments' },
  { id: 'push.enabled', section: 'push', key: 'enabled', riskyWhen: null, label: 'sw_push', warning: 'warn_push', confirm: null, warningCode: 'push_enabled' },
  { id: 'presence.enabled', section: 'presence', key: 'enabled', riskyWhen: null, label: 'sw_presence', warning: 'warn_presence', confirm: null, warningCode: 'presence_on' },
  { id: 'auth.acceptHs256', section: 'auth', key: 'acceptHs256', riskyWhen: null, label: 'sw_jwt_accept_hs256', warning: 'warn_jwt_hs256_refused', confirm: null, warningCode: 'jwt_hs256_refused' },
  { id: 'trustedNetworks.enabled', section: 'trustedNetworks', key: 'enabled', riskyWhen: null, label: 'sw_trusted_networks', warning: 'warn_trusted_networks', confirm: null, warningCode: 'trusted_networks_on' },
  { id: 'rateLimits.enabled', section: 'rateLimits', key: 'enabled', riskyWhen: false, label: 'sw_rate_limits', warning: 'warn_rate_limits_off', confirm: 'confirm_rate_limits', warningCode: 'rate_limits_off' },
  { id: 'install.newInstallTls', section: 'install', key: 'newInstallTls', riskyWhen: false, label: 'sw_install_tls', warning: 'warn_install_tls', confirm: 'confirm_install', warningCode: 'new_install_tls_off' },
];

export interface SwitchState {
  def: SwitchDef;
  value: boolean;
  source: Source;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSource = (value: unknown): value is Source => value === 'env' || value === 'config' || value === 'default';

/** The switches the server reports; one a server predates, or reports damaged, is left out instead of being guessed. */
export function readSwitches(snapshot: unknown): SwitchState[] {
  if (!isObject(snapshot)) return [];
  const out: SwitchState[] = [];
  for (const def of SWITCHES) {
    const section = snapshot[def.section];
    const option = isObject(section) ? section[def.key] : undefined;
    if (isObject(option) && typeof option.value === 'boolean' && isSource(option.source)) out.push({ def, value: option.value, source: option.source });
  }
  return out;
}

/** A value fixed by the environment of the server cannot be changed from the screen. */
export const isLocked = (source: Source): boolean => source === 'env';

/** The request body that changes one switch (nothing else is sent). */
export function switchPatch(def: SwitchDef, value: boolean): Record<string, Record<string, boolean>> {
  return { [def.section]: { [def.key]: value } };
}

/** The risky value, reached from the other one, asks for a confirmation first. */
export function needsConfirmation(def: SwitchDef, current: boolean, next: boolean): boolean {
  return def.riskyWhen !== null && current !== next && next === def.riskyWhen;
}

/** The sentences (keys) for the warnings of an answer that this screen knows. */
export function warningKeys(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  const keys: string[] = [];
  for (const def of SWITCHES) if (def.warning && def.warningCode && warnings.includes(def.warningCode)) keys.push(def.warning);
  if (warnings.includes('rate_limits_loose')) keys.push('warn_rate_limits_loose');
  if (warnings.includes('presence_action_notify')) keys.push('warn_presence_notify');
  if (warnings.includes('jwt_eddsa_on')) keys.push('warn_jwt_eddsa');
  if (warnings.includes('job_stop_relay_on')) keys.push('jd_warning_relay');
  if (warnings.includes('replan_unconfirmed_allowed')) keys.push('jd_warning_replan');
  return keys;
}

// ------------------------------------------------------------------ the job dispatcher

export const MAX_STOP_ACK_TIMEOUT_SECONDS = 86400;
const DISPATCHER_ROBOT_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export interface JobDispatcherState {
  relayEnabled: boolean;
  relaySource: Source;
  relayAppliesOnRestart: boolean;
  robotMap: Record<string, number>;
  allowUnconfirmed: boolean;
  timeoutSeconds: number;
  /** The server was told the configuration file of the dispatcher; without it the replanning options cannot be changed. */
  replanEditable: boolean;
}

export function readJobDispatcher(snapshot: unknown): JobDispatcherState | null {
  if (!isObject(snapshot) || !isObject(snapshot.jobDispatcher)) return null;
  const relay = snapshot.jobDispatcher.stopRelay;
  const replan = snapshot.jobDispatcher.replan;
  if (!isObject(relay) || !isObject(replan) || !isObject(relay.enabled) || !isObject(replan.allowUnconfirmed) || !isObject(replan.stopAckTimeoutSeconds)) return null;
  if (typeof relay.enabled.value !== 'boolean' || !isSource(relay.enabled.source)) return null;
  if (typeof replan.allowUnconfirmed.value !== 'boolean' || typeof replan.stopAckTimeoutSeconds.value !== 'number') return null;
  const robotMap: Record<string, number> = {};
  if (isObject(relay.robotMap)) for (const [id, n] of Object.entries(relay.robotMap)) if (typeof n === 'number' && Number.isInteger(n)) robotMap[id] = n;
  return {
    relayEnabled: relay.enabled.value,
    relaySource: relay.enabled.source,
    relayAppliesOnRestart: relay.appliesOnRestart === true,
    robotMap,
    allowUnconfirmed: replan.allowUnconfirmed.value,
    timeoutSeconds: replan.stopAckTimeoutSeconds.value,
    replanEditable: replan.editable === true,
  };
}

export function robotMapToText(map: Record<string, number>): string {
  return Object.keys(map).sort().map(id => `${id} = ${map[id]}`).join('\n');
}

/** One `id = number` per line; null when a line is not that, an id is not valid, a number is not a whole number of 0 or more, or an id repeats. */
export function parseRobotMapText(text: string): Record<string, number> | null {
  const map: Record<string, number> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const match = /^([^=\s]+)\s*=\s*(\d+)$/.exec(line);
    if (!match || !DISPATCHER_ROBOT_ID.test(match[1]) || Object.prototype.hasOwnProperty.call(map, match[1])) return null;
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number)) return null;
    map[match[1]] = number;
  }
  return Object.keys(map).length <= 1000 ? map : null;
}

export type JobDispatcherPatch = {
  jobDispatcher: { stopRelay: { enabled: boolean; robotMap: Record<string, number> }; replan?: { allowUnconfirmed: boolean; stopAckTimeoutSeconds: number } };
};

/** The request body for the job dispatcher; null when the map or the wait is not valid. The replanning part is left out when the server cannot write the file of the dispatcher. */
export function jobDispatcherPatch(input: { relayEnabled: boolean; robotMapText: string; replanEditable: boolean; allowUnconfirmed: boolean; timeoutText: string }): JobDispatcherPatch | null {
  const robotMap = parseRobotMapText(input.robotMapText);
  if (robotMap === null) return null;
  const body: JobDispatcherPatch = { jobDispatcher: { stopRelay: { enabled: input.relayEnabled, robotMap } } };
  if (input.replanEditable) {
    const text = input.timeoutText.trim().replace(',', '.');
    if (text === '' || !/^\d*\.?\d+$|^\d+\.$/.test(text)) return null;
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_STOP_ACK_TIMEOUT_SECONDS) return null;
    body.jobDispatcher.replan = { allowUnconfirmed: input.allowUnconfirmed, stopAckTimeoutSeconds: seconds };
  }
  return body;
}

export function jobDispatcherNeedsConfirmation(current: JobDispatcherState, next: JobDispatcherPatch): boolean {
  const relayOn = !current.relayEnabled && next.jobDispatcher.stopRelay.enabled;
  const unconfirmed = next.jobDispatcher.replan !== undefined && !current.allowUnconfirmed && next.jobDispatcher.replan.allowUnconfirmed;
  return relayOn || unconfirmed;
}

// ------------------------------------------------------------------ the action of the dead-man of the presence

export const PRESENCE_ACTIONS = ['slow', 'pause', 'notify', 'stop'] as const;
export type PresenceAction = (typeof PRESENCE_ACTIONS)[number];

export interface PresenceActionState {
  action: PresenceAction;
  source: Source;
}

/** The action the server reports for a lost heartbeat; a server that predates it, or reports it damaged, gives null. */
export function readPresenceAction(snapshot: unknown): PresenceActionState | null {
  if (!isObject(snapshot) || !isObject(snapshot.presence) || !isObject(snapshot.presence.action)) return null;
  const { value, source } = snapshot.presence.action;
  if (typeof value !== 'string' || !(PRESENCE_ACTIONS as readonly string[]).includes(value) || !isSource(source)) return null;
  return { action: value as PresenceAction, source };
}

/** The request body that chooses the action (nothing else is sent). */
export function presenceActionPatch(action: PresenceAction): { presence: { action: PresenceAction } } {
  return { presence: { action } };
}

// ------------------------------------------------------------------ how the sign-in tokens are signed

export const JWT_ALGORITHMS = ['HS256', 'EdDSA'] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export interface JwtAlgorithmState {
  algorithm: JwtAlgorithm;
  source: Source;
}

/** The algorithm the server reports for new tokens; a server that predates it, or reports it damaged, gives null. */
export function readJwtAlgorithm(snapshot: unknown): JwtAlgorithmState | null {
  if (!isObject(snapshot) || !isObject(snapshot.auth) || !isObject(snapshot.auth.jwtAlgorithm)) return null;
  const { value, source } = snapshot.auth.jwtAlgorithm;
  if (typeof value !== 'string' || !(JWT_ALGORITHMS as readonly string[]).includes(value) || !isSource(source)) return null;
  return { algorithm: value as JwtAlgorithm, source };
}

/** The request body that chooses the algorithm (nothing else is sent). */
export function jwtAlgorithmPatch(algorithm: JwtAlgorithm): { auth: { jwtAlgorithm: JwtAlgorithm } } {
  return { auth: { jwtAlgorithm: algorithm } };
}

export interface JwtKeyRow {
  kid: string;
  active: boolean;
  acceptedUntil: number | null;
}

/** The signing keys GET /api/admin/jwt-keys reports (state only, never a private part); damaged rows are left out. */
export function readJwtKeys(answer: unknown): JwtKeyRow[] {
  if (!isObject(answer) || !Array.isArray(answer.keys)) return [];
  const rows: JwtKeyRow[] = [];
  for (const key of answer.keys) {
    if (isObject(key) && typeof key.kid === 'string' && typeof key.active === 'boolean') rows.push({ kid: key.kid, active: key.active, acceptedUntil: typeof key.acceptedUntil === 'number' ? key.acceptedUntil : null });
  }
  return rows;
}

// ------------------------------------------------------------------ the request limits per address

/** The numbers of the limiters, in the order the screen shows them; `label` is the key of the text. */
export const RATE_LIMIT_FIELDS = [
  { key: 'loginMax', label: 'rl_login_max' },
  { key: 'loginWindowSeconds', label: 'rl_login_window' },
  { key: 'refreshMax', label: 'rl_refresh_max' },
  { key: 'apiMax', label: 'rl_api_max' },
  { key: 'sensitiveMax', label: 'rl_sensitive_max' },
  { key: 'apiWindowSeconds', label: 'rl_api_window' },
  { key: 'stopAllMax', label: 'rl_stopall_max' },
  { key: 'stopAllWindowSeconds', label: 'rl_stopall_window' },
] as const;
export type RateLimitKey = (typeof RATE_LIMIT_FIELDS)[number]['key'];

export interface RateLimitNumber {
  value: number;
  source: Source;
  min: number;
  max: number;
}

export type RateLimitsState = Record<RateLimitKey, RateLimitNumber>;

/** The numbers the server reports (the switch is one of SWITCHES); null when the server predates them or reports one damaged. */
export function readRateLimits(snapshot: unknown): RateLimitsState | null {
  if (!isObject(snapshot) || !isObject(snapshot.rateLimits)) return null;
  const out: Partial<RateLimitsState> = {};
  for (const { key } of RATE_LIMIT_FIELDS) {
    const entry = snapshot.rateLimits[key];
    if (!isObject(entry) || !isSource(entry.source)) return null;
    const { value, min, max } = entry;
    if (typeof value !== 'number' || typeof min !== 'number' || typeof max !== 'number' || !Number.isInteger(value)) return null;
    out[key] = { value, source: entry.source, min, max };
  }
  return out as RateLimitsState;
}

/** The number typed in a box, or null when it is not a whole number inside the range. */
export function parseRateLimitText(text: string, entry: Pick<RateLimitNumber, 'min' | 'max'>): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= entry.min && n <= entry.max ? n : null;
}

/** The request body with only the numbers that changed and are not fixed by the environment; null when one typed number is not valid, `{}`-bodied (no keys) when nothing changed. */
export function rateLimitsPatch(current: RateLimitsState, texts: Record<RateLimitKey, string>): { rateLimits: Partial<Record<RateLimitKey, number>> } | null {
  const body: Partial<Record<RateLimitKey, number>> = {};
  for (const { key } of RATE_LIMIT_FIELDS) {
    const entry = current[key];
    const n = parseRateLimitText(texts[key], entry);
    if (n === null) return null;
    if (!isLocked(entry.source) && n !== entry.value) body[key] = n;
  }
  return { rateLimits: body };
}
