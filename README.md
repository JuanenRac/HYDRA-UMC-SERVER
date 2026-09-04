<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-SERVER banner" width="100%">
</p>
# 🛰️ HYDRA-UMC SERVER

<p align="center">
  🇺🇸 <b>English</b> |
  <a href="README_spa.md">🇪🇸 Español</a> |
  <a href="README_fra.md">🇫🇷 Français</a> |
  <a href="README_ita.md">🇮🇹 Italiano</a> |
  <a href="README_deu.md">🇩🇪 Deutsch</a> |
  <a href="README_zho.md">🇨🇳 简体中文</a> |
  <a href="README_jpn.md">🇯🇵 日本語</a>
</p>


### 🤖 Headless API/WebSocket Backend for the HYDRA-UMC Multi-Robot Micro-Factory

<p align="left">
  <img src="https://img.shields.io/badge/License-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Runtime-Node.js-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Framework-Express-000000.svg" alt="Express">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/Protocol-WebSocket-lightgrey.svg" alt="WebSocket">
</p>


---

## 🎯 Overview

HYDRA-UMC SERVER is the standalone backend that drives a HYDRA-UMC
multi-robot micro-factory cell: a Node.js/Express + WebSocket engine that
owns robot state, persists it to disk, authenticates every write, and
broadcasts live updates to every connected client. It ships with no user
interface or frontend build step of its own - it is a pure API + WebSocket
service, meant to run headless (no browser, no display) on the machine
that actually sits next to the robots (typically a Raspberry Pi CM5).

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

## 🧩 Why This Exists

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

## 🔌 API & WebSocket Surface

Every route, the WebSocket message contract, authentication, and the
per-client remote-access model are documented in
**[`docs/REMOTE_API.md`](docs/REMOTE_API.md)** - the single source of
truth for anything that talks to this server, including HYDRA-UMC
STUDIO's own client code. In short:

- REST API under `/api/*` - settings read/write, atomic robot commands
  (jog/play/pause/stop/tool/valve/pump/speed/vision), account management,
  work-file upload/download, model submissions, system metrics, discovery.
- A single `/ws` WebSocket endpoint (bearer token in the query string)
  broadcasting full-tree `settings` snapshots and lighter `delta` updates
  to every connected client whenever state changes.
- JWT bearer-token authentication on every write; two account roles
  (`admin`, `operator`) gate settings/user-management writes versus
  day-to-day robot operation.
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

## 💾 Data & Persistence

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

## 📂 Repository Structure

```
HYDRA-UMC-SERVER/
├── src/
│   ├── server.ts       # Express app + WebSocketServer + all /api routes
│   ├── kinematics.ts   # Inverse-kinematics helper for the atomic jog endpoint
│   ├── metrics.ts      # Backs GET /metrics - Prometheus text exposition (prom-client)
│   └── users.ts        # Account store (scrypt password hashing)
├── admin-ui/            # Separate Vite/React admin panel for THIS server itself
│   │                      (connected devices, own log file, own config, own users -
│   │                      deliberately not robot control, which stays STUDIO-only)
│   ├── src/
│   │   ├── App.tsx, main.tsx, index.css, api.ts, LoginScreen.tsx
│   │   └── tabs/AboutTab.tsx, ConfigTab.tsx, DevicesTab.tsx, LogsTab.tsx, UsersTab.tsx
│   ├── package.json / tsconfig.json / vite.config.ts
│   └── README.md
├── data/                # Runtime state - settings, users, logs, work files, saved points
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   ├── points/
│   └── WORKS/
├── docs/
│   ├── REMOTE_API.md              # Full contract: every route, the WS protocol, auth
│   ├── PRODUCTION_BOOTSTRAP.md    # Required production JWT and first-admin setup
│   └── REMOTE_ACCESS_VPN.md       # Real remote-access/VPN deployment guide
├── images/               # Media and diagrams
├── systemd/
│   └── hydra-umc-server.service # Local CM5 systemd unit
├── tools/
│   ├── ci_validate.py                                   # Manifest/CHANGELOG/docs validation used by CI
│   └── verify_*_contract.mjs, verify_auth_negative.mjs  # 11 real contract/negative-auth checks run
│                                                           against a live server (CAN-OTA relay, discovery,
│                                                           ecosystem service control/status, integrations
│                                                           test-connection, production bootstrap, robot
│                                                           command, playback, telemetry relay, voice relay)
├── monitoring/           # Optional Prometheus + Grafana stack - see monitoring/README.md
├── scripts/
│   └── bump-version.mjs # Legacy native-only helper; standard builds use bump_manifest_version.py
├── bump_manifest_version.py # Syncs hydra-umc.project.json's version to the native one (--sync)
├── build.bat / build.sh # Install deps + production build
├── dev.bat / dev.sh      # Install deps + start the dev server
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

`public/` (STUDIO's built static frontend, deployed alongside this server
at `/`) is gitignored - populated by copying STUDIO's own build output, not
part of a fresh clone.

## 🛠️ Development Environment

### Requirements
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- npm

### Installation

```bash
npm install
```

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
- `TLS_CERT_PATH` / `TLS_KEY_PATH` - set **both** to switch the server
  (REST API + the `/ws` WebSocket, which shares the same listener) from
  plain HTTP/WS to HTTPS/WSS. See "TLS / HTTPS" below. Leaving either
  unset keeps today's plain HTTP behavior unchanged.

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

### Versioning

Only the root `build*.bat` and `build*.sh` scripts create a release version
increment. They call `bump_manifest_version.py` exactly once, keeping
`package.json`, `hydra-umc.project.json` and [`CHANGELOG.md`](CHANGELOG.md)
in sync with the base-10 odometer rule (`0.0.9` -> `0.1.0`, never
`0.0.10`). `npm run build` is deliberately compile-only, so direct builds and
`build-test` validation never make a package-only version change. The running
version is readable live from `GET /api/hydra-info` (`appVersion`).

## 📊 Monitoring (Optional)

`GET /metrics` exposes process uptime, connected WebSocket clients,
`settings.json` write latency, atomic robot commands by type, authentication
failures, and the same CPU/memory/temperature figures as
`GET /api/system/metrics` - all in Prometheus format. A ready-to-run
Prometheus + Grafana stack (with a starter dashboard) lives in
**[`monitoring/`](monitoring/README.md)**: `docker compose up -d` from that
folder and it's running. Entirely optional - nothing here is needed for the
server itself to work.

## 🔗 Related Projects

This project is part of the HYDRA-UMC robotics ecosystem by the same author (JuanenRac / Electro Hobby 3D). Worth knowing about, since a request might actually be about one of these rather than this repository.

**Child Projects** — every one of these is a real client or coordination bridge that only ever talks to the robot fleet through this server's own API
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — web control dashboard with real-time multi-robot 3D visualization.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — desktop (PySide6) swarm command center for multiple servers at once, packaged as a standalone executable.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — native Android control app with biometric login and a paired Wear OS companion.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — iOS/iPadOS control app (Flutter) with real-time WebSocket sync.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — native touch UI for the onboard 7" DSI touchscreen, embedded on the CM5 itself.
- **[HYDRA-UMC-BRIDGE-AMR](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-AMR)** — coordination boundary for AGV/AMR fleets via a real VDA 5050 MQTT publisher.
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — high-level CNC-cell coordinator with real GRBL status/control-byte access.
- **[HYDRA-UMC-BRIDGE-DROIDS](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-DROIDS)** — coordination boundary for legged/humanoid droids, with a real Boston Dynamics Spot command sender.
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — laser-cell safety coordinator reading 3 real key/enclosure/interlock GPIO safeguards.
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — safe high-level board-flow coordinator for OpenPnP pick-and-place.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — safe coordination boundary for Moonraker/Klipper 3D printers, with real gated job commands.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — safety coordinator with a real, lazily-imported rclpy ROS 2 transport.
- **[HYDRA-UMC-BRIDGE-UAV](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-UAV)** — coordination boundary for camera-equipped UAVs, with a real MAVLink command sender.

**Directly Related**
- **[HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)** — this server relays bounded, authenticated voice turns to it over a loopback connection, retaining the gateway token server-side so voice never becomes a direct robot command.
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — the physical robot-arm motherboard this server's own `spi_bridge` service talks to over the real CM5↔STM32H745 SPI-OTA link.

**Also Part of the Ecosystem**

*Core Hardware & Platform*
- **[HYDRA-UMC-OS](https://github.com/JuanenRac/HYDRA-UMC-OS)** — reproducible Raspberry Pi OS product layer for the CM5 this server runs on: read-only agent, validated config/profiles, WiFi first-contact provisioning.
- **[HYDRA-UMC-SDK](https://github.com/JuanenRac/HYDRA-UMC-SDK)** — the shared JSON-Schema contract and safety-gate boundary every bridge above validates its commands against.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — desktop graphical URDF creator/editor that pushes finished models into this server's own catalog.

*URTC Tool Platform*
- **[URTC](https://github.com/JuanenRac/URTC)** — firmware for the physical Universal Robot Tool Controller PCB, 25+ tool profiles over CAN bus.
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** — desktop GUI flashing tool for URTC boards, CAN-OTA plus full-chip SWD/JTAG.
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** — desktop live CAN-bus diagnostic tool for URTC boards, one panel per tool profile.
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — browser-based alternative to URTC-TESTER via the Web Serial API, no local install needed.

*Vision AI Node (Hailo-8)*
- **[HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)** — integration hub for the Hailo-8 vision pipeline, with a real per-stage hardware-readiness check.
- **[HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)** — real compiled-model registry with Hailo-architecture/checksum safe-load verification.
- **[HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)** — real GStreamer pipeline + MediaMTX config generator with a real HailoRT integration boundary.
- **[HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)** — real Position-Based Visual Servoing correction law, safety-gated on upstream zone state.
- **[HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)** — real zone-breach checking and E-STOP requesting, with calibration-freshness enforcement.

*Cognitive AI Node (Hailo-10)*
- **[HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)** — integration hub for the Hailo-10 cognitive pipeline (LLM/VLA/voice orchestration).
- **[HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)** — real action-token encoding/decoding and trajectory generation for a Vision-Language-Action model.
- **[HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)** — real rule-based task decomposition and semantic error recovery over MCU error codes.
- **[HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)** — real stdlib-only TF-IDF document search over this ecosystem's own Markdown docs.

*Orchestration & Swarm*
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — integration hub with a real gRPC/Protobuf health-report contract and mission state machine.
- **[HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)** — real priority-based job queue with deduplication, over a real HTTP API.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — real gRPC-based fleet health watchdog with retry/backoff and identity-mismatch detection.
- **[HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)** — real RRT-based 3D path planner with real obstacle/workspace collision validation.
- **[HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)** — real CRDT LWW-Element-Map state sync, property-tested for multi-cell convergence.

*Digital Twin & Simulation*
- **[HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)** — integration hub for the digital-twin engine, with a real version-compatibility sync contract.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — real hardware-in-the-loop safety interlock routing commands between simulation and real hardware.
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
- **[HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)** — WearOS companion app with real haptic alerts and a paired-phone voice relay.
- **[URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)** — firmware for a board-mounting rack with real tool-ID decoding and Smart Idle pre-heating logic.
- **[URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)** — firmware plus a real Python vision companion for a thermal/RGB inspection tool head.
- **[HYDRA-UMC-UPDATER](https://github.com/JuanenRac/HYDRA-UMC-UPDATER)** — administrative desktop tool that discovers, clones and updates every repo in this ecosystem.
- **[HYDRA-UMC-OS-REBUILDER](https://github.com/JuanenRac/HYDRA-UMC-OS-REBUILDER)** — Windows/Linux desktop tool that builds a ready-to-flash CM5 image pre-loaded with the ecosystem's most current versions, with Raspberry-Pi-Imager-style first-boot Wi-Fi/user/SSH configuration.

---

## 📚 Documentation & Community

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — tech stack and coding guidelines for a pull request.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — the standards of behavior expected in this community.
- **[SECURITY.md](SECURITY.md)** — how to report a vulnerability, and this project's own real security focus areas.
- **[SUPPORT.md](SUPPORT.md)** — where to ask questions and report bugs.
- **[LICENSE.md](LICENSE.md)** — this project's own license.

## 👤 AUTHOR
**JuanenRac** (Electro Hobby 3D)
📧 electrohobby3d@gmail.com
📺 [youtube.com/@electrohobby3d](https://youtube.com/@electrohobby3d)

## 📜 LICENSE

HYDRA-UMC SERVER is (c) 2026 JuanenRac (Electro Hobby 3D). This notice
must be included in any distributions of this project or derivative works.

The source code of this application is available under the **GNU General
Public License v3.0 (GPL-3.0)**. Full text at
https://www.gnu.org/licenses/gpl-3.0.html.

The documentation (this README and its own translations -
`README_spa.md`, `README_ita.md`, `README_fra.md`, `README_deu.md`,
`README_zho.md`, `README_jpn.md`) is
available under **Creative Commons Attribution-ShareAlike 4.0
International (CC BY-SA 4.0)**. Full text at
https://creativecommons.org/licenses/by-sa/4.0/.
