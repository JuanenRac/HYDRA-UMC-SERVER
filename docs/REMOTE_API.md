# HYDRA-UMC SERVER - Remote Control API

Reference for any client that talks to a running HYDRA-UMC SERVER
instance: [HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)
(the web dashboard - a pure Vite/React client of this same contract, not
a special case; see its own `src/store.tsx`), [HYDRA-UMC SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)
(desktop swarm-control app), [HYDRA-UMC ANDROID CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL),
[HYDRA-UMC IOS CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL),
and [HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)
(desktop URDF creator/editor, section 2d only - it doesn't otherwise
connect the way the other clients do).
Real bearer-token auth (section 2a), per-client discovery gating via
`X-Hydra-Client` (end of section 1), and account management (section 2b)
replaced the project's original single hardcoded `demo`/`demo` login and
single combined remote-access toggle.

Everything here lives on this same HYDRA-UMC SERVER host:port (default
`3000`) - one thing to discover, one port to open through a firewall,
both the REST endpoints and the WebSocket share it. HYDRA-UMC STUDIO
itself is a separate process/origin (see that project's own README for
why) that talks to this same host:port like every other client below,
not a special case served from the same process anymore.

## 1. Discovery: `GET /api/hydra-info`

The first request any remote client should make to a candidate IP -
confirms it's actually a HYDRA-UMC STUDIO server before trying to talk
the real API to it. Deliberately cheap (answered from an in-memory cache,
no disk read), safe to fire at many IPs in parallel when scanning a
subnet for a swarm of controllers.

```json
{
  "product": "HYDRA-UMC STUDIO",
  "remoteApiVersion": 1,
  "appVersion": "0.0.0",
  "hostname": "JUANEN",
  "controllerCount": 1,
  "robotCount": 8,
  "uptimeSeconds": 22
}
```

- `remoteApiVersion` - bump this document's own contract number, independent
  of `appVersion` (the app's own `package.json` version). A remote client
  should check this field, not `appVersion`, before assuming a feature
  described here is actually present on an older server.
- `controllerCount`/`robotCount` - cheap headline numbers for a scan
  results list (e.g. SUITE's own server browser) without a client having
  to fetch and parse the full state via section 2 for every discovered IP.

A subnet scan is a plain, unauthenticated HTTP GET per candidate IP on the
known port - a `_hydra._tcp` mDNS/Bonjour service is also advertised for
automatic discovery on supported networks.

**Remote-access gate, per client:** every remote client
must send an `X-Hydra-Client` request header identifying itself -
`suite`, `android`, or `ios`. If `SystemSettings.remoteAccess.<that
client>` is explicitly `false` (set from the browser UI's own Config ->
Remote Access tab, one switch per client), this endpoint responds `404`
instead - the server becomes indistinguishable from "not running
HYDRA-UMC STUDIO" to that specific scanning client, while the other two
remote clients (and this same server's own browser tab, which never sends
this header) are unaffected. A request with no `X-Hydra-Client` header, or
an unrecognized value, is never gated here. Each field defaults to enabled
when absent, and falls back to the older singular `remoteAccess.enabled`
flag if that client's own field was never explicitly set, so a
`settings.json` that predates the per-client split, or that predates the
remote-access feature entirely, keeps working unchanged. This
gate covers `/api/hydra-info` only - `GET`/`POST /api/settings` and `/ws`
stay open to anyone who can already reach the port (subject to the auth in
section 2a below), since the browser UI's own tab depends on that exact
same contract for its own connection to its own server; disabling
discovery doesn't revoke access for a client that already knows the
address. In practice this means: a client that has already discovered and
connected to a server before its own switch is flipped off keeps working
normally (its open WebSocket isn't dropped); the toggle only prevents
*new* discovery by that one client type.

## 2a. Authentication: `POST /api/login`, bearer tokens, and roles

Every write in this API (`POST /api/settings`, `POST
/api/robot/:id/command`, the `/ws` upgrade, all of section 2b) requires an
`Authorization: Bearer <token>` header. Obtain one:

```
POST /api/login
{ "username": "admin", "password": "admin" }

-> { "success": true, "token": "<JWT>", "role": "admin" }
```

- Every server seeds exactly one account on its own first-ever start:
  username `admin`, password `admin` (see `users.ts` for the underlying
  account store). Change it from the browser UI's own Config -> Users tab
  as soon as a server is exposed beyond a fully trusted LAN.
- Two roles: `admin` (full access - can overwrite global settings, manage
  accounts, and send robot commands) and `operator` (can sign in, read
  state, and send robot commands via section 2c's atomic endpoint, but
  gets `403` from `POST /api/settings` and every route in section 2b).
  Create additional accounts of either role from Config -> Users
  (admin-only) or via section 2b directly.
- The returned token is a JWT signed server-side (`JWT_SECRET` in
  `server.ts`) carrying `{ username, role }`, valid 30 days. There is no
  refresh endpoint - a client whose token expires (or lacks a `role`
  claim - see the note below) just calls `POST
  /api/login` again.
- **A token with no `role` claim** reads as `req.user?.role === undefined`,
  so every `requireAdmin`-gated route (`POST /api/settings` included)
  rejects it with `403`. Every already-open client (this same browser tab,
  SUITE, the Android/iOS apps) needs to sign out and back in once to get a
  fresh token with a `role` claim - there is no way to upgrade an old token
  in place.
- For the WebSocket upgrade (section 3), pass the token as a query param:
  `ws://<host>:3000/ws?token=<JWT>`.

## 2b. Account management: `/api/users` (admin only)

All four routes below require `Authorization: Bearer <admin token>` -
an `operator` token gets `403` from every one of them, same as from `POST
/api/settings`. See `users.ts` for the underlying scrypt-hashed,
file-backed (`data/users.json`) store.

- `GET /api/users` -> `{ "users": [{ "username", "role", "createdAt" }, ...] }`
  (never includes password hashes).
- `POST /api/users` (body: `{ "username", "password", "role" }`, role
  `"admin"` or `"operator"`) creates a new account. `400` on a duplicate
  username or a password under 4 characters.
- `PUT /api/users/:username` (body: any of `{ "newUsername", "password",
  "role" }`) renames the account, changes its password, and/or changes its
  role. Refuses to demote or delete the *last* remaining `admin` account
  (`400`) - the server would otherwise be permanently lockable-out by a
  single mistaken edit.
- `DELETE /api/users/:username` - same last-admin guard as above.

## 2c. Full state: `GET` / `POST /api/settings`, and the atomic `POST /api/robot/:id/command`

The same `GET`/`POST /api/settings` endpoint the web UI itself has always
used - a remote client reads and writes through this exact contract, not
a separate one.

- `GET /api/settings` returns the full current state as one JSON object:
  `{ settings: SystemSettings, controllers: HydraController[], activeControllerId: string }`
  (see `src/store.tsx` for the real TypeScript shapes - this document
  doesn't restate every field, since that would drift out of sync with
  the actual source of truth). No auth required.
- `POST /api/settings` (body: the same shape) overwrites the whole thing.
  **Requires an `admin` token** (`403` for `operator`) -
  this is the same full-tree write the web UI's own panels still use for
  most of their edits, so an `operator` account is effectively
  read-only inside the browser UI itself, aside from whatever already uses
  the atomic endpoint below. There is no granular
  per-field PATCH on this endpoint - a client that wants to change one
  robot's one joint angle still has to read the full state, mutate its own
  local copy, and POST the whole object back.
- `POST /api/robot/:id/command` (body: e.g. `{ "type": "jog", "joint":
  "j1", "value": 12.5 }` - see `src/store.tsx`'s own atomic command
  senders for the full set of `type`s: stop/play/pause/jog/tool/valve/
  pump/speed/vision) is the small-payload alternative: **any authenticated
  token, `admin` or `operator`**, can call it. The server computes which
  robot IDs are affected (the target plus anything `combinedWith` it)
  itself, persists to disk, and broadcasts a WS delta on its own - this is
  the primary way SUITE, the Android app, and the iOS app all write today,
  precisely because it doesn't require the admin role a full settings
  overwrite now does.

**Race condition to know about:** two clients (a browser tab and SUITE, or
two SUITE instances) that both read, then both write moments apart, can
still clobber each other if their writes race outside the live-sync
window described in section 3. Section 3 mitigates this for anything
already connected over the WebSocket by pushing every write to every
other connected client immediately - but it does NOT queue or merge
concurrent writes. A remote client editing an existing job/parameter should
listen for and apply incoming WebSocket updates (section 3) for as long
as the user has that value on screen, not just do a one-shot GET at open
time, to keep the odds of stomping a concurrent edit as low as they
already are for two browser tabs open to the same server.

## 2d. Model submissions: `/api/models*` (server side of HYDRA-UMC-EDITOR-URDF)

The server-side counterpart to [HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)'s
own `server/client.py` - lets that graphical URDF editor push a finished
robot/machine (mesh set + kinematics) straight into this server's own
catalog instead of the manual "hand-add files to `public/models/`" pass
every robot in this ecosystem's history got before this existed. Off by
default: `SystemSettings.modelSubmissions.enabled` gates all three routes
below, set from **Config > Models** in the browser UI alongside the
destination folder (relative to this server's own `data/` directory,
created automatically on first accepted submission).

- `POST /api/models/submit` (body: `{ "name", "category", "urdfFilename",
  "urdfXml", "meshFiles": [{ "filename", "base64" }, ...], "overwrite"?
  }`) - **requires an `admin` token**. `403` if model submissions aren't
  enabled server-side. Writes the URDF + every mesh file under
  `data/<destinationFolder>/<category>/<slug>/` (slug derived from
  `name`), and records the submission in `data/model_submissions.json`.
  `409` on a name collision within the same category unless `overwrite:
  true` is set - the caller decides whether to replace the existing
  model or pick a different name, this endpoint never guesses. Every
  folder/filename is resolved and re-checked against a path-traversal
  guard before any file is written.
- `GET /api/models` -> `{ "models": [{ "slug", "name", "category",
  "submittedAt", "folder" }, ...] }` - every submission recorded so far,
  regardless of which client submitted it. No auth required, matches
  this API's own GET-is-open convention.
- `GET /api/models/:category/:slug/download` -> `{ "slug", "name",
  "category", "urdfFilename", "urdfXml", "meshFiles": [{ "filename",
  "base64" }, ...] }` - the full submission bundle, base64-encoded
  inline (no auth required, but still `403` if model submissions are
  disabled server-side) - this is what lets HYDRA-UMC-EDITOR-URDF pull
  an already-submitted model back down for further editing before
  resubmitting it with `overwrite: true`.

## 3. Live sync: `WebSocket /ws`

Connect with `ws://<host>:3000/ws?token=<JWT_TOKEN>` (see section 2a for
obtaining one). The token is always mandatory - a missing or invalid one
gets an `{"error": "..."}` message followed by a close with code `1008`.
A client that sees code `1008` should treat it as "log in again," not
retry the same token in a reconnect loop; see e.g.
`HYDRA-UMC-ANDROID-CONTROL`'s own `HydraWebSocket.kt` for the reference
handling of this exact code. On connect, the server immediately sends one
message with the current full state - no separate `GET /api/settings`
call is needed just to get a first real payload:

```json
{ "type": "settings", "payload": { "settings": {...}, "controllers": [...], "activeControllerId": "..." } }
```

After that, the server pushes the same message shape to **every**
connected client (the sender included) whenever the state changes, from
**either** of these triggers:
- a `POST /api/settings` from anyone (a browser tab, another remote
  client)
- a client sending `{ "type": "settings", "payload": {...} }` **over this
  same WebSocket** - functionally identical to a REST `POST
  /api/settings`, offered as a convenience so a client that's already
  holding the socket open doesn't need a second HTTP round-trip to write
  a change. Same `admin`-only rule as the REST endpoint applies here too
  (checked against the role in the token used to open this connection) -
  an `operator` connection gets `{"error": "Access denied: admin
  privileges required"}` back instead of the write being applied.

Only one message `type` exists today (`"settings"`) - the envelope
(`{type, payload}`) is deliberately generic so a future message type
(e.g. a lighter per-robot delta, or a live telemetry stream once real
STM32H745 firmware exists to source one from) can be added without
breaking a client that already knows to ignore an unrecognized `type`.

**Client responsibility:** the server broadcasts to the sender too rather
than tracking "who sent this" (simpler server-side). A client MUST
therefore guard against re-processing its own echo as if it were a fresh
external change - see `src/store.tsx`'s own `lastPayloadJsonRef` guard
(compares the incoming payload's JSON against the last payload it itself
applied/sent, skips if identical) for the reference approach. Skipping
this guard doesn't corrupt data, but does produce a wasteful, harmless
POST/broadcast ping-pong on every single change.

## 4. What this API does NOT cover (yet)

- **CAN-OTA firmware flashing/testing** - Flasher/Tester (`src/components/Flasher.tsx`/`Tester.tsx`)
  currently run entirely client-side against a simulated transport
  (`src/lib/canOta.ts`) - there is no server-side endpoint for it, so a
  remote client can't drive a real flash/test cycle through this API today.
  Revisit once real STM32H745 firmware exists on real hardware to talk to.
- **Transport-level security** - every endpoint is plain HTTP/WS, not TLS,
  and `GET /api/settings`/`GET /api/system/metrics` still require no
  bearer token at all (only writes and account management do - see
  section 2a/2b/2c). Fine for a trusted LAN, which is this whole
  ecosystem's assumed deployment; if HYDRA-UMC SUITE's own VPN-tunnel use
  case (reaching a HYDRA-UMC on a different physical network) is ever
  exposed beyond a private tunnel, this needs real transport security
  (TLS) and a hardcoded, source-committed `JWT_SECRET` (`server.ts`)
  moved to a real per-deployment secret before that's safe.
- **A refresh/rotate token endpoint** - the only way to get a new token is
  `POST /api/login` again with the username/password; a 30-day token that
  leaks stays valid for up to 30 days with no way to revoke it short of
  changing that account's password (which invalidates nothing already
  issued - `verifyPassword` is only checked at login time, not per
  request) or deleting the account outright.

## 5. Where the server-side code lives

`server.ts` (repo root) - every route in sections 1 through 2c, the
`WebSocketServer` setup, and `broadcastSettings()`. `users.ts` (repo
root) - the account store section 2a/2b talk to (scrypt hashing, role
model, `data/users.json` persistence). `src/store.tsx`'s `HydraProvider`
and `src/components/AuthGate.tsx`/`UsersPanel.tsx` are the reference
CLIENT implementation of everything in this document - read them
alongside this file if a detail here is ambiguous, since the running code
is the actual source of truth and this document can drift.
