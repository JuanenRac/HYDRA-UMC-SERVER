// =============================================================================
// HYDRA-UMC-SERVER - src/redaction.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Secret redaction for text and JSON-like values, a port of the shared module
// of the SDK (tools/canonical/redaction.py). The cases every implementation
// has to pass are kept in contracts/redaction/vectors.json of the SDK; a copy
// lives in tests/fixtures/redaction_vectors.json and tests/redaction.test.ts
// runs it. A fixed list of well-known secret shapes, never a "looks random"
// heuristic.

export const REDACTED = "[REDACTED]";

const SECRET_KEY_NAMES = [
  "password", "passwd", "pwd",
  "secret", "token", "api_key", "apikey", "api-key",
  "private_key", "privatekey", "private-key",
  "credential", "credentials",
  "ssh_key", "sshkey",
];
const KEYS = SECRET_KEY_NAMES.join("|");

const KEY_VALUE_RE = new RegExp(
  "(?<![A-Za-z0-9_-])(?<key>[A-Za-z0-9_-]*(?:" + KEYS + ")[A-Za-z0-9_-]*\\s*[:=]\\s*)" +
  "(?:(?<quote>[\"'])[^\\r\\n]*?\\k<quote>|\\S+)",
  "gi",
);
const JSON_KEY_VALUE_RE = new RegExp(
  "(?<key>\"[A-Za-z0-9_-]*(?:" + KEYS + ")[A-Za-z0-9_-]*\"\\s*:\\s*)" +
  "(?:\"(?:[^\"\\\\]|\\\\.)*\"|-?\\d+(?:\\.\\d+)?|true|false|null)",
  "gi",
);
const BEARER_RE = /\bBearer\s+\S+/gi;
const URL_CREDENTIALS_RE =
  /(?<![A-Za-z0-9+.-])(?<scheme>[A-Za-z][A-Za-z0-9+.-]{0,39}:\/\/)(?<user>[^\s:/@]{1,256}):(?<password>[^\s@]{1,1024})@/g;
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_TRUNCATED_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?![\s\S]*-----END)[\s\S]*/g;
const TOKEN_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const BASIC_AUTH_RE = /\b((?:proxy-)?authorization\s*[:=]\s*)basic\s+[A-Za-z0-9+/=]{6,}/gi;
const FLAG_VALUE_RE = new RegExp(
  "(?<flag>(?<![A-Za-z0-9_-])--?[A-Za-z0-9_-]*(?:" + KEYS + ")s?[A-Za-z0-9_-]*)" +
  "(?<sep>[ \\t]+)(?!-)(?<value>\\S+)",
  "gi",
);
const BASIC_BARE_RE = /\bBasic\s+(?=[A-Za-z0-9+/=_-]*[0-9+/=])[A-Za-z0-9+/=_-]{8,}/g;
const COOKIE_RE = /(?<header>\b(?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi;
const URL_TOKEN_USERINFO_RE =
  /(?<![A-Za-z0-9+.-])(?<scheme>[A-Za-z][A-Za-z0-9+.-]{0,39}:\/\/)(?<token>[^\s:/@]{16,1024})@/g;
const SECRET_KEY_PATTERN_SRC =
  "(?<![A-Za-z0-9_-])\"?[A-Za-z0-9_-]*(?:" + KEYS + ")[A-Za-z0-9_-]*\"?\\s*[:=]\\s*";

function redactNestedStructuredValues(text: string): string {
  const pattern = new RegExp(SECRET_KEY_PATTERN_SRC, "gi");
  const pieces: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) { pattern.lastIndex++; continue; }
    if (match.index < cursor) continue;
    const valueStart = match.index + match[0].length;
    if (valueStart >= text.length || (text[valueStart] !== "{" && text[valueStart] !== "[")) continue;
    const opening = text[valueStart];
    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = valueStart; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") inString = true;
      else if (ch === opening) depth++;
      else if (ch === closing) {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) continue;
    pieces.push(text.slice(cursor, match.index));
    pieces.push(match[0] + REDACTED);
    cursor = end;
    pattern.lastIndex = Math.max(pattern.lastIndex, end);
  }
  pieces.push(text.slice(cursor));
  return pieces.join("");
}

export function redactSecrets(text: string): string {
  if (!text) return text;
  let result = text.replace(PEM_TRUNCATED_RE, REDACTED);
  result = result.replace(PEM_BLOCK_RE, REDACTED);
  result = result.replace(BEARER_RE, `Bearer ${REDACTED}`);
  result = result.replace(BASIC_AUTH_RE, (_m, head: string) => `${head}Basic ${REDACTED}`);
  result = result.replace(BASIC_BARE_RE, `Basic ${REDACTED}`);
  result = result.replace(COOKIE_RE, (...a) => `${(a[a.length - 1] as Record<string, string>).header}${REDACTED}`);
  for (const shape of TOKEN_SHAPES) result = result.replace(shape, REDACTED);
  result = result.replace(URL_TOKEN_USERINFO_RE, (...a) => `${(a[a.length - 1] as Record<string, string>).scheme}${REDACTED}@`);
  result = result.replace(URL_CREDENTIALS_RE, (...a) => {
    const g = a[a.length - 1] as Record<string, string>;
    return `${g.scheme}${g.user}:${REDACTED}@`;
  });
  result = redactNestedStructuredValues(result);
  result = result.replace(JSON_KEY_VALUE_RE, (...a) => `${(a[a.length - 1] as Record<string, string>).key}${REDACTED}`);
  result = result.replace(KEY_VALUE_RE, (...a) => `${(a[a.length - 1] as Record<string, string>).key}${REDACTED}`);
  result = result.replace(FLAG_VALUE_RE, (...a) => {
    const g = a[a.length - 1] as Record<string, string>;
    return `${g.flag}${g.sep}${REDACTED}`;
  });
  return result;
}

export function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const keyOnly = new RegExp("^" + SECRET_KEY_PATTERN_SRC + "$", "i");
    const cleaned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (keyOnly.test(key + ":") && (typeof item === "string" || typeof item === "number")) cleaned[key] = REDACTED;
      else cleaned[key] = redactJson(item);
    }
    return cleaned;
  }
  return value;
}

export function redactLines(lines: string[]): string[] {
  if (lines.length === 0) return [];
  return redactSecrets(lines.join("\n")).split("\n");
}
