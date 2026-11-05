# HYDRA-UMC SERVER - Remote Control API

## Vacuum table footprint settings

STUDIO (including the web client served by SERVER) and SUITE use the existing
authenticated settings-write API for each robot's `vacuumTable`. No new endpoint
or machine command is needed. Preserve `modelId`, `customSize` and
`size: { width, length }` when relaying settings. Dimensions are millimeters.

With `customSize: true`, updated clients display the chosen STL scaled to the
configured width/length (integer 10–5000 mm; UI arrows step by 5 mm). Thickness
does not change. Missing/false `customSize` retains original catalog dimensions,
so legacy arbitrary sizes are not reinterpreted. Choosing a preset clears custom
sizing; disabling/re-enabling preserves it. Pump, valve and placement are separate.

SERVER persists these fields; it does not generate a manufacturing STL or certify
physical dimensions. Older clients may ignore the custom footprint: update both
clients before relying on matching previews. `tools/verify_robot_command_contract.mjs`
checks custom footprints through the real isolated settings API and verifies that
another robot is unchanged. Do not copy a full stale settings snapshot over a newer
one; retain the existing client synchronization rules.

## Rack STL geometry settings

Within each robot's rackSystem, rack1 and rack2 independently accept optional
width and depth (usable PCB dimensions in mm, integer 40–1000, UI step 1),
and color (#RRGGBB). Existing capacity remains 1–24; guide pitch is 10 mm.
Defaults without these fields are 160x160 mm, blue Input / green Output.
Clients render height as capacity*10+40 mm and outer footprint as
(width+20)x(depth+20) mm. STL itself does not store color.

The authenticated settings API roundtrips these fields without a new endpoint.
Geometry edits must retain usableSlots, basePickupPos, placement and the other
rack. They are visual configuration, not physical calibration or motion commands.
The isolated robot-command contract test covers three capacities and independent
robot/rack settings. Updated client builds/assets are required for visualization.

## Heated bed footprint settings

The same settings transport preserves `heatedBed.modelId` and `heatedBed.size`
(`width`, `length` in mm). Presets: `100x100x5`, `200x100x5`, `200x200x5`,
`255x255x5`; total STL height is 5 mm in all cases. Updated STUDIO/SUITE clients
allow 5 mm footprint steps (integer 25–5000 mm). Unlike vacuum tables, existing
heated-bed sizes were editable already and remain valid without a customSize flag.
Missing/unknown IDs render the 200x200 preset at the saved valid footprint.

Selecting/resizing must not change targetTemp, currentTemp1/currentTemp2,
ssrActive, placement or another robot. Reset follows the clients' existing reset
semantics and restores 200x200, target 60 and SSR off. SERVER does not generate
meshes or provide electrical/thermal certification; its hosted STUDIO requires
the rebuilt client assets to show the STL. The isolated robot-command contract
test covers all four presets and one custom size with SSR off.

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
itself is a separate project/codebase (a pure Vite/React client, see
that project's own README for why it was split out) that talks to this
same host:port like every other client below - it does NOT require a
separate process or origin to run. `build-frontend.sh`/`.bat` can build
STUDIO's static assets into this server's own `public/` directory, and
`src/server.ts` optionally serves them from `/` on this exact same
host:port (see that file's own header comment and the
`express.static(studioPublicPath)` mount) - the common "everything on
the CM5, one origin" deployment `src/lib/apiBase.ts` on the STUDIO side
already assumes by default. This is entirely optional: `public/` is
gitignored and nothing here requires it to exist - a deployment that
never runs `build-frontend` stays headless (this server serves 404s at
`/` instead of a page) and STUDIO can still be hosted as its own
separate process/origin exactly as described in its own README, talking
to this API remotely like any other client.

## Machine-readable route list

[`openapi.json`](openapi.json) is an OpenAPI 3.1 inventory of every route this
server registers: path, method and the access each one demands (public, any
signed-in user, or admin), the status codes each handler can return, and
the names of the JSON body fields and query parameters it reads. It is
generated from the source with `npm run openapi` and `npm test` fails when
it is out of date. Field types and the response bodies are not described
there - those are the sections below.

## 1. Discovery: `GET /api/hydra-info`

The response includes `schema_version: "1.0"` and conforms to the SDK v1
`ServerDiscovery` contract. `remoteApiVersion` remains the independently
versioned REST/WebSocket transport capability number; clients must check the
SDK schema version before reading the remaining discovery metadata.

For a non-destructive local integration check from a workspace containing the
sibling SDK repository, run `node tools/verify_discovery_contract.mjs`. The
tool starts Server on a temporary port and directory, validates the real HTTP
response with the SDK reference client, then stops and removes the temporary
instance.

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
an unrecognized value, is never gated here. The header is `<type>` or
`<type>/<version>` (an app adds its version, for example `android/0.7.5`, which
the history of connections keeps apart): only the type is compared, the case
and the spaces around it are ignored, and whatever follows the slash (a version,
nothing, odd characters or a very long text) neither opens nor closes the access;
with several values in one header, access is allowed only when every one is. Each field defaults to enabled
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

-> { "success": true, "token": "<JWT>", "refreshToken": "<opaque>", "role": "admin" }
```

- **Second factor (optional, per account).** Nobody has it until they turn it on, and an
  account without it signs in exactly as above. `POST /api/totp/begin` `{ "password" }` (signed in; asks for the
  password again) answers `{ "secret", "uri" }` for an authenticator app (RFC 6238, six digits, thirty seconds);
  `POST /api/totp/confirm` `{ "code" }` with the first code turns it on and answers ten one-time
  `recoveryCodes` (shown once, kept only as hashes); `GET /api/totp/status` answers
  `{ "enabled", "recoveryLeft" }`; `POST /api/totp/disable` `{ "password", "code" }` turns it off (a current code or an
  unused recovery code). From then on `POST /api/login` also needs `"totp": "<code or recovery code>"`; without it the
  answer is `401` with `{ "totpRequired": true }`, five wrong codes in a row make the next tries wait (`429` with
  `Retry-After`), and a code is accepted once. An administrator removes the factor of an account that lost the phone and the
  codes with `DELETE /api/users/:username/totp`. The secrets are kept encrypted in `data/totp.json` with a key derived
  from `HYDRA_UMC_TOTP_KEY` (or, when it is not set, from `JWT_SECRET`: changing it means enrolling again). A `viewer`
  cannot enrol, because the read-only rule refuses every write.
- Every server seeds exactly one account on its own first-ever start. In
  development and test it is `admin`/`admin`; **in production the account comes from
  `HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME`/`HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD`, and the
  server refuses to start with the example values of a deployment template, a
  password of fewer than 12 characters, or a `JWT_SECRET` that is an example
  value or has fewer than 32 characters** (see `docs/PRODUCTION_BOOTSTRAP.md`).
  Passwords of accounts created afterwards need at least 8 characters.
- Three roles: `admin` (full access - can overwrite global settings, manage
  accounts, and send robot commands), `operator` (can sign in, read
  state, and send robot commands via section 2c's atomic endpoint, but
  gets `403` from `POST /api/settings` and every route in section 2b) and
  `viewer` (read only: it reads the state, the claims, the limits, the
  camera lists and pictures and asks for a camera ticket, and gets `403`
  `{ "code": "VIEWER_READ_ONLY" }` from every call that writes - a robot command,
  the global stop included, a claim, an upload, a settings write). The
  read-only rule is decided in one place, by method, so a route added later
  is read-only for a viewer too; it uses the role the account has now, so
  demoting an account to `viewer` ends what its open session could do on the
  very next call. The role is meant for pollers and wall displays (the OPC UA
  server, a monitor). Create additional accounts of any role from Config ->
  Users (admin-only) or via section 2b directly.
- The returned token is a JWT signed server-side (`JWT_SECRET` in
  `server.ts`) carrying `{ username, role }`, valid 30 days
  (`JWT_EXPIRES_IN`).
- `refreshToken` is a separate, opaque, long-lived (90 days by default,
  `HYDRA_UMC_REFRESH_TOKEN_EXPIRES_IN`) credential - see
  `refresh_tokens.ts`. Exchange it for a fresh access token, without the
  account's password, via:
  ```
  POST /api/refresh
  { "refreshToken": "<opaque>" }

  -> { "success": true, "token": "<new JWT>", "refreshToken": "<new opaque>", "role": "admin" }
  ```
  Rotated on every use (the old `refreshToken` stops working the moment a
  new one is issued) and revoked the instant the account is deleted or its
  password/role changes (same real-time revocation guarantee an already-
  issued JWT already gets via `tokenVersion` - see `users.ts`), so a
  refresh only ever succeeds for an account whose session is still
  genuinely valid. A `401` here means a real re-login (`POST /api/login`)
  is the only way forward. `POST /api/logout { "refreshToken": "<opaque>" }`
  revokes it explicitly server-side (always `200`, even for an
  unknown/already-used token) - do this on an intentional sign-out so a
  discarded refresh token doesn't stay silently valid for the rest of its
  90-day TTL.
- A client whose token expires (or lacks a `role`
  claim - see the note below) and has no `refreshToken` on file just calls
  `POST /api/login` again.
- **A token with no `role` claim** reads as `req.user?.role === undefined`,
  so every `requireAdmin`-gated route (`POST /api/settings` included)
  rejects it with `403`. Every already-open client (this same browser tab,
  SUITE, the Android/iOS apps) needs to sign out and back in once to get a
  fresh token with a `role` claim - there is no way to upgrade an old token
  in place.
- For the WebSocket upgrade (section 3), pass the token as a subprotocol
  (`Sec-WebSocket-Protocol: hydra.bearer, <JWT>`, which keeps it out of the
  address that proxies and logs record). A token in the address
  (`ws://<host>:3000/ws?token=<JWT>`) is **refused by default** (message, then close
  `1008`); an installation with clients that have not moved yet opts back in with
  `HYDRA_UMC_WS_QUERY_TOKEN=allow` (section 2k).

## 2b. Account management: `/api/users` (admin only)

All four routes below require `Authorization: Bearer <admin token>` -
an `operator` token gets `403` from every one of them, same as from `POST
/api/settings`. See `users.ts` for the underlying scrypt-hashed,
file-backed (`data/users.json`) store.

- `GET /api/users` -> `{ "users": [{ "username", "role", "createdAt" }, ...] }`
  (never includes password hashes).
- `POST /api/users` (body: `{ "username", "password", "role" }`, role
  `"admin"`, `"operator"` or `"viewer"`) creates a new account. `400` on a duplicate
  username or a password under 4 characters.
- `PUT /api/users/:username` (body: any of `{ "newUsername", "password",
  "role" }`) renames the account, changes its password, and/or changes its
  role. Refuses to demote or delete the *last* remaining `admin` account
  (`400`) - the server would otherwise be permanently lockable-out by a
  single mistaken edit.
- `DELETE /api/users/:username` - same last-admin guard as above.

## 2c. Full state: `GET` / `PUT` / `POST /api/settings`, and the atomic `POST /api/robot/:id/command`

The same `GET`/`POST /api/settings` endpoint the web UI itself has always
used - a remote client reads and writes through this exact contract, not
a separate one.

- `GET /api/settings` returns the full current state as one JSON object:
  `{ settings: SystemSettings, controllers: HydraController[], activeControllerId: string }`
  (see `src/store.tsx` for the real TypeScript shapes - this document
  doesn't restate every field, since that would drift out of sync with
  the actual source of truth). Requires a signed-in client. The credentials of
  the IP cameras (`ipUsername`/`ipPassword`) are only in what an `admin` reads:
  an `operator` receives the same tree without them, over REST and over the
  WebSocket alike. The answer carries the revision of the tree as an `ETag`.
- `POST /api/settings` (body: the same shape) overwrites the whole thing. A
  client that sends the `ETag` it read back as `If-Match` is refused with `409`
  (`{ error, revision }`) when the tree changed in between (another administrator's
  tab, a command that moved a robot) instead of overwriting what the other one
  wrote; a client that sends no `If-Match` is saved as before. A successful save
  answers `{ success: true, revision }`.
- `PUT /api/settings` (body: the same shape) is the same save with the condition **mandatory**
  (optimistic concurrency), meant for the clients that edit the global configuration (racks, pick-and-place, catalogue,
  cameras): read `GET /api/settings`, keep its `ETag` and send it back as `If-Match`. Without `If-Match` (or with only
  `*`, which would switch the check off) the answer is `428` `{ error, code: "if_match_required", revision }`; when the tree
  is no longer the version the client read the answer is `412` `{ error, code: "settings_changed", revision }` and nothing
  is stored: read again, apply the change again, send the new `ETag`. A weak (`W/"..."`) or listed `If-Match` is
  understood. A successful save answers `{ success: true, revision }` and the new `ETag`; the refusal of a repeated robot id
  (`409`, section 2v) and the admin requirement (`403`) are the same as for `POST`. The revision covers the whole tree
  including the live state of the robots, so a `412` can also mean that a robot moved meanwhile: read again.
  **Requires an `admin` token** (`403` for `operator`) -
  this is the same full-tree write the web UI's own panels still use for
  most of their edits, so an `operator` account is effectively
  read-only inside the browser UI itself, aside from whatever already uses
  the atomic endpoint below. There is no granular
  per-field PATCH on this endpoint - a client that wants to change one
  robot's one joint angle still has to read the full state, mutate its own
  local copy, and POST the whole object back.
- `POST /api/robot/:id/command` (body: `{ "command": "jog", "params":
  { "axis": "x", "amount": 12.5 } }`) is the small-payload alternative:
  **any authenticated
  token, `admin` or `operator`**, can call it - unless a different
  account currently holds a real claim on that robot (see `claim`/
  `release` below), in which case only that account (or `"stop"`) may.
  The server computes which
  robot IDs are affected (the target plus anything `combinedWith` it)
  itself, persists to disk, and broadcasts a WS delta on its own - this is
  the primary way SUITE, the Android app, and the iOS app all write today,
  precisely because it doesn't require the admin role a full settings
  overwrite now does.

  The claim check covers every robot the command will touch: a combined
  sibling claimed by another account rejects the whole group command with
  `409` (except `"stop"`). An unknown `command` is rejected with `400`. A
  recognised command whose parameters were discarded (jog with an unknown axis
  or an amount outside +-1000, valve/pump with an index that is not an integer
  from 0 to 7 or a non-boolean state) still answers `success: true` but lists
  the discarded field in `warnings`. Only `/api/settings`, `/api/upload-work`
  and `/api/models/submit` accept large JSON bodies; every other JSON route is
  capped at 1 MB. Camera ids run from 1 to 8; any other id is rejected with
  `400`.

  A client may number its motion commands with `seq` (an integer from 1 up, growing, in the body). A
  `jog`, `table`, `joints` or `reset` whose `seq` is not above the highest one the server has seen from the same
  account and controller for that robot is refused with `409` (`stale-sequence`, with `lastSeq`) and moves
  nothing; a `seq` that is not an integer from 1 up is `400` (`invalid-sequence`). A `stop` may carry one too:
  it raises that mark, so a jog sent before the stop that arrives after it is refused. A `stop` is never
  refused for its `seq`. Without `seq` a command is handled as before. The marks are kept in memory, are
  forgotten after an hour without a command and are lost at a restart.

  `command: "reset"` (HOME / RESET) follows the rules of the jog: it needs the jog armed where `jog.armRequired`
  is on (`403`, `jog-not-armed`, for the arm and for the table), it is ordered by `seq` and it moves nothing when
  it is refused. For the arm (`target` `robot`, the default) the joints become the home pose of the model of each
  robot the command reaches, from the table the control programs share (a model that is not in it uses the
  generic pose and a range of -180 to 180 on every joint). A client may send `params.joints`, but only the home
  pose of the model is accepted: another pose is `400` (`home-pose-mismatch`), and a pose, or a home pose, with a
  joint outside its range is `422` (`home-out-of-limits`).

  `command: "trajectory"` atomically loads a Work before playback. Its
  `params` contains `points` (1 to 10,000 points, each with either finite
  `j1`–`j6` native joints or finite `x`/`y`/`z`), plus an optional safe
  `selectedWorkFile` basename ending in `.json` or `selectedExample` id. A
  model-native point may set `motionType: "model-joints"`. Points may also
  carry finite `tx`/`ty` (and optional `trz`) for an enabled XY table: these
  move the table's own axes and are never folded into the arm's `x`/`y`/`z`
  target. Such a trajectory is rejected for a robot without a configured
  table. The command applies
  only to the requested robot, clears its playback cursor and
  persists/broadcasts both the trajectory and its selected source; it
  deliberately does not replace a combined robot's independent Work.

  **The edits of one robot** are commands too, so an `operator` can make them
  without the settings tree (which only an administrator writes). Each is checked
  as a whole before anything changes and answers `400` with a `code` when a value
  is wrong; they follow the claim rule of every command except `stop`, the
  `If-Match` rule, and are persisted and broadcast as a delta that carries the
  whole top-level field they set:
  - `points` `{ "points": [ ... ] }` replaces the recorded points (0 to 10,000,
    each as in `trajectory`; an empty list clears them). `409` `robot-running`
    while the robot is playing. Unlike `trajectory` it leaves the playback cursor
    and the selected Work alone.
  - `loop` `{ "value": true }` sets `playbackState.isLooping`.
  - `model` `{ "model": "UR5e (6-DOF)" }` (1 to 64 letters, digits, spaces and
    `. _ ( ) + - /`; `409` `robot-running` while playing) and `role` `{ "role":
    "Idle" | "CNC" | "Laser" | "Pnp" | "3D printing" | "Inspection" }`.
  - `combine` `{ "with": [2, 3] }` sets `combinedWith` of this robot only (ids of
    other robots of the same controller, at most 8); the claim check covers the old
    and the new group.
  - `joints` `{ "joints": { "j1": 0, ..., "j6": 0 } }` sets the six joint values
    (finite, within +-720); it is a jog for the arming rule (`jog-not-armed` when the
    installation asks for it).
  - `xyTableConfig` `{ "enabled"?, "tableSize"?: { "width", "length" },
    "worldPos"?: { "x", "y" }, "worldRot"?, "renderScale"? }` changes the layout of
    the XY table and keeps the rest of it; the delta carries the whole `xyTable`.
  The Bluetooth service and the MQTT bridge never accept these (they stay on the
  network API).

- Safe mode of one robot (`POST /api/robot/{id}/command`, it touches only the robot it is sent to):
  - `disable` stops the robot, switches its valves and pumps off, drops the arming of its jog and
    marks it `enabled: false`. Like a stop it is open to every signed-in account, needs no claim and
    no `If-Match`, and it is recorded in the audit record (`robot-disable`). From then on every
    command of the robot except `stop`, `disable` and `enable` is refused with `423` and
    `robot-disabled`, and the robot cannot be armed (`POST /api/robot/{id}/jog-arm`).
  - `enable` brings it back and restarts nothing: it stays stopped and the jog has to be armed
    again. It is the risky direction, so it is off by default: it answers `403` with
    `enable-not-allowed` until an administrator turns on `robots.allowEnable` (Server Admin >
    Security, or `PUT /api/admin/server-config` with `{ "robots": { "allowEnable": true } }`, or
    `HYDRA_UMC_ROBOT_ALLOW_ENABLE=1`), and then only an administrator may use it (`403` with
    `admin-required` for any other role); the claim check applies as for any command but `stop`.
    Every answer is recorded in the audit record (`robot-enable`). The Bluetooth service and the
    MQTT bridge accept `disable` but never `enable`.

- `POST /api/stop-all` (no body, no confirmation) is the **global stop**: it stops
  every robot of every controller and switches every valve and pump off, in one call.
  **Any signed-in account that can write, `admin` or `operator`, may call it**; a
  `viewer` gets `403` like from every other write. A reservation never blocks it - same rule as the
  per-robot `"stop"`: the robots reserved by another account are stopped too, and
  each such entry carries `reservedBy`, while the reservation itself is left untouched.
  The in-memory state changes and the playback timers stop before anything is
  written, then the settings are saved and one WebSocket delta per robot is
  broadcast. Answer `200`:
  `{ "success": true, "stoppedCount": 3, "failedCount": 0, "persisted": true, "announced"?: true, "robots": [ { "robotId": 1, "controllerId": "c1", "name": "A1", "stopped": true, "valvesOff": 2, "pumpsOff": 1, "reservedBy"?: "bob", "error"?: "..." } ] }`.
  `valvesOff`/`pumpsOff` count the outputs that were on. A robot that could not be stopped
  has `stopped: false` and an `error`, the others are still stopped, and `success` is
  `false`; `persisted: false` means the stop is applied and broadcast but the settings
  file could not be written. Calling it again is harmless; an installation with no robots
  answers `200` with an empty list. `401`/`403` for a missing or invalid token. Every call is written to
  the server log (who, role, address, counts) and counted in
  `hydra_robot_commands_total{command="stop-all"}`. It has its own rate limit,
  separate from the login's and much higher (default 60 per minute per address,
  `STOP_ALL_RATE_LIMIT_MAX` / `STOP_ALL_RATE_LIMIT_WINDOW_MS`); over it the answer is
  `429` and the per-robot `"stop"` keeps working. Unsigned calls do not spend the budget.

- `POST /api/robot/:id/claim` (body: `{ "ttlMs"?: number, "force"?: boolean, "reason"?: string }`,
  default `ttlMs` 5 minutes, capped at 30) and `POST /api/robot/:id/release`
  (body: `{ "reason"?: string }`) give one authenticated **account** (never
  a per-tab/per-device identity - this server has no concept of one) real,
  TTL-bounded exclusive command ownership of a robot. Once claimed,
  `POST /api/robot/:id/command` from a *different* account is rejected
  `409` (with the current `reservation` in the body) for every command
  except `"stop"`, which is a deliberate safety exception and is never
  blockable by someone else's claim, real or stale. Re-claiming your own
  already-held robot refreshes its TTL - this is how a real client keeps
  a long session alive rather than losing the claim mid-use. `release`
  is idempotent (releasing an unclaimed/expired robot succeeds, it never
  errors) and refuses a non-holder unless that caller is `admin`; an
  `admin` may also force-override someone else's still-active claim with
  `force: true`. A claim that simply expires (its holder never released
  it) is never treated as still-locked - an interruption in ownership
  must never look like a permanent one. The current `reservation` (or
  `null`) is a real field on the robot object itself, so it round-trips
  through the same `GET /api/settings` response and WebSocket delta
  every other robot field already does - no separate endpoint to poll.

  Every real transition also appends to `reservationHistory`, a
  bounded (last 20) array living on the same robot object, also returned
  directly by `claim`/`release` and broadcast in their own delta - so a
  client never has to poll settings separately to see it. Each entry is
  `{ at, action, byUserId, byUsername, reason? }`, where `action` is one
  of `"claimed"`, `"renewed"` (re-claiming your own already-held robot),
  `"force-claimed"`, `"released"`, `"force-released"`, or `"expired"`
  (a claim that lapsed on its own, recorded the moment it's superseded by
  a fresh claim or lazily released) - so an operator can tell *why*
  ownership changed, not just that it did. The optional `reason` on
  `claim`/`release` (trimmed, capped at 200 characters) is carried
  straight into its own history entry when supplied.

  **Which controller holds it (block 1 of contract v2).** `claim` and
  `release` also take an optional `controllerId` (body, or the
  `X-Controller-Id` header): 1 to 64 characters of letters, digits and
  `. _ : -`, chosen by one control client (a window, a tab, a phone) and kept for
  its session. The claim then belongs to that account **and** that controller:
  the same account on another controller is refused like another account,
  `409` with a `code` of `other-controller`, and a command or a `release`
  that sends no controller id while the claim has one gets
  `controller-id-required`. Another account gets `other-account`. The three
  codes come back in the body next to `error` and `reservation`. A claim made
  without a controller id behaves exactly as before, and re-claiming with
  one adds it to your own claim. `stop` and `POST /api/stop-all` stay exempt.
  A malformed id is `400` (`invalid-controller-id`). The `controllerId` of the
  robot deltas and of the settings tree names a cell, not a client; the claim
  listing calls that one `cellId`. An administrator can make the controller id
  mandatory for `claim` (`claims.requireControllerId`, below).
  `GET /api/claims` (any signed-in account) lists every active claim:
  `{ claims: [{ robotId, robotName, cellId, ownerId, ownerUsername,
  controllerId, claimedAt, expiresAt }] }`.

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
  "urdfXml", "meshFiles": [{ "filename", "base64" }, ...], "overwrite"?,
  "attribution"? }`) - **requires an `admin` token**. `403` if model submissions aren't
  enabled server-side. Writes the URDF + every mesh file under
  `data/<destinationFolder>/<category>/<slug>/` (slug derived from
  `name`), and records the submission in `data/model_submissions.json`.
  `409` on a name collision within the same category unless `overwrite:
  true` is set - the caller decides whether to replace the existing
  model or pick a different name, this endpoint never guesses. Every
  folder/filename is resolved and re-checked against a path-traversal
  guard before any file is written. Every attempt is recorded in the audit
  record (`GET /api/audit`) as `model-submit` with the account, the address and
  `detail` = `{ name, category, replaces, meshFiles }` (a refusal carries
  `detail.reason`); the model itself is never recorded. `attribution` is the licence and credit of the
  model as text (at most 8000 characters, `400` above that or when it is not text): it is kept in the index, beside the model as
  `ATTRIBUTION.txt` and in the answer of the download route, and the audit record only counts its characters (`attributionChars`).
  With `modelSubmissions.requireAttribution` on (Config > Models, off by default) a submission without it is refused with `400`.
- `GET /api/models` -> `{ "models": [{ "slug", "name", "category",
  "submittedAt", "folder", "attribution"? }, ...] }` - every submission recorded so far,
  regardless of which client submitted it. No auth required, matches
  this API's own GET-is-open convention.
- `GET /api/models/:category/:slug/download` -> `{ "slug", "name",
  "category", "urdfFilename", "urdfXml", "meshFiles": [{ "filename",
  "base64" }, ...], "attribution"? }` - the full submission bundle, base64-encoded
  inline (no auth required, but still `403` if model submissions are
  disabled server-side) - this is what lets HYDRA-UMC-EDITOR-URDF pull
  an already-submitted model back down for further editing before
  resubmitting it with `overwrite: true`.

## 2e. Admin operations: `/api/admin/*`

All four routes below require `Authorization: Bearer <admin token>` -
same `403`-for-`operator` posture as section 2b. These back the admin
UI's own Clients/Logs/Config screens, not the main Dashboard.

- `GET /api/admin/clients` -> `{ "clients": [{ ...connection metadata,
  "connected": <bool> }, ...] }` - every currently-tracked WebSocket
  client (see section 3), each entry's own metadata plus whether its
  socket is still actually open right now.
- `GET /api/admin/logs?lines=<n>` -> `{ "lines": ["<log line>", ...] }` -
  the tail of the real on-disk log file (`industrialLog()`'s own
  target), most recent last. `lines` defaults to `300`, capped at `2000`;
  returns `{ "lines": [] }` (not an error) on a fresh install with no log
  file yet. A full-file read on every call - fine for a periodically
  polled admin viewer, not meant for tailing a huge file.
- `GET /api/admin/server-config` -> `{ "port": <int>, "pendingPort":
  <int|null>, "aiAccess": { "value": "open"|"admin", "source":
  "env"|"config"|"default" }, "infoAuth": { "value": <bool>, "source": ... },
  "tls": { "enabled", "source", "certPath", "keyPath", "fingerprint256",
  "active", "appliesOnRestart" }, "ble": { "mode": { "value": "off"|"state"|"commands",
  "source": ... }, "requireEncryption": { "value": <bool>, "source": ... },
  "activeMode", "appliesOnRestart" } }` - `port` is what this process is
  actually listening on right now; `pendingPort` is a saved-but-not-yet-applied
  change (see `PUT` below). `source` says where the value comes from: the
  environment of the deployment (it wins and cannot be changed here), what an
  administrator saved, or the default. `fingerprint256` is the SHA-256
  fingerprint of the certificate in use (what a client pins); `active` says
  whether the running listener is TLS.
- `PUT /api/admin/server-config` (body: `{ "port"?, "aiAccess"?, "infoAuth"?,
  "tls"?, "ble"? }`) - `aiAccess` is `"open"` (any signed-in user, the default) or
  `"admin"` for `/api/ai/*`; `infoAuth` is a boolean for the sign-in
  requirement of the host information (the response carries `warnings:
  ["info_auth_off"]` when it is turned off, and the server log records who did
  it); `tls` is `{ "enabled", "certPath", "keyPath" }` and is checked (both
  files readable and usable together) before it is saved; `ble` is `{ "mode",
  "requireEncryption" }`, the Bluetooth LE service (see `docs/BLE_GATT.md`:
  `"off"` by default, `"state"`, `"commands"`; the encrypted link is required
  by default, and `warnings: ["ble_commands_unencrypted"]` comes back when
  commands are allowed without it). `409` when the
  value is fixed by the environment, `400` for a bad value. `aiAccess` and
  `infoAuth` apply at once, `tls` and `ble` on the next start. `voice` is
  `{ "includeHeardText", "minConfidence" }` (the transcript in a voice reply,
  off by default, and the least confidence, 0 to 1, default 0.6, before a spoken
  request that starts a movement is accepted; 0 switches the check off) and
  applies on the next voice turn: `POST /api/voice/turn` sends the saved values
  to HYDRA-UMC-VOICE-UI as `options` of the turn (an `options` sent by the client
  is replaced), and the environment of the voice service still wins. `mavlink`
  is `{ "signingKeyFile", "signingAllowUnsigned" }` (the path of the MAVLink 2
  signing key file, checked to hold 32 bytes or 64 hexadecimal characters and never
  returned or logged as a key; empty means no signing; and whether unsigned
  messages are still accepted, off by default): HYDRA-UMC-BRIDGE-UAV reads it
  from `data/server-config.json` (`--server-config`) when it starts. The answer
  carries `voice` and `mavlink` the same way as the other options, with the
  warnings `voice_heard_text_on`, `voice_confidence_off`, `mavlink_unsigned_allowed`
  and `mavlink_signing_off`. The `port` part saves
  a new listen port to disk. `400` if `port` isn't an integer in `1-65535`.
  **Does not take effect until the process restarts** (see
  `POST /api/admin/restart` below) - the response is `{ "success": true,
  "appliesOnRestart": true }`, never a live port change.
- `POST /api/admin/restart` -> `{ "success": true }`, sent *before* the
  process calls `process.exit(0)` a quarter-second later, so the admin
  UI's own request doesn't see a connection-reset instead of a clean
  `200`. Only meaningful behind a process supervisor that auto-restarts
  on exit (systemd `Restart=always`, pm2, Docker `--restart`) - under
  `npm run dev` this just stops the server.

## 2f. Voice relay and Watch health cards

Both endpoints require a normal bearer token. They are deliberately separate
from `/api/robot/:id/command`: voice may ask for an action but it can never
turn into an actuator call on this route.

- `POST /api/voice/turn` accepts a bounded `voice_turn` object and relays it
  to the locally configured HYDRA-UMC-VOICE-UI gateway. The Server owns the
  Voice UI token, so Android and Watch clients never receive it. It returns a
  validated `assistant_reply`, or `503` when Voice UI is not configured or
  unavailable. A motion-related reply has `requiresConfirmation: true`.
- `POST /api/voice/confirm` takes `{ "confirmationToken" }` (the token of an
  `assistant_reply` with `requiresConfirmation: true`) and relays it to the
  Voice UI **for the signed-in user**: the `subject` is the session's username,
  never something the client sends (a `subject` in the body of `/api/voice/turn`
  is replaced the same way), and the Voice UI confirms a token only for the
  subject it was issued to. The answer is the `confirmation_result` of the Voice
  UI plus `verified`. A `confirmed` result is believed only when it names that
  same user and, with `HYDRA_UMC_VOICE_UI_RESULT_KEY` set (the key the Voice UI
  signs with), its HMAC-SHA256 `signature` verifies (`verified: true`); a
  wrong subject or a bad signature is `502`. Without the key the result is
  passed on with `verified: false`, and `HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE=1`
  answers `503` instead. `expired` and `invalid` results are relayed as they are.
  The route executes nothing; who confirmed what is written to the industrial
  log by request id and user, never the token or the transcript.
- `GET /api/watch/system-status` returns a small authenticated
  `system_status` health card with CPU, memory and uptime. It intentionally
  excludes full settings, credentials and filesystem paths.

The Server reads `HYDRA_UMC_VOICE_UI_URL`,
`HYDRA_UMC_VOICE_UI_TOKEN` and the bounded timeout
`HYDRA_UMC_VOICE_UI_TIMEOUT_MS` only from its runtime environment. In a CM5
deployment, keep Voice UI on `127.0.0.1:8091` and do not expose its port.

## 2g. Monitoring, camera & file upload

- `GET /api/system/metrics` -> `{ "cpu_load", "memory_usage", "temp"
  (number or `null`), "temp_is_real" (bool), "uptime", "network": {
  "wifi", "ethernet", "bluetooth" (each bool) } }` - powers the Dashboard's
  own status footer (CPU/memory/temp/network). `temp`/`temp_is_real` come
  from a real `vcgencmd measure_temp` read on a CM5/Pi host; on any other
  OS the command isn't found and this falls back to a clearly-marked
  mock value (`temp_is_real: false`) rather than silently lying. No auth
  required, unless the installation sets `HYDRA_UMC_INFO_AUTH=required` (see
  section 2k).
- `GET /metrics` - a Prometheus text-exposition scrape endpoint
  (`prom-client`, metric definitions in `src/metrics.ts`), including the
  same `hydra_system_*` gauges `/api/system/metrics` reports as JSON, from
  the identical underlying read. Deliberately unauthenticated, same
  trusted-LAN posture as every other unauthenticated `GET` in this
  document - see section 4 before exposing this server beyond a LAN.
- `POST /api/camera/ticket` (signed-in client) -> `{ ticket, expiresInSeconds }`: a
  five-minute ticket that a picture's address carries (`?ticket=...`), because an
  `<img>` or `<video>` cannot send an `Authorization` header. It opens the live
  streams and the saved photos and recordings, and nothing else (section 2k).
- `GET /api/camera/:id/stream` - an MJPEG multipart stream
  (`multipart/x-mixed-replace`). **Currently a placeholder**: no real
  camera/`libcamera`/`ffmpeg` pipe exists yet, so this sends a fixed
  "camera offline" placeholder frame every 100ms rather than real video -
  wired up this way so the Android app's video surface has a real,
  spec-shaped stream to render against before a real camera pipeline
  lands. No auth required.
- `POST /api/upload-work` (body: `{ "folderPath", "fileName", "content" }`)
  - **any authenticated token, `admin` or `operator`**. Writes `content`
  as JSON under `data/<folderPath>/<fileName>` (creating the folder if
  needed) and appends `fileName` to that folder's own `index.json`. Real
  path-traversal hardening: `folderPath` has `..` stripped and the
  resolved path is checked to still sit inside the server's own `data/`
  directory (`403` if not); `fileName` is reduced to `path.basename()` so
  it can't smuggle a directory component; and the 3 reserved filenames
  (`settings.json`, `users.json`, `model_submissions.json` -
  `RESERVED_DATA_FILENAMES` in `server.ts`) are always rejected (`403`)
  regardless of `folderPath`, closing a real privilege-escalation path an
  `operator` token could otherwise use to overwrite the account store or
  global settings from this non-admin-gated route. `400` if `folderPath`/
  `fileName` aren't strings or `fileName` resolves to an empty/`.`/`..`
  basename; `500` with `{ "error": <message> }` on an unexpected write
  failure.

## 2h. Hardware bridge: real CM5<->STM32H745 SPI-OTA relay

Relays to the local `spi_bridge` HTTP service
(`HYDRA-UMC/src/cm5_host/spi_bridge/`) - the real SPI1 + `HYDRA_DATA_READY`
GPIO link to the STM32H745 "Kinematic Brain", the same link
`HYDRA-UMC-STUDIO`'s Flasher/Tester read once `settings.canOta.transport
=== 'hardware'` (previously always `'mock'`). Both routes answer `503`
when `HYDRA_UMC_SPI_BRIDGE_URL` is unset, the same "never a guessed
process" posture as the Voice UI relay above.

- `GET /api/hardware/canota/version?tier=&slot=&relay=` - any authenticated
  token. Relays to `spi_bridge`'s own `GET /version`, returning
  `{ "online", "is_bootloader", "hardware_id", "firmware_major",
  "firmware_minor" }`. `relay=1` tunnels through the resolved Tier 0/1
  target to reach Tier 2 (the URTC Tool Head) - see `spi_bridge`'s own
  `relay_tunnel.py`.
- `POST /api/hardware/canota/flash?tier=&slot=&relay=&hardware_id=&version_major=&version_minor=[&version_patch=][&downgrade_from=x.y.z][&signature=HEX]`
  - **`admin` only** (unlike the read-only version query above - writing
  firmware is exactly the kind of action every other bridge in this
  ecosystem gates more tightly than a read). Body: raw firmware bytes,
  `Content-Type: application/octet-stream`. The real, per-page flash
  progress is **not** returned in this HTTP response - it is sent
  live to every connected `admin` WebSocket client as `{ "type":
  "canota_progress", "payload": { "phase", "pages_sent", "pages_total",
  "percent", "error" } }` while the flash is in progress (see section 3).
  This response only reports the final outcome once the cycle ends:
  `{ "success": bool, "finalPhase" }`. The bootloaders of the HYDRA-UMC boards
  accept an image only with the Ed25519 signature of its header and bytes, made
  where the private key is (`tools/image_header.py sign` in HYDRA-UMC): the
  request carries it as `signature` (128 hexadecimal digits), the patch of the
  version as `version_patch`, and an older image than the installed one also
  `downgrade_from` (the installed `major.minor.patch`). The server checks the
  shape of the three (`400` `invalid-flash-signature` otherwise) and hands them on; it
  holds no key.

The Server reads `HYDRA_UMC_SPI_BRIDGE_URL`,
`HYDRA_UMC_SPI_BRIDGE_TIMEOUT_MS` (version query, default 4000ms) and
`HYDRA_UMC_SPI_BRIDGE_FLASH_TIMEOUT_MS` (flash cycle, default 120000ms -
much longer, a real page-by-page transfer+verify genuinely takes a while)
only from its runtime environment. Keep `spi_bridge` on loopback in a CM5
deployment, same as Voice UI.

## 2i. Ecosystem status & per-project service control

- `GET /api/ecosystem/status` - no auth required (same trust tier as
  `/api/system/metrics` above: local directory names and manifest
  fields, nothing about credentials). Returns
  `{ "available", "scannedAt", "projects": [...] }`. Each project comes
  from a real, synchronous scan of `hydra-umc.project.json` manifests
  under this repo's own parent directory (or `HYDRA_UMC_ECOSYSTEM_ROOT`
  if set - a real CM5 deployment needs this, since its own
  `WorkingDirectory`'s parent holds only build artifacts, not full
  checkouts with manifests), plus real, concurrent probes for whichever
  ones opt in: a manifest's own `service.port`/`service.health_path`
  gets a real TCP/HTTP probe (`live: true|false`, `serviceHost`); a
  manifest's own `service.systemd_unit` gets a real
  `systemctl show <unit>` probe (`pid`, `activeState`, `subState`) -
  independent signals, a project can have either, both, or neither.
- `POST /api/ecosystem/service/:unit/:action` (`action` one of
  `start`/`stop`/`restart`) - **`admin` only**. Backs the Ecosystem >
  Services panel's per-project controls. `:unit` is never trusted from
  the request - it must match a `systemdUnit` a **fresh**
  `getEcosystemStatus()` scan actually returns right now, and this
  server's own unit (`hydra-umc-server.service`) is refused
  unconditionally (`403`) - a self-restart already has its own route
  (`POST /api/admin/restart` above). `400` for an unrecognized action,
  `404` if `:unit` isn't a currently known project unit. Even a
  validated request only actually works with a real, narrowly-scoped
  polkit rule installed on the host -
  `HYDRA-UMC-OS/provisioning/polkit/50-hydra-umc-server-service-control.rules`
  (installed by that repo's own `provisioning/install_server.sh`),
  granting the unprivileged `hydra-umc-server` account start/stop/
  restart for exactly the `hydra-umc-*.service` namespace, nothing else
  on the host. Without that rule, `systemctl` itself refuses the call
  and this answers a clean `503` rather than a silent no-op.

## 2j. Adapter catalog: `GET /api/adapters`, `GET /api/adapters/:adapterId`

A real, authenticated read-only proxy to HYDRA-UMC-CONNECTOR-HUB's own
`serve-catalog` (Python, GET-only `http.server` - see that project's own
`catalog_server.py`). This is the Server's own real consumer of the adapter
catalog: it never re-implements the manifest scan, and it never gains a way
to invoke a capability through this route (that stays CONNECTOR-HUB's own,
separately-gated `sdk_gate.py`/`gate` CLI command).

- `GET /api/adapters` returns the real catalog:
  `{ "adapters": [...summaries], "invalidFiles": {...} }`. Each summary has
  `adapterId`, `protocol`, `targetKinds`, `ownerProject`, `sdkCompatibility`,
  `idempotency`, `capabilities` (name/mode only) and `sourcePath` -
  deliberately smaller than the full manifest.
- `GET /api/adapters/:adapterId` returns that one adapter's real full
  manifest (including `endpointSchema`/`evidenceSchema` and each
  capability's full `requiredPermission`/`requiredCellState`/
  `requiresHumanConfirmation`/`requiredSafetyGates`), or CONNECTOR-HUB's own
  real `404` passed straight through for an unknown id. A malformed
  `adapterId` (anything outside `[A-Za-z0-9][A-Za-z0-9_-]*`) is rejected
  with the Server's own `400` before it ever becomes a path segment of the
  outbound request - the same charset CONNECTOR-HUB's own `schema.py`
  requires of a real `adapterId`.

Both routes return `503` with `available: false` when
`HYDRA_UMC_CONNECTOR_HUB_URL` is not set on this Server. There is no token
of its own to hold here - the catalog is read-only manifest metadata, and
`authenticationRef` in a manifest is always a reference, never the
credential itself.

### The decision gate of the hub: `POST /api/connector-hub/gate/evaluate`, `GET /api/connector-hub/gate/audit`

A relay to the `serve-gate` of the same hub (another port than the catalog) that carries the identity of the person who is signed in.
The hub only believes a token this server issued (EdDSA with the public key set of `GET /.well-known/jwks.json`, or HS256 while the
hub still accepts it), so the relay forwards the `Authorization` header as it came and adds nothing of its own; the hub decides and
records who asked (`caller`). A denial of the gate is a `200` with `allowed: false`; a refusal of the hub (`401`, `403`, `503`) is
passed on with its own body.

- `POST /api/connector-hub/gate/evaluate` (operator or administrator): the body is the JSON object the hub documents for
  `/gate/evaluate` (`adapterId`, `capability`, `jobId`, `source` and the optional fields). A body that is not an object is a `400` here.
- `GET /api/connector-hub/gate/audit` (any signed-in account; the hub refuses a role that may not read it): the head of the chain and
  the newest decisions.

Both answer `503` with `available: false` while `HYDRA_UMC_CONNECTOR_HUB_GATE_URL` is not set (off by default). The keys the hub verifies
with stay in the configuration file of the hub; the one switch that can be edited from here is described next.

### The switch for a caller with no identity: `GET /api/connector-hub/gate/settings`, `POST /api/connector-hub/gate/settings`

The hub can answer a caller on its own machine that has no token, but only when its switch `allowLoopbackNoIdentity` is on, and it is
**off by default**. STUDIO shows and edits that switch through these two routes, which carry the administrator's own `Authorization`
header to the hub, so the hub still decides and records who asked.

- `GET /api/connector-hub/gate/settings` (any signed-in account): `allowLoopbackNoIdentity`, `loopbackSwitchAllowed` (the hub listens on a
  loopback address, the only place the switch may be on), `verifiesTokens` and `persisted` (the hub has a settings file to write to).
- `POST /api/connector-hub/gate/settings` (administrator only): the body is `{"allowLoopbackNoIdentity": true|false, "confirm": true}`
  and nothing else. Turning the switch **on** needs `confirm: true` (`400` with `code: CONFIRMATION_REQUIRED` otherwise, and nothing
  leaves this server); turning it off needs no confirmation. The hub answers `200` with the new state and `changed`, or refuses (`401`,
  `403`, `409` when the state is not allowed, `503` when the change could not be recorded and was undone), and that answer is passed on.
  The hub writes the change to its settings file and to its own audit chain; this server also writes the attempt and its outcome to its
  audit record (`connector-hub-gate-settings`, with who asked, from which address, the value and the status of the hub).

Both answer `503` with `available: false` while `HYDRA_UMC_CONNECTOR_HUB_GATE_URL` is not set.

### The identity of the approval of a plan: `GET /api/semantic-planner/settings`, `POST /api/semantic-planner/settings`

The semantic planner releases a plan only when the person who approves it is signed in with the token of this server
(`plan_approval.require_identity`, **true by default**). STUDIO shows and edits that switch through these two routes, which carry the
administrator's own `Authorization` header to the planner (`HYDRA_UMC_SEMANTIC_PLANNER_URL`), so the planner still decides and prints who asked.

- `GET /api/semantic-planner/settings` (any signed-in account): `requireIdentity`, `verifiesTokens` (the planner has the identity key; without
  it nothing can be changed) and `persisted` (the planner has a configuration file to write to).
- `POST /api/semantic-planner/settings` (administrator only): the body is `{"requireIdentity": true|false, "confirm": true}` and nothing else.
  **Relaxing** it (`false`) needs `confirm: true` (`400` with `code: CONFIRMATION_REQUIRED` otherwise, and nothing leaves this server);
  tightening it again needs no confirmation. The planner answers `200` with the new state and `changed`, or refuses (`401`, `403`, `409` with
  `code: SETTING_REFUSED` when the file cannot be written), and that answer is passed on. This server also writes the attempt and its
  outcome to its audit record (`semantic-planner-settings`, with who asked, from which address, the value and the status of the planner).

Both answer `503` with `available: false` while `HYDRA_UMC_SEMANTIC_PLANNER_URL` is not set (off by default).

### The identity of this server in its calls to the services: `GET /api/admin/service-identity`

A service whose identity key is on (see `docs/SERVER_IDENTITY.md` of HYDRA-UMC-OS) refuses any request with no credential, even from this
machine. This server is the caller of most of them (the status scan and health probes of the family, the relays to the AI, data and speech
services, the stop relay, the takeover, the reload of the job dispatcher), so it can present one short token of its own on every one of
those calls: HS256, signed with `JWT_SECRET`, valid sixty seconds, with the claims `username` (`hydra-umc-server`), `role` (a read is a
`viewer`, a change an `operator`, the administration calls an `admin`) and `exp`. A service that has a token of its own keeps receiving
that one. It is **off by default** and then no call changes.

- The switch is `auth.serviceIdentity.enabled` of `PUT /api/admin/server-config` (administrator only), or the environment word
  `HYDRA_UMC_SERVICE_IDENTITY` (`1` on, `0` off; the environment locks the switch and the change answers `409`). The body is
  `{"auth": {"serviceIdentity": {"enabled": true, "confirm": true}}}`: turning it **on** needs `confirm: true` (`400` otherwise, nothing is
  saved); turning it off needs no confirmation. The answer carries the warning `service_identity_on` or `service_identity_off`, and the
  attempt and its outcome are written to the audit record (`service-identity-options`).
- `GET /api/admin/service-identity` (administrator only) answers the state: `enabled`, `source` (`env`, `config`, `default`), `locked`,
  `key` (`usable`, or `unusable` when `JWT_SECRET` is unset, an example value or too short, and then nothing is signed), `state`
  (`presenting`, `idle_no_key`, `off`), `services` (each with `support`: `accepts` the shared verifier, `own_verifier`, or `not_yet`) and
  `order`, the codes of the safe order of the steps. The key is never in the answer.
- **The safe order.** Turn this switch on first, so that the server presents its token; then give the key to the services one by one
  with `provisioning/service_identity.py --enable NAME --apply` of HYDRA-UMC-OS (as root on the machine, which this API never does),
  restart that unit, and check it with `--status`. Turning the key on in a service before the server presents its token makes the service
  refuse the server.

### What the sibling services hand to the server: scenario outcomes, the developer node status and the faults

The server keeps the state of three feeds so the services that produce them keep none of their own. Each feed is off (every route answers `404`) until its switch is `1` in the environment. Everything accepted is written to a signed record chained by hashes (`data/ingest/*.jsonl`): each entry carries the hash of the one before it and an HMAC-SHA256 signature made with the key of the server, so a changed, removed or forged entry is found by the `verify=1` read. Old entries are dropped by age and by count; the retention is set per feed with `HYDRA_UMC_INGEST_<FEED>_RETENTION_DAYS` (default 30, `0` = no limit) and `HYDRA_UMC_INGEST_<FEED>_RETENTION_RECORDS` (default 5000, `0` = no limit), where `<FEED>` is `SCENARIO_OUTCOMES`, `DEVELOPER_NODE` or `FAULTS`. When `JWT_SECRET` cannot sign (unset, an example value, too short) nothing is written and a write answers `503`.

- `POST /api/ingest/scenario-outcome` (operator or administrator; switch `HYDRA_UMC_INGEST_SCENARIO`): the body is a `ScenarioOutcome` of the shared contract (schema version `1.0`). `201 {"seq", "hash"}`, `400` with the reason when it does not fit the contract or is larger than 64 KiB. Every attempt is written to the audit record (`ingest-scenario`).
- `GET /api/ingest/scenario-outcomes?limit=&scenario_id=&verify=1` (any signed-in account): the newest entries first; `verify=1` adds the result of checking the chain.
- `POST /api/ingest/developer-node/status` (switch `HYDRA_UMC_INGEST_DEVELOPER_NODE`): the body is `developer-node-status/1`. It does not take a user account: the developer node sends the token of that node as `Authorization: Bearer <token>` (and may name itself in `X-Node-Id`, which must match). The tokens are listed in the file named by `HYDRA_UMC_DEVELOPER_NODE_TOKENS_FILE`, `{"nodes": {"<node id>": "<sha256 hex of the token>"}}`; only the hash is stored, and the file is read on every call. `401` for no token, an unknown one, a node name that is not the owner of the token, or while the feed is off; `403` over plain HTTP (HTTPS is required; a request that never left this machine or that a reverse proxy marks `X-Forwarded-Proto: https` is accepted, and `HYDRA_UMC_INGEST_ALLOW_HTTP=1` allows plain HTTP on a bench); `400` for a document that does not fit; `201 {"node_id", "seq"}`.
- `GET /api/developer-node/status?verify=1` (any signed-in account): the latest status of each node.
- `GET /api/faults?limit=&active=1&verify=1` (any signed-in account; switch `HYDRA_UMC_FAULT_FEED`): the faults that are raised and not cleared (`active`) and the recent history (`recent`, left out with `active=1`). The server reads `fault-event/1` messages from the broker of the MQTT settings (read only; topic `hydra/faults/#`, or `HYDRA_UMC_FAULT_FEED_TOPIC`). A `fault-event/1` is `{"schema": "fault-event/1", "source", "robot_id"?, "code", "severity": "info"|"warning"|"error"|"critical", "text"?, "state": "raised"|"cleared"}`; anything else on the topic is ignored. The active set is rebuilt from the record on start.

### The anomaly verdicts, the signed record of the voice commands and the check of a signed proposal

Three more routes, each off (every route answers `404`) until its switch is `1` in the environment. None of them moves hardware.

- `GET /api/anomaly/verdicts?verdict=&verify=1` (any signed-in account; switch `HYDRA_UMC_ANOMALY_FEED`): the latest verdict of every series of the anomaly detector. The server reads the retained `anomaly-verdict/1` messages from the broker of the MQTT settings (read only; topic `hydra/anomaly/verdict/#`, or `HYDRA_UMC_ANOMALY_FEED_TOPIC`). An `anomaly-verdict/1` is `{"schema": "anomaly-verdict/1", "source_id", "kind", "field", "verdict": "normal"|"suspect"|"anomalous", "score", "threshold"?, "model_version"?, "timestamp"?}`; anything else on the topic is ignored. Only a change of verdict is written to the signed record (`data/ingest/anomaly.jsonl`, retention `HYDRA_UMC_INGEST_ANOMALY_RETENTION_DAYS` and `_RECORDS`), and the latest verdicts are rebuilt from it on start. `verdict=` narrows the answer to one verdict (`400` for another word); `verify=1` adds the result of checking the chain. With `HYDRA_UMC_ANOMALY_VOICE_RELAY=1` and the voice interface configured, a verdict that changes to `suspect` or `anomalous` is told to it (`POST /v1/voice/alert`, in the language of `HYDRA_UMC_ANOMALY_VOICE_LOCALE`, `en` by default) and its answer (the sentence code and whether it is to be said now) is kept in the `alert` field of that verdict; a `normal` verdict is never spoken. The same verdicts answer a spoken question ("how is motor 3?", in the eight languages): in `POST /api/voice/turn`, a reply whose intent is `query_node` gets its text from the latest verdict of that node (the worst of its series; names are compared without spaces, dashes or capitals), in the language of the client, with `messageCode: "node_state"` and `messageParams` `{node, state}` (`normal`, `suspect`, `anomalous`, `unknown`, or `off` when the feed is not switched on).
- `GET /api/voice/chain?limit=&verify=1` (administrator; switch `HYDRA_UMC_VOICE_CHAIN`): the voice commands that passed through this server, newest first. Every turn (`POST /api/voice/turn`) and every confirmation (`POST /api/voice/confirm`) becomes one entry of a record signed with the key of the server and chained by hash to the entry before it (`data/ingest/voice.jsonl`, retention `HYDRA_UMC_INGEST_VOICE_RETENTION_DAYS` and `_RECORDS`). An entry holds `event`, `request_id`, `intent`, `level`, `requires_confirmation`, `status` and `subject` (a short keyed hash of the person); it never holds the transcript, the reply text, audio, locale or address. Writing never stops a voice command. `verify=1` adds the result of checking the chain.
- `POST /api/trajectory/proposals/verify` (operator or administrator; switch `HYDRA_UMC_PROPOSAL_VERIFY`): body `{"proposal": {...}, "expected_robot_id": "...", "expected_model_version"?: "...", "expected_instruction_sha256"?: "..."}`. The proposal is the one the trajectory engine signs with Ed25519 (`signature_alg: "ed25519"`, `key_id`, `signature`, `robot_id`, `issued_at_ms`, `expires_at_ms`, and `model_version` and `instruction_sha256` when given). The server holds only public keys, listed by key id (the first eight bytes of the SHA-512 of the key) in the file named by `HYDRA_UMC_PROPOSAL_KEYS_FILE`, `{"keys": {"<key id>": "<public key, 64 hex>"}}`; an entry whose id is not the id of its key is left out. `200 {"valid", "reason", "key_id"}`: `valid` is true only when the key is listed, the signature matches, the time window is acceptable and current, and the robot (and the model and instruction when asked) are the expected ones. `400` for a body that does not fit, `503` when no key is listed. Every check is written to the audit record (`proposal-verify`). It answers a fact about the proposal; it is never an order.

### The proposals of the node watchdog: `GET /api/ops-agent/proposals`, `POST /api/ops-agent/proposals/decide`

The node watchdog (HYDRA-UMC-OPS-AGENT) leaves each incident proposal it receives waiting for a person. These two routes list them and let an
administrator approve or reject one. They speak to the watchdog over its authenticated channel (`incident-transport/1`: HMAC-SHA256 over the
canonical JSON of the message with the shared secret of the sending node, a nonce, a time window and the contract version), the same wire
format its `edge` role verifies; this server only accepts a reply that is signed by the watchdog, addressed to it, fresh and with a new nonce.

- `GET /api/ops-agent/proposals` (administrator only): `{"pending": [...], "decided": [...]}` as the watchdog keeps them.
- `POST /api/ops-agent/proposals/decide` (administrator only): the body is `{"incidentId": "...", "decision": "approved"|"rejected", "confirm": true}`
  and nothing else. **Approving** needs `confirm: true` (`400` with `code: CONFIRMATION_REQUIRED` otherwise, and nothing is sent). The person who
  decides is always the signed-in account, never a name sent by the client. A proposal that is not pending answers `404`; a refusal of the
  watchdog or of the check of its reply answers `502` with its `code` and `reason`. Every attempt and its outcome is written to the audit record
  (`ops-agent-proposal-decision`, with who asked, from which address, the incident and the decision).

Both answer `503` with `available: false` while the channel is not set up: `HYDRA_UMC_OPS_AGENT_URL` (the watchdog's `transport` address) and
`HYDRA_UMC_OPS_AGENT_REGISTRY_FILE` (a file `{"nodes": {"<node>": "<secret of at least 16 characters>"}}`, never part of a repository and
read once) must be set; `HYDRA_UMC_OPS_AGENT_LOCAL_NODE` (default `hydra-umc-server`), `HYDRA_UMC_OPS_AGENT_EDGE_NODE` (default `edge`) and
`HYDRA_UMC_OPS_AGENT_TIMEOUT_MS` are optional.

### The pass verdict of the twin before the real robot moves: `GET /api/hil-bridge/settings`, `POST /api/hil-bridge/settings`

The HIL bridge can refuse to move the real robot unless the twin passed the trajectory of the command (`require_twin_pass`, **off by default**).
STUDIO and SUITE show and edit that switch through these two routes, which carry the administrator's own `Authorization` header to the bridge
(`HYDRA_UMC_HIL_BRIDGE_URL`), so the bridge still decides and checks who asked.

- `GET /api/hil-bridge/settings` (any signed-in account): `requireTwinPass`, `locked` (the bridge was started with `--require-twin-pass`: it cannot be
  turned off while it runs), `persisted`, `ready` (the twin key and the robot are set: without them the switch cannot be turned on), `robotIdSet`,
  `keysConfigured` and `canChange` (the bridge has the identity key of this server; without it nobody can change the switch from here).
- `POST /api/hil-bridge/settings` (administrator only): the body is `{"requireTwinPass": true|false, "confirm": true}` and nothing else. **Both
  directions** need `confirm: true` (`400` with `code: CONFIRMATION_REQUIRED` otherwise, and nothing leaves this server). The bridge answers `200` with the new
  state and `changed`, or refuses (`401`, `403`, `409` with `code: SETTING_REFUSED` when it is locked, not ready or cannot keep the value), and that answer is
  passed on. This server also writes the attempt and its outcome to its audit record (`hil-bridge-twin-pass`, with who asked, from which address, the
  value and the status of the bridge).

Both answer `503` with `available: false` while `HYDRA_UMC_HIL_BRIDGE_URL` is not set (off by default).

## 2k. Settings of the installation that harden this API

Environment variables, read once at start (see `docs/PRODUCTION_BOOTSTRAP.md`):

| Variable | Effect |
|---|---|
| `JWT_SECRET` | Required in production, at least 32 characters, not an example value. |
| `HYDRA_UMC_CAMERA_AUTH` | **Required by default**: the live camera streams and the saved photos and recordings demand a ticket (`POST /api/camera/ticket`, `?ticket=` in the address) or a signed-in client (`Authorization: Bearer`) (`401` otherwise). `HYDRA_UMC_CAMERA_AUTH=open` is the opt-out for clients that do not ask for tickets yet; the server warns at every start while it is set. |
| `HYDRA_UMC_WS_QUERY_TOKEN` | **Refused by default**: `/ws?token=` gets an error message and a close with `1008`; the token travels as the `hydra.bearer` subprotocol. `HYDRA_UMC_WS_QUERY_TOKEN=allow` is the opt-out for clients that have not moved yet (it keeps the token in proxy and server logs); the server warns at every start while it is set. |
| `STOP_ALL_RATE_LIMIT_MAX`, `STOP_ALL_RATE_LIMIT_WINDOW_MS` | Budget of `POST /api/stop-all` per address (default 60 per 60 000 ms), separate from the login's. |
| `HYDRA_UMC_INFO_AUTH=required` | `GET /metrics`, `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status` and `/api/models` demand a signed-in client. Off by default so that a client that does not send its token on those routes yet keeps working. |
| `HYDRA_UMC_INFO_TICKETS=1` | With the information routes closed (`HYDRA_UMC_INFO_AUTH=required`), a signed ticket opens them for a client that cannot send a token (a Prometheus scrape, a dashboard): `POST /api/info/ticket` (any signed-in account; body `{ "ttlSeconds": 600 }` optional) answers `{ "ticket", "expiresInSeconds" }` and the ticket goes in the address (`GET /metrics?ticket=...`). It opens `/metrics`, `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status` and `/api/models` and nothing else, is signed with a key of its own (a camera ticket opens none of these, nor the reverse), says who asked and until when, and stops working the moment the option is turned off. The life is 300 seconds; only an administrator may ask for longer, up to `infoTickets.maxTtlSeconds` of `data/server-config.json` (30 to 2592000; 300 by default, so nothing lives longer until it is raised), and `infoTickets.ttlSeconds` changes the default life. Off by default: the route answers `404` and a ticket in an address is ignored. Also `infoTickets.enabled` of `PUT /api/admin/server-config`; an environment variable locks the switch. |
| `HYDRA_UMC_PRESENCE=1` | The dead-man of the presence of the operator (`POST /api/operator/presence`, section 2t): off by default (the routes answer `404`). Also `presence.enabled` of `PUT /api/admin/server-config`; the variable locks it. |
| `HYDRA_UMC_PRESENCE_ACTION` | What a lost heartbeat does to the robots of that operator: `slow` (default), `pause`, `notify` or `stop`; any other word is ignored. Also `presence.action` of `PUT /api/admin/server-config`; the variable locks it. |
| `HYDRA_UMC_CONNECTION_RECORD_ADDRESS=1` | The history of connections (`/api/connections/*`) also keeps the address and user agent of each client, shown to administrators only. Off by default: they are personal data and the history works without them. |
| `HYDRA_UMC_MQTT_HOME_ASSISTANT=1` | The MQTT bridge also publishes, retained, the discovery configs of each robot under `<discoveryPrefix>/<component>/<node>/<object>/config` (default prefix `homeassistant`, `mqtt.homeAssistant.discoveryPrefix`): one device per robot with its online flag, tool, playback state and joints and, only in `commands` mode, a stop button. Off by default; it applies on the next start. Also `mqtt.homeAssistant.enabled` of `PUT /api/admin/server-config`. See `docs/MQTT_BRIDGE.md`. |
| `HYDRA_UMC_PRODUCTION_RDP_LEVEL` | The read-out protection level a production flash of the controller boards sets: `0` (off, the default: nothing is protected) or `1`; any other word is ignored. Level 2 is permanent and is never offered. Also `production.rdpLevel` of `PUT /api/admin/server-config` (an integer, `400` for any other value); the variable locks it. It only records the choice: no flashing tool reads it yet. |
| `HYDRA_UMC_HEALTH_OPEN=1` | `GET /health` answers without a sign-in with a bare health report (no version, host or counts). Off by default: the route then answers `404`, as if it did not exist. Also `health.open` of `PUT /api/admin/server-config`. |
| `HYDRA_UMC_RATE_LIMITS=off` | Switches off the request limits per address (sign-in, renewals, API, code and service routes, global stop). On by default. Also `rateLimits.enabled` of `PUT /api/admin/server-config`, which asks for a confirmation in Server Admin and answers the warning `rate_limits_off`. |
| Server Admin: `rateLimits.loginMax`, `loginWindowSeconds`, `refreshMax`, `apiMax`, `sensitiveMax`, `apiWindowSeconds`, `stopAllMax`, `stopAllWindowSeconds` | The numbers of the limiters (the variables `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS`, `REFRESH_RATE_LIMIT_MAX`, `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_WINDOW_MS`, `SENSITIVE_RATE_LIMIT_MAX`, `STOP_ALL_RATE_LIMIT_MAX`, `STOP_ALL_RATE_LIMIT_WINDOW_MS` win over them). Whole numbers: `loginMax` 3-100 (5), `loginWindowSeconds` 60-86400 (900), `refreshMax` 10-10000 (120), `apiMax` 60-100000 (600), `sensitiveMax` 5-10000 (30), `apiWindowSeconds` 10-3600 (60), `stopAllMax` 10-10000 (60), `stopAllWindowSeconds` 10-3600 (60); anything else is a `400`, a value fixed by a variable a `409`. A change applies at once and restarts the counters; `GET /api/admin/server-config` reports `rateLimits.<name>` as `{ value, source, min, max }`. The change is in the audit record as `rate-limits-options`. |
| Server Admin: `bridges.droids.globalStop` / `cutOnGlobalStop`, `bridges.uav.missionUploadEnabled`, `bridges.amr.publishState` / `publishOpcua` / `zoneInterlock` / `zoneUnknown` (`pause` or `ignore`), `bridges.openpnp.boardCode` (`off`, `advisory`, `required`) | The switches of the machine bridges, in `PUT /api/admin/server-config` (`GET` shows each with its value, `source` `config` or `default`, `default`, `risky` and the name the bridge reads on its own host). Defaults: everything that moves hardware is off, `cutOnGlobalStop` is on, `zoneUnknown` is `pause`. A 400 answers an unknown bridge or option or a wrong type. Turning on a risky function (`uav.missionUploadEnabled`, `amr.zoneUnknown=ignore`) or turning `droids.cutOnGlobalStop` off asks for a confirmation in Server Admin and answers the warning `bridge_<bridge>_<option>`; the change is written to the security log and to the audit record `bridge-options` (`ok` and `refused`). While the bridge gateway is on, the values are published retained on `<prefix>/<bridge>/settings` as a SIGNED message `{"schema":2,"settings":{...},"seq":...,"issued_at_ms":...,"expires_in_ms":...,"signature":"..."}` when they are saved, when the gateway connects and every 60 seconds (the message expires after 120 seconds, so a bridge that restarts always finds a current one); `bridges.delivery` says whether the gateway is on, and `bridgeSigning` (a sibling of `bridges` in `GET /api/admin/server-config`) says, per bridge, where its key file is (`keyFile`, never the key), whether it can be used (`key`: `present`, `missing` or `unusable`), when a message was last signed and its counter. The signature is the HMAC-SHA256 of the signed commands of the SDK (`hydra_umc_sdk.signed_commands`) made with one key per bridge, kept in `~/.hydra-umc-keys/bridge-settings/<bridge>.key` (or the folder named by `HYDRA_UMC_BRIDGE_SETTINGS_KEY_DIR`); a missing key is made once (mode 600) and must be copied to the host of the bridge; with an unusable key nothing is published for that bridge. A bridge applies the settings only if its host allows remote settings (`HYDRA_UMC_DROIDS_REMOTE_SETTINGS=1`, `HYDRA_UMC_AMR_REMOTE_SETTINGS=1`, `HYDRA_UMC_OPENPNP_REMOTE_SETTINGS=1`, `HYDRA_UMC_BRIDGE_UAV_REMOTE_SETTINGS=1`; all off by default) AND it holds the key (`HYDRA_UMC_<DROIDS|AMR|OPENPNP>_SETTINGS_KEY_FILE`) AND the signature is valid, the message has not expired and its counter is not older than the last one applied; an unsigned message is never applied; without any of that, the bridge keeps what its own environment or file says. BRIDGE-UAV has no broker connection: it reads `bridges.uav.missionUploadEnabled` from this server's configuration file (the one named by `HYDRA_UMC_BRIDGE_UAV_SERVER_CONFIG`), so it needs no gateway. |
| Server Admin: `camera.credentialsViaEnv`, `install.newInstallTls` | The same two options as `HYDRA_UMC_CAMERA_CREDENTIALS_VIA_ENV=off` (the password of an IP camera on the command line of its process instead of in its environment) and `HYDRA_UMC_NEW_INSTALL_TLS=off` (a new installation does not switch TLS on by itself), saved with `PUT /api/admin/server-config` (`{ "camera": { "credentialsViaEnv": false } }`, `{ "install": { "newInstallTls": false } }`). The safe side is the default (`true` for both). The camera option applies the next time a camera process starts; the installation option is only read at the very first start of an installation (so it matters in a configuration seeded before that start, or through the variable). A variable that is set wins and answers `409`; the warnings `camera_credentials_in_arguments` and `new_install_tls_off` are returned when one is loosened. |
| Server Admin: `camera.open`, `websocket.allowQueryToken`, `logging.redactSecrets`, `voice.requireSignature` | The same four options as `HYDRA_UMC_CAMERA_AUTH=open`, `HYDRA_UMC_WS_QUERY_TOKEN=allow`, `HYDRA_UMC_LOG_REDACTION=off` and `HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE=1`, saved with `PUT /api/admin/server-config` (`{ "camera": { "open": true } }`, `{ "websocket": { "allowQueryToken": true } }`, `{ "logging": { "redactSecrets": false } }`, `{ "voice": { "requireSignature": true } }`) and applied on the next request. The safe side is the default (pictures need a ticket, no token in the address, secrets blanked out, signature not required). A variable that is set wins and answers `409`; the warnings `camera_open`, `ws_query_token_allowed` and `log_redaction_off` are returned when one is loosened. |
| `HYDRA_UMC_SAFETY_PUBLISH_STOP=1` | A global stop is also announced on the MQTT bridge as a retained `SAFE_STOP` (see `docs/GLOBAL_STOP.md`). Off by default. Also `safety.publishGlobalStop` of `PUT /api/admin/server-config`. |
| `HYDRA_UMC_JOB_STOP_RELAY=1` | The server delivers the stop requests of the job dispatcher to its robots and acknowledges only a stop that was applied (see `docs/JOB_STOP_RELAY.md`). Off by default. Also `jobDispatcher.stopRelay.enabled` and `jobDispatcher.stopRelay.robotMap` (dispatcher robot id -> numeric robot id of this server) of `PUT /api/admin/server-config`; the map is read again at every pass, the switch applies on the next start. |
| `HYDRA_UMC_JOB_DISPATCHER_CONFIG=<file>` | The JSON configuration file the job dispatcher reads when it starts and when asked to read it again (`POST /admin/reload-config`, which the server calls after it writes the options). With it, `jobDispatcher.replan.allowUnconfirmed` and `jobDispatcher.replan.stopAckTimeoutSeconds` (greater than 0, at most 86400) of `PUT /api/admin/server-config` are written into that file atomically (only those two keys of its `replan` section; a file that is not valid JSON is refused with `409`, never overwritten); without it the same request answers `409`. The answer says whether the dispatcher took the file (`jobDispatcher.replan.reload`); until it does, the change waits for the next start of the dispatcher. |
| `HYDRA_UMC_ORCH_TAKEOVER=1` | The server hands the missions of a primary orchestrator over to a standby one when the primary goes silent, with the proofs that the robots stopped (see `docs/ORCHESTRATOR_TAKEOVER.md`). Off by default. Needs `HYDRA_UMC_ORCHESTRATOR_URL`, `HYDRA_UMC_ORCHESTRATOR_STANDBY_URL` and the tokens `HYDRA_UMC_ORCHESTRATOR_TOKEN` / `HYDRA_UMC_ORCHESTRATOR_STANDBY_TOKEN`; the times and limits are in `jobDispatcher.takeover` of the settings file. |
| `HYDRA_UMC_ROBOT_ALLOW_ENABLE=1` | A robot in safe mode (`disable`) may be brought back by the `enable` command, by an administrator. Off by default: `enable` answers `403` (`enable-not-allowed`) and only the settings of an administrator change `enabled`. Also `robots.allowEnable` of `PUT /api/admin/server-config`. |
| `HYDRA_UMC_AI_ACCESS=admin` | `/api/ai/*` (the relay to the local AI services) answers administrators only. Off by default: an administrator or an operator can use it (any other role is refused), and only an administrator may change the baseline of the anomaly detector (a `POST` other than `/detect`). The services are `cognitive-node`, `detection-hef`, `visual-servoing-api`, `vla-engine`, `vision-node` and `anomaly-detector`. |
| `HYDRA_UMC_<SERVICE>_TOKEN` (or `..._TOKEN_FILE`) | The Bearer token this server presents to a service that asks for one, never to a client: `HYDRA_UMC_VISUAL_SERVOING_TOKEN`, `HYDRA_UMC_VLA_ENGINE_TOKEN`, `HYDRA_UMC_COGNITIVE_NODE_TOKEN`, `HYDRA_UMC_DETECTION_HEF_TOKEN`, `HYDRA_UMC_VISION_NODE_TOKEN`, `HYDRA_UMC_ANOMALY_TOKEN` (`/api/ai/*`), `HYDRA_UMC_VISION_STREAMER_TOKEN` (the camera streams), `HYDRA_UMC_DATALAKE_READ_TOKEN` else `HYDRA_UMC_DATALAKE_TOKEN` (the telemetry), `HYDRA_UMC_DATALAKE_ADMIN_TOKEN` else `HYDRA_UMC_DATALAKE_TOKEN` (the tier plan, administrators only). The names the services read themselves; `..._FILE` names a file whose first line is the token. None configured sends no header, as before. |
| `/api/ai/semantic-planner/*` and `/api/ai/job-dispatcher/*` | The relay also reaches two services, and only for exact requests: the dry run of a plan (`POST /plan/simulate`, and `GET /health`) of the semantic planner, and the estimates (`GET /dispatch/eta`, and `GET /health`) of the job dispatcher. Anything else is `403` before it is forwarded. Both are off in their own service until its switch is on (`plan_simulation.enabled`, `-eta`) and then answer `404` through the relay. The dispatcher token comes from `JOB_DISPATCHER_TOKEN` (or `JOB_DISPATCHER_TOKEN_FILE`). `GET /api/ai/datalake/windows` is also read (it tells whether the window statistics are on). Used by the Planning screen of STUDIO and SUITE. |
| `HYDRA_UMC_RUL=1` | `POST /api/ai/anomaly-detector/rul` (the remaining-useful-life estimate, for the card of the AI dashboard) is open to operators as well as administrators. Off by default (Server Admin option `rul.enabled`; the environment wins and locks it with `409`): the request is then a write to the detector and only an administrator may send it, as before. Only this exact `POST` is opened (every other `POST` to the detector stays administrator-only), the session must still be an administrator or an operator, the Bearer token of the detector is presented by this server only, and the destination is the anomaly detector on loopback and nothing else. The body must be a JSON object with a list `points`; a body above `rul.maxBodyBytes` (1024 to 1048576, 262144 by default) or more than `rul.maxPoints` points (8 to 100000, 5000 by default) answers `413` and a body of another shape `400`, both before anything is forwarded. The whole exchange, including the reading of the answer, ends after `rul.timeoutMs` (500 to 60000, 8000 by default) with `503`. The three limits are read from the `rul` block of `data/server-config.json`; anything invalid gives the default. |
| `HYDRA_UMC_TRUSTED_NETWORKS=1` | Trusted networks: administering the server is refused (`403`, `remote-policy`) from addresses outside the house and its VPN, and from outside only accounts with the second factor can sign in. Off by default (Server Admin option `trustedNetworks.enabled`, which the variable wins over); the ranges and the policy are read from `data/server-config.json`. See [`REMOTE_ACCESS_VPN.md`](REMOTE_ACCESS_VPN.md). |
| `/dashboard-ai` and `/api/ai/datalake/*` | The AI dashboard (HYDRA-UMC-DASHBOARD-AI, copied to `public/dashboard-ai/` by `build-frontend`) is served at `/dashboard-ai`. It reads through `/api/ai/*` with the session of the person signed in to STUDIO. The data lake is reached read-only there: `GET`/`HEAD` of `/health`, `/query`, `/aggregate`, `/stats`, `/stats/range` and `/series`; any other method or path answers 403 and is never forwarded. |
| `HYDRA_UMC_TELEMETRY_COLLECTOR_URL` (+ `HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN` or `..._FILE`, `HYDRA_UMC_TELEMETRY_INTERVAL_MS`) | Turns on the telemetry producer: the numbers of every robot delta (`pos_*`, `joints_*`, `playbackState_*`) are posted to the collector's `/ingest/ws` as one `robot_state` sample per robot (`sourceId` `robot-<controllerId>-<robotId>`, a growing `sequence`), at most one per interval (100-60000 ms, 1000 by default), merged. Off without the address. Never delays a command; bounded (256 robots, 32 fields a sample); 30 s pause after a failure. |
| `HYDRA_UMC_MQTT_BRIDGE` (`off`, `state` or `commands`) (+ `HYDRA_UMC_MQTT_URL`, `HYDRA_UMC_MQTT_PREFIX`, `HYDRA_UMC_MQTT_USERNAME`, `HYDRA_UMC_MQTT_PASSWORD` or `..._PASSWORD_FILE`, `HYDRA_UMC_MQTT_COMMAND_USER`, `HYDRA_UMC_MQTT_COMMAND_PASSWORD` or `..._PASSWORD_FILE`) | The bridge to the MQTT broker of the cell; off by default, also settable by an administrator in `data/server-config.json` (`mqtt`: mode, url, prefix, username, commandUser; `PUT /api/admin/server-config` with `{ "mqtt": { ... } }`, effective on the next start; the passwords only from the environment). See `docs/MQTT_BRIDGE.md`. |
| `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` | The voice and UAV options an administrator also sets from Server Admin (`voice` and `mavlink` in `data/server-config.json`, `PUT /api/admin/server-config`): transcript in voice replies (`1` switches it on; off by default), least recognizer confidence (0 to 1, default 0.6), MAVLink 2 signing key file (none by default) and whether unsigned messages are still accepted (no by default). The environment wins over what is saved (then the answer says `source: "env"` and a change is refused with `409`); the voice service and the UAV bridge read the same variables themselves. |
| `HYDRA_UMC_LOG_MAX_BYTES`, `HYDRA_UMC_LOG_KEEP` | The size at which the server log rotates (default 10 MB) and how many rotated files are kept (`.1` to `.N`, default 1). |
| `HYDRA_UMC_SERVER_PORT` | The listen port. It wins over the shared `PORT`, which is only a last resort (it prints a warning) and is ignored whenever this one is valid, so a shared environment file cannot move the server onto the port of the broker or the gateway. The port saved by the Config screen and the default 3000 are unchanged. |
| `HYDRA_UMC_CAMERA_CREDENTIALS_VIA_ENV=off` (Server Admin: `camera.credentialsViaEnv`) | A camera whose address carries credentials is started with `--device-env` and the address travels in the environment of the child, not in its arguments (so it stays out of the process list). `off` keeps the old form for a streamer that predates it. |
| `HYDRA_UMC_PORTS_REGISTRY` | The ecosystem status completes what a manifest does not say (port, health path, systemd unit) from `contracts/ports.yaml` of the SDK when it is checked out next to the other repositories; this variable names the file. What a manifest declares always wins. `off` turns the lookup off. |
| `HYDRA_UMC_SDK_DIR`, `HYDRA_UMC_REQUIRE_SDK=1` | Where `tools/verify_sdk_contract.mjs` (part of `npm test`) finds the SDK, default a sibling checkout. With none the contract test is skipped; `HYDRA_UMC_REQUIRE_SDK=1` makes that a failure. |

The page address of the embedded 3D view (`/?hideUI=true&robotId=<id>&token=<JWT>`, which the
Android and iOS apps load in a WebView) is the one place a token still travels in an address: the
server only serves the static page for it and never reads that `token`, STUDIO reads it once
and removes it from the address, and its WebSocket then uses the subprotocol. It is not covered by the
two settings above.

Always on: `POST /api/system/reboot` and `/shutdown` accept only a plain request from this
device itself; a request that went through a proxy (`X-Forwarded-For`, `Forwarded`, `Via`...), that
carries an `Origin` of another site, or that the browser marks `Sec-Fetch-Site: cross-site` gets
`403`, so a page open in the kiosk's browser cannot power the cell off.

## 2l. Safety limits: `/api/safety-limits`, the jog arming and the claims

The limits live in the server, so every client is held to the same ones. They are
saved through the transactional store (`data/safety-limits.json`, never served as a
static file) and every change is written to the server log with the account that made it.

- `GET /api/safety-limits` (any signed-in account, optional `?robotId=`): `{ limits,
  defaults, hardLimits, robot? }`. With `robotId`, `robot` carries the limits that apply
  to that robot's model and, when its jog is armed, `jogArmedUntil`.
- `PUT /api/admin/safety-limits` (admin): a partial change, validated; `400` for an
  unknown key, a wrong type or a value beyond the hard ceilings. An object under
  `models` replaces the whole table of that section. Models are keyed by name without the
  parenthesis and without case (`"Parol6 (6-DOF)"` is `parol6`).

| Setting | Default | Hard ceiling | Effect |
|---|---|---|---|
| `jog.default.maxAmount`, `jog.models.<model>.maxAmount` | 100 | 1000 | A relative jog (`"jog"` command) larger than this is not applied and comes back in `warnings` (`field: "jog"`). |
| `jog.default.maxAbsolute`, `jog.models.<model>.maxAbsolute` | 1000 | 10000 | The same for an absolute jog (`absolute: true`): the target position, in either direction. |
| `jog.armRequired` | `false` | | When on, a `"jog"`, `"table"`, `"joints"` or `"reset"` command is refused with `403` (`jog-not-armed`) unless the account and controller that send it armed the robot first. |
| `jog.armTtlMs` | 60000 | 1000 to 600000 | How long an arming lasts. |
| `temperature.default.bedMaxC`, `temperature.models.<model>.bedMaxC` | 110 | 300 | A heated-bed `targetTemp` above it is lowered to it when settings are saved (`POST /api/settings` or the WebSocket) and `POST /api/settings` returns it in `warnings` (`code: "temperature-limit"`). |
| `claims.requireControllerId` | `false` | | When on, `claim` without a controller id is `400` (`controller-id-required`). |

`POST /api/robot/:id/jog-arm` (any signed-in account; body `{ "armed": true|false,
"ttlMs"?: number, "controllerId"?: string }`) arms or disarms the jog of one robot. It is
refused with `409` while another account or controller holds the claim. The arming belongs
to the account and the controller that made it, lasts at most `jog.armTtlMs`, is kept in
memory only (a restart disarms everything) and is cleared by `"stop"`, by `POST
/api/stop-all` and by `release`. It can be armed at any time; it is only demanded while
`jog.armRequired` is on.

### 2m. Conditional writes, the table command, the audit record and the claim events

These four pieces complete the second version of the contract (`CONTRACT_V2.md`). Every one of them is optional for a client.

- `GET /api/robot/:id` (any signed-in account): `{ robot, revision, cellId }` and the header `ETag: "<revision>"`. The credentials of the cameras are left out unless the caller is an administrator.
- `If-Match` on `POST /api/robot/:id/command`, `.../claim` and `.../release`: the revision from `GET /api/robot/:id` (or from the last answer, which carries `revision` and `ETag`). When the robot changed in between the answer is `412` with `{ error, code: "revision-mismatch", revision }`; send it again after reading the robot. `*` or no header always goes through, and `"stop"` is never conditional. The record of past claims, the times of a claim and the step counter of a running playback do not change the revision.
- The `"table"` command (`params`: `{ x, y, rz?, mode: "absolute" | "relative" }`, mode defaults to `"absolute"`): moves the XY table of the robot in one request. It is checked as a whole before anything changes (finite numbers; a relative move within `jog.maxAmount`, an absolute one within `jog.maxAbsolute`, and the position it ends in within `jog.maxAbsolute`), needs the claim like every command but `stop`, and needs the arming while `jog.armRequired` is on. It answers `{ success, revision, applied: { robotId, x, y, rz? } }`; a refusal is `400` with `code` `table-invalid`, `table-out-of-limit` or `table-missing`, and nothing changed. It touches the robot it is sent to, never its combined siblings.
- `GET /api/audit` (admin): `{ enabled, lockedOff, entries, verification? }`. The newest entries, oldest first: `?limit=` (1 to 1000, 100 by default), `?afterSeq=`, `?type=`, `?robotId=`; `?verify=1` checks the hash chain; `?format=jsonl` downloads the lines as stored. Each entry has `seq`, `ts`, `type` (`claim`, `force-claim`, `release`, `force-release`, `jog-arm`, `safety-limits`, `stop-all`, `robot-motion`, `model-submit`, `power-reboot`, `power-shutdown`, `server-restart`), `outcome` (`ok`, `refused`, `failed`), the account, the controller id, the address, the robot and a `detail` object, plus the SHA-256 of the previous line (`prev`) and of its own (`hash`). The record is `data/audit.jsonl`, rotated by size (`HYDRA_UMC_AUDIT_MAX_BYTES`, 5 MB; `HYDRA_UMC_AUDIT_KEEP`, 5 files), copied next to every new settings backup, and everything in it passes through the secret redaction. An administrator switches it with `PUT /api/admin/safety-limits` (`{ "audit": { "enabled": false } }`, on by default); `HYDRA_UMC_AUDIT=off` in the environment locks it off. The motion commands are recorded as `robot-motion` (`detail.command` is `play`, `pause`, `stop`, `trajectory` with `detail.points`, `table` with `x` and `y`, `speed`, `tool`, `valve` or `pump`): the discrete ones every time, and a stream of `jog`, `jogStep`, `joints` or `reset` at most once per account and robot every `audit.motionIntervalSeconds` seconds (whole number from 0 to 3600, 10 by default; 0 leaves the stream out), set with `PUT /api/admin/safety-limits`.
- A `claims` message on the WebSocket, for the clients that opened `/ws` with `?remoteApiVersion=2`: `{ "type": "claims", "schema": 2, "claims": [...] }` with the same list as `GET /api/claims`, after a claim, a release, an arming or a stop changed it. `GET /api/claims` also carries `jogArmedUntil` for every claim now. A claim that merely expires is not announced; it disappears from the next list.
- What became of a command: an accepted `POST /api/robot/:id/command` also answers `operation_id`, `operation` (the `Operation` contract of the SDK: `kind` `robot.command`, `status` `authorized`, `target` `{ kind: "robot", id }`, `correlation_id` from the header `X-Correlation-Id` when it is 1 to 64 characters of letters, digits, `. _ : -`, else the operation id) and `lifecycle` (the `CommandLifecycleEvent` contract: `state` `ACCEPTED`, `sequence` 1). The clients that opened `/ws` with `?remoteApiVersion=2` get the same event as `{ "type": "command-lifecycle", "schema": 2, "event": { ... } }`. The server only vouches for `ACCEPTED`; the later states (`RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`) need a controller that reports them and are not sent yet, so a client never reads `COMPLETED` from this server as proof that the robot moved. A refused command (`4xx`) sends nothing.

### 2n. Who connects: `/api/connections/*`

The server keeps a list of the clients that sign in (a Studio or Suite session, an app, the voice service, anything else) and a bounded history of what happened, in the closed shapes of the `ConnectionClient` and `ConnectionEvent` contracts of the SDK. Neither holds a password, a token, a cookie or a code. A client says what it is with the header `X-Hydra-Client: <studio|suite|android|ios|dsi|watch|voice>`, with `/<version>` after it when it knows its version (the version only goes to the history; the remote-access gate compares the type alone, and a version never gives a client more rights), else the server guesses from the user agent, else the kind is `other`.

- `GET /api/connections/clients` (any signed-in account): `{ "clients": [ConnectionClient, ...] }`, the most recently seen first, each with `first_seen_utc`, `last_seen_utc`, `active_sessions`, `logins_ok`, `logins_failed` and, when it applies, `user`, `app_version`, `origin` (`local` or `remote`), `two_factor` and `last_failure_utc`. Filters: `?kind=`, `?user=` and `?active=1`. An administrator sees every client; any other account sees only its own (the `user` filter cannot reach another account).
- `GET /api/connections/events` (any signed-in account): `{ "events": [ConnectionEvent, ...] }`, newest first, with `action` one of `first_seen`, `login`, `login_failed`, `second_factor_failed`, `logout`, `session_ended`, `session_expired`. Filters: `?kind=`, `?action=`, `?user=`, `?limit=` (1 to 500, 100 by default) and `?before=<event id>` to page back. A refused sign-in keeps the name that was typed only when it is the name of a real account.
- The address (`ip`) and the user agent (`agent`) are written only when an administrator turned on `connections.recordAddress` (Server Admin, `PUT /api/admin/server-config` with `{ "connections": { "recordAddress": true } }`, or `HYDRA_UMC_CONNECTION_RECORD_ADDRESS=1`; off by default, and the environment wins) and are shown to administrators only. The history is kept in `data/connections.json` (500 events, 300 clients, clients not seen for 120 days are forgotten).

### 2o. Health, the signal of life of each robot and the release of the global stop

- `GET /health` (no sign-in, but only once an administrator turned on `health.open`; until then `404`) answers the `HealthReport` contract of the SDK and nothing else: `{ "schema_version": "1.0", "state": "READY", "timestamp_utc": "...", "checks": { "process": "ok" }, "service": "hydra-umc-server" }`. It is meant for a supervisor or a load balancer that cannot sign in; the authenticated information stays in `/api/hydra-info`, `/api/system/metrics` and `/api/ecosystem/status`.
- `GET /api/robots/liveness` (any signed-in account): `{ "schema_version": "1.0", "stale_after_s": 30, "robots": [ { "controller_id": "c1", "robot_id": 1, "state": "live", "last_update_utc": "...", "age_s": 4, "source": "state" } ] }`. `state` is `live` when the server had news of the robot within `stale_after_s`, `stale` when the last news is older, and `unknown` when there has been none since the server started (then there is no `last_update_utc`). News is a command the server carried out, a change of the robot's state that went out to the clients (`source: "state"`) or a heartbeat (`source: "heartbeat"`). It is **not** the `online` flag of the settings, which only records what an operator switched on, and it is not a measurement of the hardware: a robot nobody commands and no bridge reports is `stale` or `unknown`, not live. The limit is `liveness.staleAfterS` of `data/server-config.json` (whole seconds, 1 to 3600, 30 by default; anything else gives the default).
- `POST /api/robot/:id/heartbeat` (no body; `admin` or `operator`, so a bridge or controller account with real news of a robot can keep it live): `{ "success": true }`, or `404` for a robot that is not in the roster.
- `POST /api/stop-all/release` (admin only, no body): says the global stop is over, `{ "success": true, "announced": true }`. It publishes the retained `READY` when announcing is configured (`announced: false` otherwise or when the broker is not connected), moves no robot and is written to the audit record (`stop-all-release`). The announcement of the stop itself, and what a bridge does with it, are in `docs/GLOBAL_STOP.md`.

### 2p. Health of the ecosystem: `GET /api/ecosystem/health`

- `GET /api/ecosystem/health` (`admin` or `operator`; a viewer gets `403`, a client that is not signed in `401`). It answers only once an administrator turned on `ecosystemHealth.enabled` (Server Admin, `PUT /api/admin/server-config` with `{ "ecosystemHealth": { "enabled": true } }`, or `HYDRA_UMC_ECOSYSTEM_HEALTH=1`; off by default, and the environment wins and locks the option with `409`). While it is off a signed-in client gets `404`, exactly as a server without the route would answer. Read only: it changes nothing and starts nothing.
- It reads what the server already knows (the manifests of the sibling checkouts and the registry of ports, as `GET /api/ecosystem/status` does) and asks each service that declares a port or a systemd unit for its health with a short timeout and no side effect: a `GET` of its health path (the `HealthReport` it answers is read for its `state` and `version`; the rest of the body is dropped) or a bare TCP connect. The services are asked at the same time, so the whole answer waits one timeout window; requests that arrive during a scan share it.
- The answer: `{ "schema_version": "1.0", "generated_at_utc": "...", "available": true, "summary": { "total": 5, "ok": 2, "degraded": 1, "down": 2, "unknown": 0, "drift": 1 }, "services": [ ... ], "certificate": { "state": "ok", "not_after_utc": "...", "days_left": 212, "warn_days": 30 }, "warnings": [ { "code": "service_down", "service": "HYDRA-UMC-X" } ] }`. `available` is `false` (and `services` empty) when the sibling checkouts cannot be scanned at all.
- Each service: `name`, `family`, `role`, `state` (`ok`, `degraded`, `down` or `unknown`), `reason` (a short code: `health_ok`, `health_degraded`, `health_failed`, `http_error`, `unreachable`, `unreachable_unit_active`, `reachable_unit_not_active`, `unit_active`, `unit_starting`, `unit_failed`, `unit_inactive`, `no_signal`, `probe_error`), `version_expected` (the manifest), `version_reported` (what the service says of itself, or `null`), `drift` (`true` only when both are known and differ), `last_seen_utc` (the last time the server heard from it, kept in `data/ecosystem-health-last-seen.json` so it survives a restart, or `null`) and `latency_ms`. A project that declares neither a port nor a unit (a library, a tool, firmware) is not listed. A service that does not answer is `down` and never stops the rest from being reported; one whose probe failed unexpectedly is `unknown`.
- An administrator also gets `port`, `health_path`, `systemd_unit` and `active_state` of each service. An operator gets none of them, so no address or port of the host leaves the server for a non-administrator.
- `certificate` is the TLS certificate of this server itself (`null` when it runs without TLS): `state` is `ok`, `expiring` (fewer than `warn_days` whole days left), `expired` or `unreadable`; the path and the key are never part of the answer. `warnings` lists `certificate_expiring`, `certificate_expired`, `certificate_unreadable`, `service_down`, `service_degraded` and `version_drift` (with the `service` they belong to).
- Four values are read from the `ecosystemHealth` block of `data/server-config.json` (not security switches; anything invalid gives the default): `certWarnDays` (1 to 365, 30 by default), `probeTimeoutMs` (100 to 10000, 1500 by default), `lastSeenMaxEntries` (how many services the stored last-contact times hold, 1 to 1024, 256 by default; the most recently heard are kept) and `lastSeenSaveIntervalS` (at most one write of that file per this many seconds, 1 to 3600, 30 by default). The file is written atomically (temporary file, then rename); one that is missing, damaged, over 256 KiB or with times in the future is ignored. The route answers `404` while `ecosystemHealth.enabled` is off, `401` without a sign-in and `403` to a viewer; in the OpenAPI document the `{id}` of the robot and camera routes is an integer.

### 2q. Setting of the remaining-useful-life relay: `GET /api/rul/config`

- `GET /api/rul/config` (any signed-in account, a viewer included; a client that is not signed in gets `401`). Read only. It tells a client, in one small answer, whether the relay of the estimate (`POST /api/ai/anomaly-detector/rul`) is open to operators and how big a request it may send, so the card of the AI dashboard shows itself only when the server has the option on.
- The answer is exactly `{ "enabled": false, "maxPoints": 5000, "timeoutMs": 8000 }` and nothing else: `enabled` is `true` only when `rul.enabled` is on (Server Admin, `PUT /api/admin/server-config`, or `HYDRA_UMC_RUL=1`; the same switch the relay enforces), `maxPoints` is `rul.maxPoints` (8 to 100000) and `timeoutMs` is `rul.timeoutMs` (500 to 60000), both read from the `rul` block of `data/server-config.json`. No body limit, no path, no token and no address of the detector is part of it. It is sent with `Cache-Control: no-store`.
- Fail-closed: when the configuration is missing, cannot be read or holds a value that is not valid, the answer is the closed default above (`enabled` false, 5000 points, 8000 ms) instead of an error, so a client never has to guess. A server that predates the route answers `404`; a client treats that, an error and a timeout as "closed".

### 2r. Push notifications: `POST /api/push/devices`, `DELETE /api/push/devices/{token}`, `GET /api/admin/push`

- `POST /api/push/devices` (any signed-in account) with `{ "token": "<hexadecimal device token>", "platform": "ios", "locale": "en" }` registers the phone for the account and answers `{ "registered": true }`; `locale` is one of the eight languages of the apps (`en`, `es`, `de`, `fr`, `it`, `ja`, `zh`, `pt`; English when absent). The same token registered again moves to the account that registered it last. `400` for a token that is not hexadecimal, a platform other than `ios` or an unknown language; `409` when the server already keeps `push.maxDevices` tokens.
- `DELETE /api/push/devices/{token}` (any signed-in account) removes a token and answers `{ "removed": true }` (`false` when it was not there or belongs to another account; an administrator can remove any).
- Both answer `404` with no body while `push.enabled` is off, as if the routes did not exist.
- `GET /api/admin/push` (`admin` only) answers `{ "enabled": false, "configured": false, "problem": "missing", "devices": 0, "sandbox": false, "events": { "jobFinished": true, "globalStop": true } }`: whether the service is on, whether its credentials are usable (`problem` is `null` or `missing`, `invalid`, `key-in-repo`, `key-unreadable`), how many tokens are kept and which events are sent. It never returns a credential or a token.
- The server sends the notification of a job that finished by itself and of a global stop to every registered phone, in its language, through the Apple push service. The credentials come only from the environment (`HYDRA_UMC_APNS_*`); see `docs/PUSH_NOTIFICATIONS.md`.

### 2s. Gateway to the machine bridges: `GET /api/bridges`, `GET /api/bridges/{name}/state`, `POST /api/bridges/{name}/cmd/{verb}`

- The gateway lets a client read the state of a machine bridge (CNC, laser, OpenPnP, 3D printer...) and send it a command without knowing MQTT. It is **off by default**: every route answers `404` with no body (to a signed-in client; `401` to the others) while `bridgeGateway.enabled` is off (Server Admin, `PUT /api/admin/server-config` with `{ "bridgeGateway": { "enabled": true } }`, or `HYDRA_UMC_BRIDGE_GATEWAY=1`, which locks the option). The broker, its user and its password are the ones of the MQTT settings of the server.
- `GET /api/bridges` (any signed-in account) answers `{ "connected": true, "bridges": [ { "name", "available", "state", "health", "updatedAt" } ] }`: the bridges that have announced themselves on the broker (`hydra/bridges/<name>/state`, `availability`, `health`, all retained), with what each published last. `GET /api/bridges/{name}/state` answers one of them: `404` for a name never seen, `503` while the broker is not connected, `400` for a name that is not valid.
- `POST /api/bridges/{name}/cmd/{verb}` (operator or administrator) publishes the JSON object of the body (at most 8 KiB, empty allowed) on `hydra/bridges/<name>/cmd/<verb>` at QoS 1, not retained, and waits for the bridge to publish its answer on `.../cmd/<verb>/result`. It answers `200 { "accepted": true, "result": <what the bridge published> }`, or `"result": null` when the bridge said nothing within `commandTimeoutMs`. Refusals: `403` for a verb that is not on the list (`allowedVerbs`; by default `status`, `stop`, `pause`, `resume`; `job` is never accepted, it has its own signed path), `404` for an unknown bridge, `409` while a command of the same bridge and verb waits for its answer, `413` for a large body, `429` above `commandsPerSecond` (a `stop` is never held back), `502` when the broker did not take the message, `503` while it is not connected.
- Every command is written to the audit log (`bridge-command`, the account, the address, the bridge, the verb and the status; never the parameters). The gateway gives a bridge no privilege of its own: the broker access list should let only the server publish on the command topics.
- Settings that are not security switches are read from `data/server-config.json` (`bridgeGateway.prefix`, `allowedVerbs`, `commandTimeoutMs` 100-30000, `commandsPerSecond` 1-50); an invalid value falls back to the conservative default.

### 2t. Presence of the operator (dead-man): `POST /api/operator/presence`, `GET /api/operator/presence`

- Off by default: until an administrator turns on `presence.enabled` (Server Admin, `PUT /api/admin/server-config` with `{ "presence": { "enabled": true } }`, or `HYDRA_UMC_PRESENCE=1`, which locks it) both routes answer a bare `404`, as if they did not exist. `admin` or `operator` only (a viewer gets `403`, a client that is not signed in `401`).
- `POST /api/operator/presence` is the heartbeat, the message the watch already sends: `{ "type": "presence_heartbeat", "protocolVersion": 1, "sequence": 12, "intervalSeconds": 5, "state": "PRESENT" }` (`type` and `protocolVersion` are optional; `sequence` is a whole number of 0 or more; `intervalSeconds` from 1 to 60; `state` is `PRESENT` or `LEFT`, the second meaning the person left on purpose). It answers `{ "accepted", "duplicate", "stale", "state", "sequence", "action", "timeoutSeconds" }` with `state` one of `present`, `lost`, `left`, `recovering`. It is idempotent by `sequence`: the same number again answers `duplicate: true` and changes nothing; a lower number while the last heartbeat is recent answers `stale: true` and is ignored; after a silence longer than the timeout a lower number is taken as a restart of the sender. A body that is not valid answers `400` with `code: "invalid-presence-heartbeat"`.
- `GET /api/operator/presence` answers how the server sees the signed-in account (its own state only): `{ "state": "unknown|present|lost|left|recovering", "lastSequence", "secondsSinceBeat", "action", "timeoutSeconds", "degradedRobots": [ids] }`.
- A heartbeat is lost after `presence.timeoutSeconds` of the file without one (never less than twice the interval of the sender plus one second); a `LEFT` heartbeat acts at once unless `presence.leftImmediate` is `false`. Then, on the robots that account holds a claim on and with the action chosen in Server Admin (`presence.action`, or `HYDRA_UMC_PRESENCE_ACTION`, which locks it): `slow` (default) keeps the speed at `presence.slowFactor` of what it was (never under 10) and brings it back to that cap if somebody raises it; `pause` pauses the ones that are running; `notify` only warns; `stop` stops them. Every action writes the log and an audit record (`operator-presence-lost`) and sends the push `presence-lost` to the registered phones (unless `push.notifyPresenceLost` is `false`).
- Recovery: `presence.recoverBeats` heartbeats in a row (3 by default) bring the account back (hysteresis); a lowered speed then returns to what it was along `presence.rampSeconds` (5 by default) without a jump, and a speed the operator sets meanwhile is kept as they set it. A paused or stopped robot is never resumed by this function: the operator resumes it. An audit record `operator-presence-restored` is written. A robot that changed hands while held back keeps the speed it has.
- The global stop is never held back by this function: it only changes numbers in memory, it never starts, resumes or un-stops a robot, and `POST /api/stop-all` works at any moment. The held state is kept in memory only: after a restart of the server a speed that was lowered stays lowered until somebody sets it.
- Configuration: `presence.enabled` and `presence.action` of `PUT /api/admin/server-config` (the answer carries `presence.enabled`, `presence.action` as `{ value, source }`, and the read-only times); the times are edited in `data/server-config.json`, block `presence`: `timeoutSeconds` (3 to 600, 15), `slowFactor` (0.05 to 0.9, 0.3), `recoverBeats` (1 to 20, 3), `rampSeconds` (0 to 120, 5), `leftImmediate` (true). See `docs/OPERATOR_PRESENCE.md`.

### 2u. Tier plan of the data lake: `GET` / `PUT /api/telemetry/downsample-plan` (admin)

A relay of the two routes `GET` / `PUT /downsample/plan` of HYDRA-UMC-DATALAKE, for the editor in Studio's Telemetry panel. Administrators only; the server presents the administration token of the data lake (`HYDRA_UMC_DATALAKE_ADMIN_TOKEN`, else `HYDRA_UMC_DATALAKE_TOKEN`), which no client sees. The body of the `PUT` (`{"plan": {...}, "expectedHash", "confirmDelete", "preview"}`) and `?preview=1` are forwarded as they are, and the answer comes back with its status and body: `400 invalid_plan`, `403 delete_not_allowed`, `409 plan_changed` / `confirm_delete_required`, `422 incoherent_plan` / `unknown_kind`. A data lake that was not started with the plan administration answers `404` (the editor shows it as off); no data lake configured answers `503`. A request only saves a plan; whether the rolled-up raw points are deleted is decided by the operator when starting the data lake, never by a request. The rules and the shapes are in the data lake's own API document.

### 2v. Robot ids are global: `409 robot_id_duplicated` and `409 robot_id_ambiguous`

`/api/robot/:id` names one robot of the whole installation, whatever controller holds it, so a robot id must be unique across all the controllers.

- **Registering a repeated id is refused.** `POST /api/settings` (and the `settings` message of the WebSocket) with a tree in which an id is used by more than one robot, when the stored tree did not already repeat it, answers `409` with `{ "error": "...", "code": "robot_id_duplicated", "conflicts": [ { "robotId": 2, "controllers": ["c1", "c2"] } ] }` and stores nothing. Saving a tree that already repeated an id without adding another, or repairing it, still works.
- **A configuration of an older version that already repeats ids still starts.** The ids are marked ambiguous: `GET /api/robot/:id`, `POST /api/robot/:id/command`, `/claim`, `/release`, `/heartbeat`, `/jog-arm` and `GET /api/safety-limits?robotId=` answer `409` with `{ "error": "...", "code": "robot_id_ambiguous", "robotId": 2, "controllers": ["c1", "c2"] }` instead of choosing one of the robots. The robots with a unique id keep working. The list holds controller ids only: never names, addresses or credentials.
- **Where it is reported.** At start the log has one `[ROBOT-IDS]` line per ambiguous id, and `GET /api/admin/robot-ids` (administrator) answers `{ "ok": false, "ambiguousCount": 1, "ambiguous": [ { "robotId": 2, "controllers": ["c1", "c2"] } ] }` (`ok` is `true` and the list empty when every id is unique). A bridge that resolves a robot by id (MQTT, Bluetooth) finds none for an ambiguous id.
- The error texts are in English with a stable `code`; the clients translate them by the code.

### 2w. Asymmetric sign-in tokens (optional): `GET /.well-known/jwks.json`, `GET /api/admin/jwt-keys`, `POST /api/admin/jwt-keys/rotate`

- Off by default. The server signs HS256 with `JWT_SECRET`, as always, and `GET /.well-known/jwks.json` answers a `404` (`Cache-Control: no-store`), as if it did not exist. An administrator chooses `EdDSA` (Ed25519) in Server Admin, with `PUT /api/admin/server-config` and `{ "auth": { "jwtAlgorithm": "EdDSA" } }`, or with `HYDRA_UMC_JWT_ALGORITHM=EdDSA`, which locks it. The change applies at once, no restart.
- With `EdDSA` every new token (`POST /api/login`, `POST /api/refresh`) has the header `{ "alg": "EdDSA", "typ": "JWT", "kid": "<key id>" }` and the claims it always had plus `iat`, `nbf` and `exp`. Another service verifies it with the public key of `GET /.well-known/jwks.json` and never holds a secret that could forge a token.
- `GET /.well-known/jwks.json` is public and answers a JWK Set (RFC 7517): `{ "keys": [ { "kty": "OKP", "crv": "Ed25519", "x": "...", "kid": "...", "use": "sig", "alg": "EdDSA" } ] }`, public parameters only. `Cache-Control: public, max-age=300, must-revalidate`, `Content-Type: application/jwk-set+json`, `X-Content-Type-Options: nosniff`; it is rate limited per address (`429`) and answers `503` if the key file cannot be read.
- The private keys are in one file outside the repository: `HYDRA_UMC_JWT_KEYS_FILE`, by default `~/.hydra-umc-keys/server-jwt-keys.json`, created with mode `0600` in a directory of mode `0700` (a file readable by others is fixed on load, or refused). It is never part of an answer, a log or a backup of the settings. The first key is created when EdDSA is chosen; if the file cannot be written, the change is refused with `500` and nothing is changed.
- Rotation: `POST /api/admin/jwt-keys/rotate` (administrator; `409 JWT_ASYMMETRIC_OFF` while the algorithm is HS256) makes a new key the active one. The previous key stays published and accepted for `auth.keyOverlapSeconds` (60 to 31622400, 2592000 by default; edited in `data/server-config.json`, block `auth`), so two keys are valid during the transition and tokens already issued keep working; after that it is dropped from the key set and from the file. `GET /api/admin/jwt-keys` answers `{ "algorithm", "keys": [ { "kid", "createdAt", "retiredAt", "active", "acceptedUntil" } ], "jwksPath" }`, never any private part.
- The check of a token is strict, for HTTP and for the WebSocket: the algorithm comes from the configuration, never from the token. An `EdDSA` token needs a `kid` of a published key, a valid signature, an `exp` in the future, and no `nbf` or `iat` in the future (5 seconds of clock difference are tolerated). `alg: none`, `RS*`, `ES*`, `HS384` and the rest are refused, and so is an `HS256` token signed with the public key as if it were a secret. A refused token answers `403` with `code: "TOKEN_INVALID"` (`TOKEN_EXPIRED` for an `exp` that passed), as before.
- `auth.acceptHs256` (`PUT /api/admin/server-config`, or `HYDRA_UMC_JWT_ACCEPT_HS256=0`/`1`, which locks it; default `true`): while the server signs EdDSA, whether HS256 tokens still around are accepted, so nobody is signed out at the switch. Turn it off when the transition is over; the answer then carries the warning `jwt_hs256_refused`, and choosing EdDSA carries `jwt_eddsa_on`. Going back to `HS256` stops accepting EdDSA tokens.
- The answer of `GET` / `PUT /api/admin/server-config` carries `auth.jwtAlgorithm`, `auth.acceptHs256` and `auth.serviceIdentity.enabled` (the identity of this server in its calls to the services, off by default) as `{ value, source }` and `auth.keyOverlapSeconds`.

## 3. Live sync: `WebSocket /ws`

Connect with `new WebSocket("ws://<host>:3000/ws", ["hydra.bearer", "<JWT_TOKEN>"])`
(the token as a subprotocol; the server answers `hydra.bearer`). `ws://<host>:3000/ws?token=<JWT_TOKEN>`
is refused unless the installation sets `HYDRA_UMC_WS_QUERY_TOKEN=allow` (section 2k; see
section 2a for obtaining a token). The token is always mandatory - a missing or invalid one
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

The envelope (`{type, payload}`, or `{type, schema, ...}` for `"delta"`
below) is deliberately generic, so a client that already knows to ignore
an unrecognized `type` never breaks when a new one is added. Real `type`
values today:
- `"settings"` - the full state, above.
- `"delta"` - a lighter per-robot update from `POST /api/robot/:id/command`.
  `schema: 1` clients get the same full-tree shape as `"settings"`;
  clients that opened `/ws` with `?remoteApiVersion=2` get `schema: 2`
  instead - one message per affected robot, `{ "type": "delta", "schema":
  2, "controllerId", "robotId", "patch", "cameraId"?, "cameraPatch"? }`.
- `"claims"` - who controls which robot, for the clients that opened `/ws` with `?remoteApiVersion=2` (section 2m).
- `"command-lifecycle"` - the `CommandLifecycleEvent` of an accepted command, same clients (section 2m).
- `"canota_progress"` - real, live per-page flash progress from `POST
  /api/hardware/canota/flash` (section 2h), sent to every connected
  `admin` client (operators and viewers do not receive it, the same rule as the
  flash itself) while a real STM32H745 flash cycle is in progress: `{ "type":
  "canota_progress", "payload": { "phase", "pages_sent", "pages_total",
  "percent", "error" } }`.

**Client responsibility:** the server broadcasts to the sender too rather
than tracking "who sent this" (simpler server-side). A client MUST
therefore guard against re-processing its own echo as if it were a fresh
external change - see `src/store.tsx`'s own `lastPayloadJsonRef` guard
(compares the incoming payload's JSON against the last payload it itself
applied/sent, skips if identical) for the reference approach. Skipping
this guard doesn't corrupt data, but does produce a wasteful, harmless
POST/broadcast ping-pong on every single change.

## 4. What this API does NOT cover (yet)

- **Real STM32H745 hardware verification** - `POST /api/hardware/canota/flash`
  and `GET /api/hardware/canota/version` (section 2h) are a real relay to a
  real local `spi_bridge` service with a real, unit-tested SPI-OTA state
  machine - but no populated STM32H745 board exists yet (no schematic, see
  `HYDRA-UMC/hardware/PCB/kinematic_brain_stm32h745/README.md`), so none of
  this has been exercised against real silicon. `Flasher.tsx`/`Tester.tsx`
  (`src/lib/canOta.ts`) still default to `transport: 'mock'`; `'hardware'`
  now calls these real routes instead of only disabling the Flash button.
- **Transport-level security** - every endpoint is plain HTTP/WS, not TLS,
  and `GET /api/settings`/`GET /api/system/metrics` still require no
  bearer token at all (only writes and account management do - see
  section 2a/2b/2c). Fine for a trusted LAN, which is this whole
  ecosystem's assumed deployment; if HYDRA-UMC SUITE's own VPN-tunnel use
  case (reaching a HYDRA-UMC on a different physical network) is ever
  exposed beyond a private tunnel, this needs real transport security
  (TLS) and a hardcoded, source-committed `JWT_SECRET` (`server.ts`)
  moved to a real per-deployment secret before that's safe.
- This bullet used to say there was no refresh/rotate endpoint and that a
  password change "invalidates nothing already issued" - both are now out
  of date. `POST /api/refresh`/`POST /api/logout` (section 2a) let a
  client recover from a real token expiry without a password, and every
  account mutation (password/role change, deletion) already revokes every
  outstanding access token AND refresh token immediately (`tokenVersion`/
  `id` in `users.ts`, checked on every request/WS tick - see
  `authenticate()`/the WS connect+heartbeat re-checks in `server.ts`) -
  not just at the next login.

## 5. Where the server-side code lives

`src/server.ts` - every route in sections 1 through 2f, the
`WebSocketServer` setup, and `broadcastSettings()`. `src/users.ts` -
the account store section 2a/2b talk to (scrypt hashing, role
model, `data/users.json` persistence). `src/metrics.ts` - the Prometheus
gauge definitions `GET /metrics` (section 2f) renders. `src/store.tsx`'s `HydraProvider`
and `src/components/AuthGate.tsx`/`UsersPanel.tsx` are the reference
CLIENT implementation of everything in this document - read them
alongside this file if a detail here is ambiguous, since the running code
is the actual source of truth and this document can drift.
