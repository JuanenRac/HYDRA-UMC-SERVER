// =============================================================================
// HYDRA-UMC-SERVER - src/pushFcm.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Push notifications through Firebase Cloud Messaging (the Android phones, and an iPhone whose app registered a Firebase
// token). The service account of the installation's own Firebase project is a JSON file named by HYDRA_UMC_FCM_SERVICE_ACCOUNT
// or by push.fcmServiceAccountFile of the configuration file; it must live outside the directory the server runs from, and
// nothing of it is ever logged, audited or returned by a route. The access token is made from its private key (a signed JWT
// exchanged at the token address of the account) and kept for most of its hour. A message only informs: it carries a title,
// a sentence and the kind of event, and no action of any sort.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export type FcmAccountProblem = "missing" | "key-in-repo" | "key-unreadable" | "invalid";

/** The notification channel the Android app creates: the id named here is the one the phone has. */
export const FCM_ANDROID_CHANNEL = "hydra_umc_server";

/** A registration token of Firebase. */
export function validFcmToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_:.-]{20,4096}$/.test(token);
}

function insideOf(root: string, file: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}

/**
 * Reads the service account named by the environment or, without it, by the configuration file. Returns the problem (never
 * the values) when it is not usable: a file inside the directory the server runs from is refused, so that it can never be
 * committed or served by accident.
 */
export function readFcmServiceAccount(
  env: NodeJS.ProcessEnv,
  configuredFile: unknown,
  cwd = process.cwd(),
): { account: FcmServiceAccount } | { problem: FcmAccountProblem } {
  const named = env.HYDRA_UMC_FCM_SERVICE_ACCOUNT?.trim() || (typeof configuredFile === "string" ? configuredFile.trim() : "");
  if (!named) return { problem: "missing" };
  const resolved = path.resolve(named);
  const root = path.resolve(cwd);
  if (insideOf(root, resolved)) return { problem: "key-in-repo" };
  let text: string;
  try {
    // a link that leads back into the directory of the server is refused as well
    if (insideOf(fs.realpathSync(root), fs.realpathSync(resolved))) return { problem: "key-in-repo" };
    text = fs.readFileSync(resolved, "utf8");
  } catch {
    return { problem: "key-unreadable" };
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const account: FcmServiceAccount = {
      projectId: String(value.project_id ?? ""),
      clientEmail: String(value.client_email ?? ""),
      privateKey: String(value.private_key ?? ""),
      tokenUri: typeof value.token_uri === "string" ? value.token_uri : "https://oauth2.googleapis.com/token",
    };
    if (!/^[a-z0-9][a-z0-9-]{4,60}$/.test(account.projectId) || !account.clientEmail.includes("@") || !account.tokenUri.startsWith("https://")) {
      return { problem: "invalid" };
    }
    crypto.createPrivateKey(account.privateKey);
    return { account };
  } catch {
    // the message of a parse error can quote the file: it is dropped on purpose
    return { problem: "invalid" };
  }
}

/** The signed request for an access token (RFC 7523). */
export function fcmAssertion(account: FcmServiceAccount, nowSeconds: number): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const claim = {
    iss: account.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: account.tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const input = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claim)}`;
  return `${input}.${crypto.sign("sha256", Buffer.from(input), account.privateKey).toString("base64url")}`;
}

export interface FcmNotification {
  platform: "ios" | "android";
  title: string;
  body: string;
  kind: string;
  collapseId: string;
  expiresInSeconds: number;
}

export interface FcmResult {
  status: number;
  /** "Unregistered" when the token is no longer worth keeping. */
  reason?: string;
}

export interface FcmSender {
  send(token: string, notification: FcmNotification): Promise<FcmResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const network: { fetch: FetchLike } = { fetch: (url, init) => fetch(url, init) };

/** The body of one message of the HTTP v1 interface. It only informs: no click action, no buttons, no command. */
export function fcmMessage(token: string, n: FcmNotification, nowSeconds: number): Record<string, unknown> {
  const collapse = n.collapseId.slice(0, 64);
  const platform =
    n.platform === "android"
      ? { android: { priority: "HIGH", ttl: `${n.expiresInSeconds}s`, notification: { channel_id: FCM_ANDROID_CHANNEL, tag: collapse } } }
      : {
          apns: {
            headers: { "apns-priority": "10", "apns-expiration": String(nowSeconds + n.expiresInSeconds), "apns-collapse-id": collapse },
            payload: { aps: { sound: "default" } },
          },
        };
  return { message: { token, notification: { title: n.title, body: n.body }, data: { kind: n.kind }, ...platform } };
}

export class FcmClient implements FcmSender {
  private access: { value: string; until: number } | null = null;

  constructor(
    private readonly account: FcmServiceAccount,
    private readonly options: { request?: FetchLike; timeoutMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    const send = this.options.request ?? network.fetch;
    return send(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000) });
  }

  private async accessToken(): Promise<string | null> {
    if (this.access && this.access.until > this.now()) return this.access.value;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: fcmAssertion(this.account, Math.floor(this.now() / 1000)),
    });
    const reply = await this.request(this.account.tokenUri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (!reply.ok) return null;
    const answer = (await reply.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof answer.access_token !== "string") return null;
    const seconds = typeof answer.expires_in === "number" ? answer.expires_in : 3600;
    this.access = { value: answer.access_token, until: this.now() + Math.max(60, seconds - 300) * 1000 };
    return this.access.value;
  }

  async send(token: string, notification: FcmNotification): Promise<FcmResult> {
    try {
      const bearer = await this.accessToken();
      if (!bearer) return { status: 0, reason: "no-access-token" };
      const reply = await this.request(`https://fcm.googleapis.com/v1/projects/${this.account.projectId}/messages:send`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify(fcmMessage(token, notification, Math.floor(this.now() / 1000))),
      });
      if (reply.ok) return { status: 200 };
      const detail = (await reply.text().catch(() => "")).slice(0, 1000);
      if (reply.status === 401) this.access = null;
      const gone = reply.status === 404 || reply.status === 410 || (reply.status === 400 && /registration token|UNREGISTERED/i.test(detail));
      return { status: reply.status, reason: gone ? "Unregistered" : undefined };
    } catch {
      return { status: 0, reason: "network" };
    }
  }
}
