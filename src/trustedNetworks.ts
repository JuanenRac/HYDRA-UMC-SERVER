// =============================================================================
// HYDRA-UMC-SERVER - src/trustedNetworks.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Trusted networks, an option that is OFF by default. When an administrator turns it on, the server tells
// where a request comes from: the house (the private ranges, or the ranges listed in the configuration file) and
// its VPN count as trusted, anything else is "outside". From outside, administering the server (users, settings,
// service control, power, bridges) is refused, an "outside" policy of `view` refuses everything but looking and
// stopping, and an account can only sign in with the second factor turned on. Nothing changes while the option
// is off. The address is the one of the socket: behind a reverse proxy every request looks like the proxy's own
// (the server has no setting to believe a forwarded address), so use the VPN, not a proxy, for remote access.
import net from "node:net";

export type Origin = "local" | "remote";
/** What a request from outside may do: `operate` everything but administer, `view` only look (and stop). */
export type OutsidePolicy = "operate" | "view";
export const OUTSIDE_POLICIES: readonly OutsidePolicy[] = ["operate", "view"];

type Range = { family: 4 | 6; network: bigint; bits: number };

/** What the configuration file holds under `trustedNetworks`. Only `enabled` is a switch (Server Admin); the rest is read from the file only. */
export interface TrustedNetworksFile {
  /** Whether the option is on (default: no). */
  enabled?: boolean;
  /** Address ranges (CIDR) that count as the house. Default: the private ranges and the loopback. */
  local?: string[];
  /** Ranges of the VPN, which count as the house too. Default: none. */
  vpn?: string[];
  /** What a request from outside may do (default: `operate`). */
  outside?: OutsidePolicy;
  /** Whether an account may only sign in from outside with the second factor turned on (default: yes). */
  outsideRequiresSecondFactor?: boolean;
}

export const DEFAULT_LOCAL_NETWORKS = ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "127.0.0.0/8", "::1/128", "fe80::/10", "fc00::/7"];

const toBigInt = (address: string): { family: 4 | 6; value: bigint } | undefined => {
  const plain = address.replace(/^::ffff:/i, "");
  if (net.isIPv4(plain)) return { family: 4, value: plain.split(".").reduce((total, part) => total * 256n + BigInt(part), 0n) };
  if (net.isIPv6(plain)) {
    const zone = plain.split("%")[0];
    const [head = "", tail = ""] = zone.split("::");
    const part = (text: string) => (text === "" ? [] : text.split(":"));
    const left = part(head);
    const right = zone.includes("::") ? part(tail) : [];
    const groups = [...left, ...Array(zone.includes("::") ? 8 - left.length - right.length : 0).fill("0"), ...right];
    if (groups.length !== 8) return undefined;
    return { family: 6, value: groups.reduce((total, group) => total * 65536n + BigInt(`0x${group || "0"}`), 0n) };
  }
  return undefined;
};

/** One CIDR block ("10.66.0.0/24", "fd00::/8", or a single address), or null when it is not one. */
export function parseRange(item: unknown): Range | null {
  if (typeof item !== "string") return null;
  const [address = "", bitsText, extra] = item.trim().split("/");
  if (extra !== undefined) return null;
  const parsed = toBigInt(address);
  if (!parsed) return null;
  const max = parsed.family === 6 ? 128 : 32;
  const bits = bitsText === undefined ? max : /^\d{1,3}$/.test(bitsText) ? Number(bitsText) : -1;
  if (bits < 0 || bits > max) return null;
  const shift = BigInt(max - bits);
  return { family: parsed.family, network: (parsed.value >> shift) << shift, bits };
}

export interface RangeList { ranges: Range[]; invalid: string[] }

/** Parses a list; an entry that is not a range is left out (a smaller trusted area, never a larger one) and reported. */
export function parseRanges(list: unknown): RangeList {
  const ranges: Range[] = [];
  const invalid: string[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    const range = parseRange(item);
    if (range) ranges.push(range);
    else invalid.push(String(item).slice(0, 64));
  }
  return { ranges, invalid };
}

export function inRanges(address: string | undefined, ranges: Range[]): boolean {
  const parsed = address ? toBigInt(address) : undefined;
  if (!parsed) return false;
  return ranges.some((range) => {
    if (range.family !== parsed.family) return false;
    const max = range.family === 6 ? 128 : 32;
    const shift = BigInt(max - range.bits);
    return ((parsed.value >> shift) << shift) === range.network;
  });
}

export interface TrustedNetworksSettings {
  enabled: boolean;
  local: Range[];
  vpn: Range[];
  outside: OutsidePolicy;
  outsideRequiresSecondFactor: boolean;
  /** Entries of the file that are not address ranges (they count as nothing). */
  invalid: string[];
}

/** The settings in force: the switch (already resolved by the caller) and the rest from the file, each with its conservative default. */
export function resolveTrustedNetworks(enabled: boolean, file: TrustedNetworksFile | undefined): TrustedNetworksSettings {
  const local = parseRanges(Array.isArray(file?.local) ? file?.local : DEFAULT_LOCAL_NETWORKS);
  const vpn = parseRanges(file?.vpn);
  return {
    enabled,
    local: local.ranges,
    vpn: vpn.ranges,
    outside: file?.outside !== undefined && OUTSIDE_POLICIES.includes(file.outside) ? file.outside : "operate",
    outsideRequiresSecondFactor: typeof file?.outsideRequiresSecondFactor === "boolean" ? file.outsideRequiresSecondFactor : true,
    invalid: [...local.invalid, ...vpn.invalid],
  };
}

export function classify(address: string | undefined, settings: TrustedNetworksSettings): Origin {
  return inRanges(address, settings.local) || inRanges(address, settings.vpn) ? "local" : "remote";
}

/** The paths that administer the server or reach machines: never from outside while the option is on. */
const ADMIN_PATH = /^\/api\/(admin|users|system|ecosystem\/service|integrations|upload-work|models\/submit|bridges\/[^/]+\/cmd)(\/|$)/;
/** What a person may always do from outside, even when the policy is `view`: sign in and out, their own second factor, tickets for pictures, their phone's push token. */
const OWN_PATH = /^\/api\/(login|logout|refresh|totp|push\/devices|camera\/ticket)(\/|$)/;

export type OutsideVerdict = { allowed: true } | { allowed: false; reason: "admin" | "view" };

/**
 * Whether a request that comes from outside may go on. `command` is the `command` of the body of a robot command
 * (a stop is always allowed: it is never held back).
 */
export function outsideVerdict(settings: TrustedNetworksSettings, method: string, path: string, command?: unknown): OutsideVerdict {
  if (ADMIN_PATH.test(path) || (method === "POST" && path === "/api/settings")) return { allowed: false, reason: "admin" };
  if (settings.outside === "operate") return { allowed: true };
  const reads = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (reads || OWN_PATH.test(path)) return { allowed: true };
  if (method === "POST" && path === "/api/stop-all") return { allowed: true };
  if (method === "POST" && /^\/api\/robot\/[^/]+\/command$/.test(path) && (command === "stop" || command === "disable")) return { allowed: true };
  return { allowed: false, reason: "view" };
}

export interface RefusalAudit {
  record(entry: { type: string; outcome: string; userId?: unknown; username?: string; ip?: string; detail?: unknown }): void;
}

/**
 * The express middleware. It does nothing while the option is off. `get` is read on every request, so a change made in
 * Server Admin applies at once.
 */
export function makeTrustedNetworksGate(get: () => TrustedNetworksSettings, audit?: RefusalAudit) {
  return (req: any, res: any, next: () => void) => {
    const settings = get();
    if (!settings.enabled) return next();
    if (classify(req.ip, settings) === "local") return next();
    const verdict = outsideVerdict(settings, String(req.method ?? "GET").toUpperCase(), String(req.path ?? ""), req.body?.command);
    if (verdict.allowed) return next();
    try {
      audit?.record({ type: "remote-policy", outcome: "refused", userId: req.user?.id, username: req.user?.username, ip: req.ip, detail: { method: req.method, path: req.path, policy: settings.outside } });
    } catch { /* an audit that cannot be written never turns a refusal into an answer of success */ }
    return res.status(403).json({
      error: verdict.reason === "admin" ? "this is only possible from the house or over the VPN" : "from outside only looking and stopping are possible; use the house network or the VPN",
      code: "remote-policy",
      needs: "vpn",
    });
  };
}

/** Whether a sign-in (or a renewal of one) from `address` must be turned away because the account has no second factor. */
export function outsideNeedsSecondFactor(settings: TrustedNetworksSettings, address: string | undefined, accountHasSecondFactor: boolean): boolean {
  return settings.enabled && settings.outsideRequiresSecondFactor && !accountHasSecondFactor && classify(address, settings) === "remote";
}
