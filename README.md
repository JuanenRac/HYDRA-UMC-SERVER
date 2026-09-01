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
│   └── users.ts        # Account store (scrypt password hashing)
├── data/                # Runtime state - settings, users, logs, work files
│   ├── settings.json
│   ├── users.json
│   ├── logs/
│   └── WORKS/
├── docs/
│   ├── REMOTE_API.md              # Full contract: every route, the WS protocol, auth
│   └── PRODUCTION_BOOTSTRAP.md    # Required production JWT and first-admin setup
├── tools/
│   └── verify_production_bootstrap_contract.mjs # Fails closed production checks
├── monitoring/           # Optional Prometheus + Grafana stack - see monitoring/README.md
├── scripts/
│   └── bump-version.mjs # Legacy native-only helper; standard builds use bump_manifest_version.py
├── build.bat / build.sh # Install deps + production build
├── dev.bat / dev.sh      # Install deps + start the dev server
├── package.json
├── tsconfig.json
├── CHANGELOG.md
└── LICENSE
```

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

This project is part of a larger robotics ecosystem by the same author (JuanenRac / Electro Hobby 3D), made up of many projects spanning firmware, control software, AI nodes, and fleet tooling. Worth knowing about, since a request might actually be about one of these rather than this repository.

### Directly Related to This Server

- **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** — exposes this server's state over OPC-UA/MQTT.
- **[HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)** — ingests the logs this server produces.
- **[HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)** — ingests the logs this server produces.
- **[HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)** — coordinates multiple instances of this server.
- **[HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)** — coordinates multiple instances of this server and manages their failover.
- **[HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)** — bridges this server and the digital twin.
- **[HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)** — performs fleet DevOps against this server's API.
- **[HYDRA-UMC-BRIDGE-ROS2](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-ROS2)** — exposes only authenticated, high-level coordination between this server and ROS 2.
- **[HYDRA-UMC-BRIDGE-OPENPNP](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-OPENPNP)** — coordinates traceable PCB hand-offs through this server's authorised path.
- **[HYDRA-UMC-BRIDGE-PRINTER3D](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-PRINTER3D)** — coordinates printer auxiliaries through this server; native firmware remains authoritative.
- **[HYDRA-UMC-BRIDGE-CNC](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-CNC)** — requests bounded CNC-cell auxiliaries; it never replaces controller safety.
- **[HYDRA-UMC-BRIDGE-LASER](https://github.com/JuanenRac/HYDRA-UMC-BRIDGE-LASER)** — requests laser-cell auxiliaries without a route to arm or fire a laser.

### Rest of the Ecosystem

**HYDRA-UMC platform** — the multi-robot micro-factory cell
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** — the motherboard itself: Raspberry Pi CM5 host + dual-core STM32H745 real-time co-processor, orchestrating up to 8 distributed robot arms over CAN-OTA/SPI-OTA. Own hardware + firmware, GPL-3.0/CERN-OHL-S v2/CC BY-SA 4.0.
- **[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** — web-based control dashboard for HYDRA-UMC: multi-robot 3D visualization, kinematics/trajectory recording, CAN-OTA flashing and testing for the whole platform. React + Vite + Three.js - now a pure frontend client talking to this same server over the network, exactly like every other client below.
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** — Android control app for HYDRA-UMC over Wi-Fi/Bluetooth. Real, working app - full remote-control feature set, JWT auth, encrypted credential storage.
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** — iOS/iPadOS control app for HYDRA-UMC over Wi-Fi, built in Flutter (cross-platform, verifiable on Windows without a Mac; final `.ipa` packaging still needs Xcode). Real, working app - same feature set as the Android app.
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** — desktop (Python/PySide6) swarm command center: multi-controller network discovery, live bidirectional sync, real 3D robot viewport, Photoshop-style dockable workspace. Real and working, not a placeholder.
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** — desktop (Python/PySide6) graphical URDF creator/editor for this project's own model catalog: pulls source files from GitHub or a local folder, validates DOF feasibility, edits color/scale/kinematics with a live 3D preview, and pushes the finished result straight into this server's catalog. Real and working, not a placeholder.
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** — native Flutter touch UI for HYDRA-UMC's own 5"/7" DSI touchscreen (1280×720, same resolution at both sizes) on the Compute Module 5, controlling this same server directly from the board. Real, working scaffold with all 6 catalog screens connected to the live server; real Linux target build not yet run on real hardware.

**URTC platform** — the tool head controller every HYDRA-UMC robot arm carries
- **[URTC](https://github.com/JuanenRac/URTC)** — Universal Robot Tool Controller: STM32F303-based CAN bus tool head controller, 25 fully-implemented tool profiles, CAN-OTA firmware update.
- **[URTC Flasher](https://github.com/JuanenRac/URTC-FLASHER)** — desktop CAN-OTA + full-chip SWD/JTAG flashing tool for URTC boards (Windows/Linux).
- **[URTC Tester](https://github.com/JuanenRac/URTC-TESTER)** — desktop live CAN-bus diagnostic tool for URTC boards, one panel per tool profile (Windows/Linux).
- **[URTC Web Studio](https://github.com/JuanenRac/URTC-WEB-STUDIO)** — browser-based alternative to the 2 desktop tools above (Web Serial API + SLCAN), no local install needed.

**👁️ Vision AI Node (Hailo-8)**
- [HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)
- [HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)
- [HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)
- [HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)
- [HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)

**🧠 Cognitive AI Node (Hailo-10)**
- [HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)
- [HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)
- [HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)
- [HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)
- [HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)

**🐝 Orchestration & Swarm**
- [HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)
- [HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)
- [HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)

**🎮 Digital Twin & Simulation**
- [HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)
- [HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)
- [HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)

**📊 Data & Analytics**
- [HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)
- [HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)

**🏭 Industrial Gateway**
- [HYDRA-UMC-OPCUA-SERVER](https://github.com/JuanenRac/HYDRA-UMC-OPCUA-SERVER)
- [HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)
- [HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)

**🛠️ Complementary Tools**
- [URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)
- [URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)
- [HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)
- [HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)

---

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
