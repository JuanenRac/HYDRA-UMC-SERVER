<!-- =============================================================================
HYDRA-UMC-SERVER - Headless REST and WebSocket backend of the HYDRA-UMC micro-factory
Copyright (C) JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>

# 🤖 HYDRA-UMC-SERVER

<p align="center">🇺🇸 <b>English</b> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | <a href="README_ita.md">🇮🇹 Italiano</a> | <a href="README_deu.md">🇩🇪 Deutsch</a> | <a href="README_zho.md">🇨🇳 简体中文</a> | <a href="README_jpn.md">🇯🇵 日本語</a> | <a href="README_por.md">🇵🇹 Português</a></p>

### 🤖 Headless API/WebSocket Backend for the HYDRA-UMC Multi-Robot Micro-Factory

<p align="center">
  <img src="https://img.shields.io/badge/License-GPL%203.0--or--later-blue.svg" alt="GPL 3.0 or later">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Runtime">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Framework">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="Language">
  <img src="https://img.shields.io/badge/Protocol-WebSocket-lightgrey.svg" alt="Protocol">
  <img src="https://img.shields.io/badge/Tests-377%20passing-2ea44f.svg" alt="Tests">
  <img src="https://img.shields.io/badge/Version-0.8.1.3-0f6cbd.svg" alt="Version">
  <img src="https://img.shields.io/badge/Maturity-functional-0F6CBD.svg" alt="Maturity">
</p>

---

> **Honesty check - what actually runs today:** the Express + WebSocket engine, its REST and WebSocket surface (63 operations in 58 paths), JWT sign-in with refresh-token rotation and scrypt, mDNS discovery, robot reservations and revisions, playback, and the relays to CAN-OTA, telemetry, voice, the local AI services and the connector hub are real and tested against a live instance of this same server that the tests start themselves: 377 unit tests plus 28 end-to-end contract scripts, all passing. What is hardware-adjacent and not verified here: the link to a real HYDRA-UMC CM5 with an STM32H745 board, which is real code exercised only through the API and contract layer. TLS, Bluetooth LE, the MQTT bridge and the Prometheus and Grafana stack are real, optional and off by default.

---

> **Safety and security status:** this ecosystem is not a certified safety system. There is no hardware E-STOP path, no firmware-enforced limits or interlocks and no verified motion command yet; firmware images are checked with CRC-32 and an Ed25519 signature, and a release build refuses the published development keys (the tool heads and expansion boards behind the relay still run URTC bootloaders, which take a shared-key HMAC-SHA256 instead of a signature); TLS and mutual TLS are optional and off by default; no custom board has been populated or tested yet. Read the [security baseline](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md) and the [threat model](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md) before relying on any statement here for the safety of a person.

---

## 📋 At a glance

| | |
|---|---|
| Version | `0.8.1.3` |
| Maturity | Functional |
| Tests | 377 (`npm run test:unit`) |
| Stack | Node.js 20+ / Express / WebSocket (ws) / REST/OpenAPI |
| Target | The Raspberry Pi CM5 of a HYDRA-UMC cell |
| On real hardware | Not yet: no run on real hardware is recorded for this version |

**Jump to:** [Overview](#-overview) · [Architecture](#-architecture) · [Features](#-features) · [Security & Safety](#-security--safety) · [Interfaces](#-interfaces) · [Configuration](#-configuration) · [Quick start](#-quick-start) · [Testing](#-testing) · [Troubleshooting](#-troubleshooting) · [Repository Structure](#-repository-structure) · [Related Projects](#-related-projects)

## 🚦 Project status

Each line is one part of this repository and the light says how far it is today. It is written from what the repository can show (tests, builds, runs), not from what is planned.

🟢 Done and verified · 🟡 Works, with known limits · 🟠 Partly done or not verified yet · 🔴 Not done or not working

| Area | State | What it means here |
|---|---|---|
| Software | 🟡 | Works for its main purpose; the honesty check above lists what is still missing |
| Tests | 🟢 | 377 automated tests, run on every change |
| Real hardware | 🔴 | Not yet: no run on real hardware is recorded for this version |
| Documentation | 🟢 | README in eight languages, checked against the manifest on every change |

## 🎯 Overview

HYDRA-UMC SERVER is the standalone backend that drives a HYDRA-UMC
multi-robot micro-factory cell: a Node.js/Express + WebSocket engine that
owns robot state, persists it to disk, authenticates every write, and
broadcasts live updates to every connected client. It ships with no user
interface or frontend build step of its own - it is a pure API + WebSocket
service, meant to run headless (no browser, no display) on the machine
that actually sits next to the robots (typically a Raspberry Pi CM5).

The second contract is complete: conditional writes (`If-Match` on commands and claims, `GET /api/robot/:id`), the atomic `table` command, an append-only audit record (`GET /api/audit`, hash-chained, switchable) and a `claims` WebSocket message. Camera passwords no longer appear in the process list or in the log. See `docs/CONTRACT_V2.md`.

It CAN optionally also serve **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)'s**
own built frontend as static files, for the common "everything on one
machine, one origin" deployment - run **`build-frontend.sh`/`.bat`** once
(builds STUDIO from a sibling checkout and copies the output into this
repo's own `public/`, gitignored) and this server starts serving it at
`/` on its next start. This is what lets HYDRA-UMC-ANDROID-CONTROL,
HYDRA-UMC-IOS-CONTROL and HYDRA-UMC-DSI embed the real STUDIO 3D
viewport in their own in-app WebView, pointed at this same server's own
`ip:port`. Entirely opt-in: skip that script and this server stays
exactly as headless as described above - `public/` simply won't exist,
and every route keeps working identically either way.

The same `build-frontend.sh`/`.bat` also builds this repo's own
**[`admin-ui/`](admin-ui/README.md)** - a small, separate panel for
administering this SERVER itself (connected devices, its own log file,
its own port/name, its own user accounts), served at `/admin`. This is
deliberately NOT robot control (that stays STUDIO-only) - a narrow,
explicit exception to the headless design above, not a reversal of it.

This project used to be part of **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)**,
which shipped as a "hybrid monolith": one Node.js process that both ran
the robot-control engine *and* served the Vite/React web dashboard (with
Vite's own dev middleware wired straight into the same Express app). That
process has been split in two:

- **HYDRA-UMC SERVER** *(this repository)* - the engine: robot/controller
  state, the REST + WebSocket API, authentication, mDNS discovery, model
  submissions. No UI, no bundler, no frontend build step.
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** - now a
  pure Vite/React client that talks to this server over the network,
  exactly like every other client of this API already does.

## 🧩 Role in HYDRA-UMC

**HYDRA-UMC-SERVER** is the engine of the cell: a headless Node.js and Express backend that owns the robot state, saves it to disk, signs every write in with a role, and pushes live updates to every client over one WebSocket. All clients (STUDIO, SUITE, the phone apps, the touch screen, the watch, the command-line tool) go through it, and it alone decides who may move which robot and how far.

## 🏛️ Architecture

<p align="center">
  <img src="images/architecture.svg" alt="HYDRA-UMC-SERVER architecture" width="100%">
</p>

### Why This Exists

Splitting the engine out of the web dashboard was a deliberate change, not
a refactor for its own sake:

- **Resource isolation.** A heavy 3D view choking the browser's own tab no
  longer shares a process (and therefore CPU/I-O contention) with the code
  actually responsible for moving robots. If the web UI hangs, this server
  keeps answering emergency-stop commands from any other connected client.
- **A real headless controller.** This process can run with zero UI ever
  loaded on the host - the "brain" of an industrial cell doesn't need a
  browser tab open to function. Frees up RAM/CPU on constrained hardware
  (a Raspberry Pi CM5) for the part of the job that actually matters:
  kinematics and control.
- **Independent lifecycles.** The web UI can be redeployed, restarted, or
  hot-swapped for a newer build without ever touching this process - no
  robot-control downtime just to ship a UI fix.
- **Flexible hosting.** This server is meant to run on (or right next to)
  the hardware it controls; the client that renders it can be hosted
  anywhere else entirely, reachable over the network exactly like the
  other remote clients of this same API already are.

## ✨ Features

### Data & Persistence

Everything this server owns lives under `data/`, created automatically on
first run:

- `data/settings.json` - the full state tree: controllers, robots, system
  configuration. Never served as a static file (explicitly 404'd) - only
  reachable through the authenticated `/api/settings` route.
- `data/users.json` - account credentials (scrypt-hashed, salted, never
  plaintext). Also never served statically.
- `data/logs/server.log` - append-only industrial log of every command.
- `data/WORKS/` - saved robot trajectories, one folder per robot by
  default, served as plain static files (index + individual work files).
- `data/model_submissions.json` + the submitted model folders themselves -
  the server side of [HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)'s
  "push a finished robot model straight into this server's catalog" flow.
- `data/totp.json` - the second factor of the accounts that turned it on (optional, off for every account until its owner turns it on): each secret is encrypted with AES-GCM under `HYDRA_UMC_TOTP_KEY` (or a key derived from `JWT_SECRET`) and the ten recovery codes are kept only as hashes; the file does not exist until an account turns the second step on.

## 🔒 Security & Safety

| Threat | Defence | Where |
|---|---|---|
| Tokens signed with a known key | With `NODE_ENV=production` the server refuses to start with an empty, example or short `JWT_SECRET` and without a bootstrap administrator; in development a built-in value is used and a `[SECURITY]` warning is printed | `src/auth.ts`, `src/secretsPolicy.ts` |
| Brute force on the sign-in, or a flood of stops | 5 failed sign-ins per 15 minutes per address (`429`), 120 refreshes and 60 global stops per minute, all set by `LOGIN_RATE_LIMIT_MAX`, `REFRESH_RATE_LIMIT_MAX` and `STOP_ALL_RATE_LIMIT_MAX`; passwords use scrypt with a random salt, at most 4 at once and 20 queued, so a flood cannot starve the server | `src/auth.ts`, `src/users.ts` |
| A stolen token, or a token read from the address | Access tokens expire (`JWT_EXPIRES_IN`, 30 days by default, 24 h advised beyond a trusted LAN) and are renewed by a rotating refresh token; the WebSocket takes the token as the `hydra.bearer` subprotocol and refuses `?token=` unless `HYDRA_UMC_WS_QUERY_TOKEN=allow` opts back in, with a warning at every start | `src/refresh_tokens.ts`, `src/ws.ts` |
| Two clients moving the same robot, or a command that the robot should not get | A robot is reserved for one account and window, writes need `If-Match` (a stale revision gets `412`), the viewer role cannot write, and the size of a jog and the hottest heated-bed target come from the safety limits an administrator sets; the global stop works whatever the reservations say | `src/claimPolicy.ts`, `src/safetyLimits.ts`, `src/routes/commandRoutes.ts` |
| Camera pictures open to anyone on the network | Live streams, photos and recordings need a signed ticket that lasts 5 minutes (or a bearer token); at most 8 cameras; camera passwords stay out of the process list and the log; `HYDRA_UMC_CAMERA_AUTH=open` is the temporary opt-out | `src/mediaTickets.ts`, `src/serverPolicy.ts` |
| Oversized or hostile requests, and open cross-origin access | JSON bodies are capped at 1 MB (50 MB only on the large upload route); `CORS_ALLOWED_ORIGINS` is an allowlist and, in production, an unset list denies every cross-origin browser request (development allows any origin, with a warning); `settings.json` and `users.json` are never served as files | `src/server.ts` |
| Weak access options left on: voice text, recognizer confidence, MAVLink signing, Bluetooth, MQTT, TLS | Every one has a switch an administrator edits through `PUT /api/admin/server-config` (admin only), with a conservative default and the environment winning over what is saved; the response lists warnings such as `voice_heard_text_on`, `voice_confidence_off`, `mavlink_unsigned_allowed` and `mavlink_signing_off`; the voice relay replaces any `options` a client sends with the administrator's, and a MAVLink key file is checked (32 bytes or 64 hexadecimal characters) before its path is saved | `src/securityConfig.ts`, `src/routes/adminRoutes.ts`, `src/routes/assistantRoutes.ts` |
| A tampered record of who did what | An append-only audit record whose entries are hash-chained (`GET /api/audit`, `?verify=1` checks the chain), a server log that rotates by size, and a redaction step that removes secrets before anything is written | `src/auditLog.ts`, `src/logRotation.ts`, `src/redaction.ts` |

**What it never does:** act as a certified safety function. The limits and the stop are software in this process; no hardware E-STOP path, no firmware-enforced limit and no real controller board is behind it yet.

## 🔌 Interfaces

### API & WebSocket Surface

Every route, the WebSocket message contract, authentication, and the
per-client remote-access model are documented in
**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** - the single source of
truth for anything that talks to this server, including HYDRA-UMC
STUDIO's own client code. In short:

- REST API under `/api/*` - settings read/write, atomic robot commands
  (jog/play/pause/stop/tool/valve/pump/speed/vision), account management,
  work-file upload/download, model submissions, system metrics, discovery.
- A single `/ws` WebSocket endpoint (bearer token as the `hydra.bearer` subprotocol, a token in the query string is refused unless the installation opts back in)
  broadcasting full-tree `settings` snapshots and lighter `delta` updates
  to every connected client whenever state changes.
- `POST /api/stop-all` is the global stop: one call, open to every signed-in account, stops every robot and switches every valve and pump off
  whatever any reservation says, and answers one result per robot.
- Bluetooth LE (off by default): a phone near the CM5 can read the robot state and, when an administrator allows it, send commands that the server acknowledges only after the same route a network client uses has answered. See [`docs/BLE_GATT.md`](docs/BLE_GATT.md).
- JWT bearer-token authentication on every write; three account roles
  (`admin`, `operator`, read-only `viewer`) gate settings/user-management writes versus
  day-to-day robot operation and read-only polling.
- `_hydra._tcp` mDNS/Bonjour advertising for zero-config discovery on the
  local network, plus a plain `GET /api/hydra-info` for a subnet scan.
- `GET /metrics` - Prometheus exposition format (`prom-client`), for the
  optional Grafana dashboard described in "📊 Monitoring" below.

CORS is enabled via a configurable allowlist (`CORS_ALLOWED_ORIGINS`, see
"Environment Variables" below) since this server's clients are no longer
guaranteed to share its own origin. Unset, it stays wide open outside
`NODE_ENV=production` (today's zero-config behavior for local dev); in
production it denies every cross-origin browser request until the
allowlist is set - see the comment above `app.use(cors(corsOptions))` in
`src/server.ts` for the full reasoning.

### Monitoring (Optional)

`GET /metrics` exposes process uptime, connected WebSocket clients,
`settings.json` write latency, atomic robot commands by type, authentication
failures, and the same CPU/memory/temperature figures as
`GET /api/system/metrics` - all in Prometheus format. A ready-to-run
Prometheus + Grafana stack (with a starter dashboard) lives in
**[`monitoring/`](monitoring/README.md)**: `docker compose up -d` from that
folder and it's running. Entirely optional - nothing here is needed for the
server itself to work.

| Topic or route | What it carries |
|---|---|
| `/api/login`, `/api/refresh`, `/api/logout` | sign in (rate limited), rotate the refresh token, sign out |
| `/api/users`, `/api/users/:username` | list, create, change and delete accounts (`admin`, `operator`, `viewer`); admin only |
| `/api/settings`, `/api/robot/:id`, `/api/robot/:id/command` | the state tree and the atomic typed commands (jog, play, pause, stop, tool, valve, pump, speed, vision, table), with `If-Match` |
| `/api/robot/:id/claim`, `/release`, `/jog-arm`, `/api/claims`, `/api/stop-all`, `/api/safety-limits` | reservations, arming the jog, who holds what, the global stop and the safety limits |
| `/api/admin/server-config`, `/clients`, `/logs`, `/restart`, `/safety-limits` | administration: the access switches, the connected apps, the server log, a restart and the safety limits; admin only |
| `/api/camera/*`, `/api/cameras/status` | camera streams, snapshots, recordings, PTZ and `POST /api/camera/ticket` |
| `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/system/bluetooth/*` | host information, the process supervisor, the status and control of the ecosystem services, Bluetooth pairing |
| `/api/voice/turn`, `/api/voice/confirm`, `/api/watch/system-status`, `/api/ai/*` | relays to the voice service, the watch status and the local AI services |
| `/ws` | one WebSocket: full `settings` snapshots, light `delta` updates and a `claims` message; the token travels as the `hydra.bearer` subprotocol |
| `GET /api/hydra-info`, `_hydra._tcp` | discovery: the remote contract version (`remoteApiVersion` 2), the app version and the counts of controllers and robots, advertised over mDNS |
| `/admin`, `/dashboard-ai`, `/` | optional static pages, served only when `build-frontend` has built them next to this repository: the admin panel, DASHBOARD-AI and STUDIO |
| `/metrics` | Prometheus text: uptime, WebSocket clients, write latency, commands by type, authentication failures, host figures |

## ⚙️ Configuration

### Environment Variables

Optional - the server runs with zero configuration out of the box, using
built-in development-friendly defaults for every variable below. Set real
values before exposing this server beyond a fully trusted LAN - e.g. over
the open internet via a router's NAT/port-forward, which changes the
threat model from "trusted LAN only" to "reachable by anyone" (see
`.env.example`):

- `JWT_SECRET` - signs every login token. If unset, a fixed development
  value baked into `src/server.ts` is used instead (fine for local
  development, not for a deployment reachable outside a trusted network).
  Export it in your shell, or through your process manager/container of
  choice (systemd `Environment=`, `pm2`'s own env config, Docker `-e`, ...).
- `NODE_ENV` - set to `production` for any real deployment. Gates the two
  fallbacks below (open CORS, silent defaults) and turns on loud startup
  warnings if `JWT_SECRET` or the seeded `admin`/`admin` account are still
  at their defaults. Unset (or anything else) keeps today's permissive
  development behavior.
- `CORS_ALLOWED_ORIGINS` - comma-separated list of origins allowed to make
  cross-origin browser requests to this API - the real case this matters
  for is HYDRA-UMC STUDIO served from a different host/port than this
  server (e.g. `https://studio.example.com`, or `http://192.168.1.20:5173`
  in dev). Example:
  `CORS_ALLOWED_ORIGINS=https://studio.example.com,http://192.168.1.20:5173`.
  If unset: `NODE_ENV != production` allows any origin (zero setup needed
  for local dev, matches this project's historical behavior); `NODE_ENV =
  production` instead **denies** every cross-origin browser request until
  this is set, with a loud startup warning. Non-browser clients (curl,
  HYDRA-UMC SUITE, the mobile control apps) are never affected either way -
  CORS is a browser-only mechanism.
- `JWT_EXPIRES_IN` - how long a login token stays valid. Any string
  `jsonwebtoken`'s own `expiresIn` option accepts (`"24h"`, `"7d"`, a bare
  number of seconds, ...). Defaults to `30d` if unset (this project's
  original trusted-LAN assumption). **A server reachable beyond a trusted
  LAN should set this much shorter - `24h` is a reasonable starting
  point** - a leaked long-lived token has no way to be individually revoked
  short of changing that account's password.
- `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` - throttles
  `POST /api/login` only (every other route is unaffected). Defaults to 5
  attempts per 15 minutes per IP if either is unset; a tripped limit
  responds `429` with a clear JSON error, not a generic `500`.
- `REFRESH_RATE_LIMIT_MAX` - request budget of `POST /api/refresh` per window and IP (default 120). Only failed logins count towards the login limit above.
- `TLS_CERT_PATH` / `TLS_KEY_PATH` - set **both** to switch the server
  (REST API + the `/ws` WebSocket, which shares the same listener) from
  plain HTTP/WS to HTTPS/WSS. See "TLS / HTTPS" below. Leaving either
  unset keeps today's plain HTTP behavior unchanged.
- `HYDRA_UMC_CAMERA_AUTH` - the camera pictures (live streams, saved photos and recordings) demand a short-lived `?ticket=` (`POST /api/camera/ticket` hands one to a signed-in client) or a Bearer token **by default**; `HYDRA_UMC_CAMERA_AUTH=open` is the temporary opt-out for clients that do not ask for tickets yet.
- `HYDRA_UMC_WS_QUERY_TOKEN` - `/ws?token=` is **refused by default** (the token travels as the `hydra.bearer` subprotocol); `HYDRA_UMC_WS_QUERY_TOKEN=allow` is the temporary opt-out for clients that have not moved yet. The server warns at every start while an opt-out is set.
- `HYDRA_UMC_BLE_GATT` - the Bluetooth LE service: `off` (the default), `state` (phones read the state) or `commands` (and send commands, each with the access token of the account). `HYDRA_UMC_BLE_ENCRYPTION=off` stops asking for an encrypted link (it is asked by default). Both can also be set from the Server Admin screen; a change applies on the next start. Needs BlueZ, `python3-dbus` and `python3-gi` on the host.
- `HYDRA_UMC_MQTT_BRIDGE` - the bridge to the MQTT broker of the cell: `off` (the default), `state` (the state of every robot goes out on retained topics) or `commands` (and a command published on a robot's topic is carried out, through the same route a network client uses, with the token of a dedicated account named by `HYDRA_UMC_MQTT_COMMAND_USER`). The address, the topic prefix and the user names can also be set from the Server Admin screen; the passwords only from the environment. See [`docs/MQTT_BRIDGE.md`](docs/MQTT_BRIDGE.md).
- `HYDRA_UMC_INFO_AUTH=required` - makes the read-only host information (`/metrics`, `/api/system/metrics`, `/api/system/supervisor`, `/api/ecosystem/status`, `/api/models`) demand a signed-in client. Off by default so that a client that does not send its token on those routes yet keeps working; a production start warns while it is off.
- `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` - the voice and UAV options an administrator can also set from Server Admin (`voice` and `mavlink` in `data/server-config.json`): whether a voice reply repeats what was said (`1` to switch it on; off by default), the least confidence of the speech recognizer (0 to 1, default 0.6) before a request that starts a movement is accepted, and the MAVLink 2 signing key file and whether unsigned messages are still accepted (signing off and unsigned refused by default). The environment wins over what is saved, and then the screen shows the value as fixed.
- `HYDRA_UMC_AI_ACCESS=admin` - limits the relay to the local AI services (`/api/ai/*`) to administrators. Off by default, so any signed-in user can use it, as before.
- `HYDRA_UMC_VISUAL_SERVOING_TOKEN`, `HYDRA_UMC_VLA_ENGINE_TOKEN`, `HYDRA_UMC_COGNITIVE_NODE_TOKEN`, `HYDRA_UMC_DETECTION_HEF_TOKEN`, `HYDRA_UMC_VISION_NODE_TOKEN` and `HYDRA_UMC_ANOMALY_TOKEN` (for the relay `/api/ai/*`), `HYDRA_UMC_VISION_STREAMER_TOKEN` (for the camera streams) and `HYDRA_UMC_DATALAKE_READ_TOKEN`, else `HYDRA_UMC_DATALAKE_TOKEN` (for the telemetry) - the Bearer token this server presents to a service that asks for one; each also reads `..._FILE`, a file whose first line is the token. They are the names the services themselves read, so one environment file serves both, and no client ever sees them. A service with no token configured is reached exactly as before. The relay also refuses a session that is neither an administrator nor an operator, and only an administrator may change the baseline of the anomaly detector (any `POST` other than `/detect`); `vision-node` and `anomaly-detector` join the relay.
- `HYDRA_UMC_VOICE_UI_RESULT_KEY` (or `..._FILE`) - the key HYDRA-UMC-VOICE-UI signs a confirmed voice result with (16 characters or more, the same value it holds). `POST /api/voice/confirm` relays a confirmation with the signed-in user as its subject and believes a `confirmed` answer only if it names that user and its signature verifies; without the key the answer is passed on with `verified: false`, and `HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE=1` refuses it instead. Nothing is executed by this route.
- `HYDRA_UMC_TELEMETRY_COLLECTOR_URL` (with `HYDRA_UMC_TELEMETRY_COLLECTOR_TOKEN` or `..._FILE`, and `HYDRA_UMC_TELEMETRY_INTERVAL_MS`, 100 to 60000, 1000 by default) - turns the telemetry producer on: the numbers of every robot delta this server broadcasts (position, joints, playback state) are sent to HYDRA-UMC-TELEMETRY-COLLECTOR as one `robot_state` sample per robot, at most one per interval, merged, so the data lake has something real to keep. Off when the address is missing; it never delays a command, keeps a bounded amount of data and pauses for 30 seconds after a failure.
- `/dashboard-ai` - when HYDRA-UMC-DASHBOARD-AI is checked out next to this repo, `build-frontend` builds it and this server serves it there. The page reads the data lake (`/api/ai/datalake/*`, read-only: `GET` of `/query`, `/aggregate`, `/stats`, `/stats/range`, `/series` and `/health`, anything else is refused) and the anomaly detector (`/api/ai/anomaly-detector/*`) through the relay, with the session of the person who signed in to STUDIO in the same browser, so the roles and the service tokens of this server apply. With that in place the anomaly detector can be started with `HYDRA_UMC_ANOMALY_PROTECT_READS=1`.
- `HYDRA_UMC_LOG_MAX_BYTES` and `HYDRA_UMC_LOG_KEEP` - the size at which the server log rotates (default 10 MB) and how many rotated files are kept (default 1).
- `HYDRA_UMC_SETTINGS_STORE`, `HYDRA_UMC_SETTINGS_BACKUPS` and `HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S` - by default the settings (`settings.json` and the points files) are written as one all-or-nothing unit with a journal: an interrupted write is finished or discarded on the next start, a copy of `settings.json` is kept in `data/backups/` (10 copies, at most one every 600 s) and a damaged `settings.json` is restored from the newest good copy. `HYDRA_UMC_SETTINGS_STORE=plain` goes back to writing the files one by one; `HYDRA_UMC_SETTINGS_BACKUPS=0` turns the copies off.
- The AI relay access, the sign-in requirement of the host information and the optional, off by default TLS (certificate and key paths, with the SHA-256 fingerprint of the certificate) can also be changed by an administrator from the Server Admin screen of the control app. A value set in the environment wins and is shown as locked; the sign-in requirement asks for confirmation before it is turned off; the optional TLS applies on the next start.
- `STOP_ALL_RATE_LIMIT_MAX` / `STOP_ALL_RATE_LIMIT_WINDOW_MS` - budget of the global stop (`POST /api/stop-all`) per address, separate from the login's (default 60 per minute). In production the server also refuses to start with an example `JWT_SECRET`/bootstrap password from a deployment template, a `JWT_SECRET` under 32 characters or a bootstrap password under 12.

### TLS / HTTPS

Off by default - this server has always run as plain HTTP/WS, and still
does unless you opt in. Set both `TLS_CERT_PATH` and `TLS_KEY_PATH` (see
above) to a PEM certificate and its matching private key, and the shared
REST + WebSocket listener switches to `https.createServer()` - `/ws`
automatically becomes WSS along with it, no separate configuration needed.
A cert/key path that's set but unreadable or invalid fails startup loudly
(a real `fs` error) rather than silently falling back to plain HTTP.

This matters most once this server is reachable beyond a fully trusted
LAN (e.g. exposed via a router's NAT/port-forward for remote testing) -
plain HTTP means every bearer token, every robot command, and the
admin/operator login itself cross the network in clear text.

Getting a certificate:

- **You own a domain pointing at this server** - use
  [Let's Encrypt](https://letsencrypt.org/) (e.g. via
  [Certbot](https://certbot.eff.org/)) for a real, browser-trusted
  certificate, free and automatically renewable. Point `TLS_CERT_PATH` /
  `TLS_KEY_PATH` at the resulting `fullchain.pem` / `privkey.pem`.
- **Local testing, no domain** - a self-signed certificate is enough to
  exercise the HTTPS/WSS code path (browsers and most HTTP clients will
  warn/require an explicit trust override, which is expected and fine for
  testing):
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
  ```
  Then set `TLS_CERT_PATH=./cert.pem` and `TLS_KEY_PATH=./key.pem`.

The access switches below are the ones the Server Admin screen of STUDIO and SUITE edits. Each one resolves in the same order: the environment of the deployment first (the screen shows it as locked), then what the administrator saved in `data/server-config.json`, then the conservative default. The variables listed above cover everything else.

| Variable | Default | What it sets |
|---|---|---|
| `aiAccess`, `HYDRA_UMC_AI_ACCESS` | `open` | who may use the local AI relay: `open` is any signed-in account, `admin` only administrators |
| `infoAuth`, `HYDRA_UMC_INFO_AUTH` | off | ask for a sign-in on the read-only host information (metrics, process supervisor, ecosystem status) |
| `tls.enabled`, `TLS_CERT_PATH, TLS_KEY_PATH` | off (plain HTTP) | HTTPS and WSS with the certificate and key you name; the screen shows the fingerprint of the certificate in use |
| `ble.mode`, `HYDRA_UMC_BLE_GATT` | `off` | Bluetooth LE for phones near the server: `off`, `state` (publish the state only) or `commands` (also take commands); an unknown word means off |
| `ble.requireEncryption`, `HYDRA_UMC_BLE_ENCRYPTION` | on | the command characteristic is written, and the state read, only over an encrypted link; only `off` in the variable turns it off |
| `mqtt.mode`, `MQTT environment of the deployment` | `off` | the MQTT bridge to the broker of the cell: `off`, `state` or `commands`, with its URL, prefix and users |
| `voice.includeHeardText`, `HYDRA_UMC_VOICE_UI_INCLUDE_HEARD_TEXT` | off | a voice reply repeats what was said; that is personal data, so it is off, and in the variable only the exact word `1` turns it on |
| `voice.minConfidence`, `HYDRA_UMC_VOICE_UI_MIN_CONFIDENCE` | `0.6` | the least confidence of the speech recognizer, from 0 to 1, to accept a request that starts a movement; 0 switches the check off, a stop is never held back, and a bad number in the variable is ignored |
| `mavlink.signingKeyFile`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_KEY_FILE` | empty (no signing) | MAVLink 2 signing of the UAV bridge: the path of a file with the 32-byte key (32 raw bytes or 64 hexadecimal characters); only the path is saved, never the key, and the bridge reads it when it starts |
| `mavlink.signingAllowUnsigned`, `HYDRA_UMC_BRIDGE_UAV_SIGNING_ALLOW_UNSIGNED` | off | still accept messages that are not signed (a vehicle that does not sign yet); the screen warns while it is on |

## 🚀 Quick start

Requires Node.js 22 or newer with npm. The server runs with no configuration and development-friendly defaults; set the variables of the Configuration section before it is reachable beyond a trusted LAN.

```bash
npm install
./dev.sh                    # runs the server with tsx on port 3000, no frontend (dev.bat on Windows)
npm run test:unit           # the unit tests
npm test                    # unit tests, the OpenAPI check and the contract scripts against a live instance
npm run build && npm start  # one bundled file (build.sh and build.bat make a versioned release build)
```

The server listens on `0.0.0.0:3000`; all its state lives in `data/`. This repository has no Dockerfile on purpose: HYDRA-UMC-OS installs it on the CM5 (`provisioning/install_server.sh`). The running version is readable from `GET /api/hydra-info` (`appVersion`); only the root `build*.sh` and `build*.bat` scripts make a versioned release build, while `npm run build` only compiles.

## 🧪 Testing

377 automated tests run with `npm run test:unit`. On top of them `npm test` runs the OpenAPI check and 28 end-to-end contract scripts under `tools/` against a live instance of this server (discovery, sign-in without and with credentials, production bootstrap, robot commands and ownership, refresh tokens, voice relay and its error paths, playback, the global stop, Bluetooth and MQTT bridges, camera media, the AI and connector-hub relays, viewer role and more); all of them pass. None needs hardware.

The CI runs `HYDRA_UMC_CI=1 python tools/ci_validate.py`, which checks the manifest, the documents, the eight READMEs and the pictures.

## 🏗️ Build & Release

### Requirements

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- npm

### Installation

```bash
npm install
```

### Development Mode

Runs the API/WebSocket server directly with `tsx` (no bundler, no
frontend involved):
- **Windows:** double-click `dev.bat` or run `npm run dev`
- **Linux/Mac:** run `./dev.sh` or `npm run dev`

### Production Build

Bundles the server into a single deployable file with esbuild:
- **Windows:** use `build.bat` for a versioned release build; use `npm run build` for a compile-only build.
- **Linux/Mac:** use `./build.sh` for a versioned release build; use `npm run build` for a compile-only build.

Then start the production server with:
```bash
npm start
```

The server listens on `0.0.0.0:3000` - reachable at `http://localhost:3000`
or `http://<your-local-ip>:3000` across the local network. All state
persists in `data/`.

This repository has no Dockerfile on purpose: the server is packaged and installed on the CM5 by [HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS) (`provisioning/install_server.sh`).

## 🩺 Troubleshooting

| You see | Because | Do |
|---|---|---|
| The server stops at start-up in production | `NODE_ENV=production` demands a real `JWT_SECRET` (at least 32 characters, not an example) and a bootstrap administrator on the first start | Set `JWT_SECRET`, `HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME` and `HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD` (see `docs/PRODUCTION_BOOTSTRAP.md`) |
| `429` on sign-in | More than 5 failed sign-ins from one address inside 15 minutes | Wait for the window to pass; raise `LOGIN_RATE_LIMIT_MAX` only on a trusted network |
| The browser app is blocked by CORS | In production an unset `CORS_ALLOWED_ORIGINS` denies every cross-origin browser request (curl, SUITE and the phone apps are not affected) | Set `CORS_ALLOWED_ORIGINS=https://studio.example.com,...` with the origins of the page |
| The WebSocket closes at once, or a camera picture does not load | The client sends the token in the address (`/ws?token=`, refused by default) or opens the picture without a ticket (required by default) | Use the `hydra.bearer` subprotocol and `POST /api/camera/ticket`; the opt-outs `HYDRA_UMC_WS_QUERY_TOKEN=allow` and `HYDRA_UMC_CAMERA_AUTH=open` are temporary |
| An access switch is refused because it is locked, or a MAVLink key file is refused | The value is set by an environment variable (it wins over the saved one), or the key file cannot be read or is not 32 bytes or 64 hexadecimal characters | Change or remove the variable and restart, or fix the file; the MAVLink bridge reads its options when it starts |

## 📂 Repository Structure

<p align="center">
  <img src="images/repository-structure.svg" alt="Repository structure of HYDRA-UMC-SERVER" width="100%">
</p>

<details>
<summary>Text version of the tree</summary>

```text
HYDRA-UMC-SERVER/
├── src/                       source code
│   ├── server.ts              Thin startup that wires the modules below together; the /api routes live in src/routes/, the live connections in ws.ts, the settings files in settingsStore.ts
│   ├── kinematics.ts          Inverse-kinematics helper for the atomic jog endpoint
│   ├── metrics.ts             Backs GET /metrics - Prometheus text exposition (prom-client)
│   ├── ble/                   Bluetooth LE service: framing, gateway (commands, acknowledgements, state) and the helper transport
│   ├── users.ts               Account store (scrypt password hashing)
│   ├── routes/                The /api routes by area: auth, settings, robot claims, commands, safety limits, cameras, Bluetooth, admin, system, relays to the sibling services, local AI, assistant, work files, power, info and static files
│   ├── auth.ts                Token verification, the admin gate and the rate limiters; the refresh-token store; what production accepts as its signing secret and first password; the access options; the tokens presented to the relayed services
│   ├── claimPolicy.ts         Who controls which robot; the edits an operator makes on one robot; the limits every client is held to; the XY-table move in one request; the server-authoritative playback
│   ├── settingsStore.ts       The settings files on disk, their backups, all-or-nothing writes of several files, the audit record and log rotation
│   ├── ws.ts                  The live connection hub (WebSocket), the MQTT bridge to the broker of the cell and its start-up, and the first telemetry producer
│   ├── cameraHealth.ts        Whether a camera stream really delivers frames, IP-camera probing and PTZ, the stream process supervisor, and short-lived tickets for the camera pictures
│   └── ecosystemStatus.ts     Ecosystem discovery and liveness, the registry of service ports, host metrics, the process runtime (mDNS, port), pure policy helpers, secret redaction, Bluetooth pairing helpers, the upstream addresses and the confirmation of a spoken request
├── admin-ui/                  Separate Vite/React admin panel for THIS server itself
├── data/                      Runtime state - settings, users, logs, work files, saved points
├── docs/                      documents of the project
├── images/                    Media and diagrams
├── systemd/                   service unit
├── tools/                     project tools and CI checks
├── tests/                     automated tests
├── monitoring/                Optional Prometheus + Grafana stack - see monitoring/README.md
├── scripts/                   the Bluetooth LE helper (BlueZ) and a legacy version helper
├── .github/                   CI workflow and issue templates
├── bump_manifest_version.py   Syncs hydra-umc.project.json's version to the native one (--sync)
├── build.bat / build.sh       Install deps + production build
├── dev.bat / dev.sh           Install deps + start the dev server
├── package.json               package metadata and scripts
├── tsconfig.json              TypeScript configuration
├── CHANGELOG.md               what changed in each version
├── LICENSE
├── build-test.sh              non-mutating build check
├── hydra-umc.project.json     manifest: version, maturity, family
└── test.sh                    runs the tests
```

</details>

## 🗺️ Roadmap & Known limits

**Known limits today**

* The link to a real CM5 with an STM32H745 board (`spi_bridge`) is real code that was exercised through the API and contract layer only; there was never a physical board to close the last hop.
* The server listens on all interfaces (`0.0.0.0`); there is no switch for the listening address yet, so a firewall or the access switches above are what limit exposure.
* In development (`NODE_ENV` not `production`) a built-in signing key, the account `admin`/`admin` and an open CORS policy are used, each with a warning; production refuses them.
* TLS, Bluetooth LE and the MQTT bridge are optional and off by default.

**Next:** every new route follows the same checklist (documented in `docs/REMOTE_API.md`, named in `docs/openapi.json`, typed in the clients of the SDK).

## 🌍 Languages

This README and the documents of the repository exist in eight languages: English, Spanish, German, French, Italian, Japanese, Chinese and Portuguese (Portugal). They are written together and checked in the CI so that the eight files have the same sections and the same links. This repository has no screen or message catalogue of its own, so there are no interface strings to translate.

## 🔗 Related Projects

This project is part of the HYDRA-UMC robotics ecosystem by the same author (JuanenRac / Electro Hobby 3D). Worth knowing about, since a request might actually be about one of these rather than this repository.

**Child Projects** — every one of these is a real client or coordination bridge that only ever talks to the robot fleet through this server's own API
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — web control dashboard with real-time multi-robot 3D visualization.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — desktop (PySide6) swarm command center for multiple servers at once, packaged as a standalone executable.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — native Android control app with biometric login and a paired Wear OS companion.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — iOS/iPadOS control app (Flutter) with real-time WebSocket sync.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — native touch UI for the onboard 7" DSI touchscreen, embedded on the CM5 itself.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — coordination boundary for AGV/AMR fleets via a VDA 5050 MQTT publisher (tested against an emulated fleet only).
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — high-level CNC-cell coordinator with GRBL status/control-byte access (tested against an emulator only).
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — coordination boundary for legged/humanoid droids, with a Boston Dynamics Spot command sender (tested against an emulator only).
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — laser-cell coordinator reading 3 key/enclosure/interlock GPIO signals (tested against a fake chip only; it cannot arm or fire a laser).
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — safe high-level board-flow coordinator for OpenPnP pick-and-place.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — safe coordination boundary for Moonraker/Klipper 3D printers, with real gated job commands.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — coordinator with a lazily imported rclpy ROS 2 transport (not yet run against a ROS 2 installation).
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — coordination boundary for camera-equipped UAVs, with a MAVLink command sender (tested against an emulator only).

**Directly Related**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — this server relays bounded, authenticated voice turns to it over a loopback connection, retaining the gateway token server-side so voice never becomes a direct robot command.
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — the robot-arm motherboard design (no populated board yet); this server's own `spi_bridge` service is meant to talk to it over the CM5↔STM32H745 SPI-OTA link (tested against fakes only).

**Also Part of the Ecosystem**

*Core Hardware & Platform*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — reproducible Raspberry Pi OS product layer for the CM5 this server runs on: read-only agent, validated config/profiles, WiFi first-contact provisioning.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — the shared JSON-Schema contract and software job-gate boundary every bridge validates its commands against (not a certified safety function).
- **[HYDRA-UMC-CONNECTOR-HUB](https://github.com/JuanenRac/HYDRA-UMC-CONNECTOR-HUB)** — declarative adapter-manifest registry and validator for external-machine connectors; extends the SDK's own contract idea to external machines without replacing the industrial-gateway projects.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — desktop graphical URDF creator/editor that pushes finished models into this server's own catalog.
- **[HYDRA-UMC-EDITOR-STL](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-STL)** — desktop STL model editor, transforming/replacing/removing/adding real parts in the same model catalog HYDRA-UMC-EDITOR-URDF also edits.

*URTC Tool Platform*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware for the physical Universal Robot Tool Controller PCB, 25+ tool profiles over CAN bus.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — desktop GUI flashing tool for URTC boards, CAN-OTA plus full-chip SWD/JTAG.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — desktop live CAN-bus diagnostic tool for URTC boards, one panel per tool profile.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — browser-based alternative to URTC-TESTER via the Web Serial API, no local install needed.
- **[URTC-GATEWAY](https://github.com/JuanenRac/URTC-GATEWAY)** — gateway in front of the URTC CAN bus: an allowed list of identifiers, a rate limit and a session key; software tested on a computer, not yet on a real bus.

*Vision AI Node (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — integration hub for the Hailo-8 vision pipeline, with a real per-stage hardware-readiness check.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — real compiled-model registry with Hailo-architecture/checksum safe-load verification.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — real GStreamer pipeline + MediaMTX config generator with a real HailoRT integration boundary.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — Position-Based Visual Servoing correction law with authorisation gated on the zone state; no camera pose estimation yet.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — v0 zone-breach, calibration-freshness and E-STOP-request logic that takes object positions from a file; no detector feeds it and no physical E-STOP is wired to it yet.

*Cognitive AI Node (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — integration hub for the Hailo-10 cognitive pipeline (LLM/VLA/voice orchestration).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — real action-token encoding/decoding and trajectory generation for a Vision-Language-Action model.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — real rule-based task decomposition and semantic error recovery over MCU error codes.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — real stdlib-only TF-IDF document search over this ecosystem's own Markdown docs.
- **[HYDRA-UMC-LOCAL-TECHNICIAN](https://github.com/JuanenRac/HYDRA-UMC-LOCAL-TECHNICIAN)** — local, policy-gated AI maintenance technician for the ecosystem itself - observes, diagnoses and proposes fixes; the two highest risk levels are deliberately not implemented yet.

*Orchestration & Swarm*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — integration hub with a real gRPC/Protobuf health-report contract and mission state machine.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — real priority-based job queue with deduplication, over a real HTTP API.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — real gRPC-based fleet health watchdog with retry/backoff and identity-mismatch detection.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — real RRT-based 3D path planner with real obstacle/workspace collision validation.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — real CRDT LWW-Element-Map state sync, property-tested for multi-cell convergence.

*Digital Twin & Simulation*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — integration hub for the digital-twin engine, with a real version-compatibility sync contract.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — hardware-in-the-loop router with a software collision interlock between simulation and real hardware (tested without real hardware).
- **[HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)** — real forward kinematics and joint-limit validation over a real URDF subset.
- **[HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)** — real procedural 2D scene generator with YOLO/COCO annotation export.

*Data & Analytics*
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — real sqlite3-backed time-series store with a real ingest/query HTTP API.
- **[HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)** — real FFT + statistical baseline anomaly detector with drift monitoring.
- **[HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)** — real OEE/availability calculation over DATALAKE history, with reproducible CSV export.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — real CAN/WebSocket ingestion pipeline into DATALAKE, with sequence deduplication.

*Industrial Gateway*
- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — integration hub relaying to industrial protocols, with a real command allowlist/backpressure layer.
- **[HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)** — real OPC-UA address space, verified with a real binary-protocol client session.
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** — real MQTT broker with optional per-client authentication and topic ACLs.
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** — real MTConnect `/probe` and `/current` XML endpoints with degraded-mode output.

*Complementary Tools & Ecosystem Operations*
- **[HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)** — Smart Summaries and Anomaly Highlighting panels over DATALAKE/ANOMALY-DETECTOR, with an honest statistical fallback.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — fleet CLI with a real, stable exit-code contract, a genuine live client of this server's own API.
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — WearOS companion app with haptic alert patterns and a paired-phone voice relay (not yet run on a physical watch).
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware for a board-mounting rack with real tool-ID decoding and Smart Idle pre-heating logic.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware plus a real Python vision companion for a thermal/RGB inspection tool head.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — administrative desktop tool that discovers, clones and updates every repo in this ecosystem.
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — Windows/Linux desktop tool that builds a ready-to-flash CM5 image pre-loaded with the ecosystem's most current versions, with Raspberry-Pi-Imager-style first-boot Wi-Fi/user/SSH configuration.
- **[HYDRA-UMC-OPS-AGENT](https://github.com/JuanenRac/HYDRA-UMC-OPS-AGENT)** — maintenance-incident coordinator: a low-privilege edge role collects a sanitized inventory/health snapshot, a control-plane role renders it read-only and asks an AI provider to suggest a diagnosis - never applies a patch or deploys anything.
- **[HYDRA-UMC-DEV-SERVER](https://github.com/JuanenRac/HYDRA-UMC-DEV-SERVER)** — reproducible development host (Raspberry Pi 5 / CM5) that stores the ecosystem's source and runs bounded build/test tasks under a durable queue; a dedicated dev role, explicitly not an operational CM5.

## 📚 Documentation

Where to read more:

* [Security baseline of the ecosystem](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/SECURITY_BASELINE.md)
* [Threat model of the ecosystem](https://github.com/JuanenRac/HYDRA-UMC-DOCS/blob/main/docs/THREAT_MODEL.md)
* [Changelog of this repository](CHANGELOG.md)
* [License of this repository](LICENSE.md)

## 🤝 Contributing & Community

* Before a pull request run `HYDRA_UMC_CI=1 py -3 tools/ci_validate.py` (or `HYDRA_UMC_CI=1 python3 tools/ci_validate.py`): it must print `CI_VALIDATION=PASS`. Do not run `build.sh` or `build.bat` for this check; building is not a check.
* The eight READMEs are written from one source in HYDRA-UMC-DOCS; do not edit them by hand. Change the source and write them again with `tools/make_readmes.py`.
* Do not state in a README what has not run: say "simulated" or "not tried on hardware" where that is the truth.
* See [CONTRIBUTING.md](CONTRIBUTING.md), the [code of conduct](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md) and [SUPPORT.md](SUPPORT.md).

## 👤 AUTHOR

**JuanenRac (Electro Hobby 3D)** · electrohobby3d@gmail.com

## 📜 LICENSE

GPL-3.0-or-later - [LICENSE](LICENSE).
