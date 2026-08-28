# Changelog

All notable work on **HYDRA-UMC SERVER** is summarized here, newest first.

## Versioning scheme

`package.json`'s `version` field bumps automatically on every real production
build (`npm run build` - see `scripts/bump-version.mjs`, wired as the first
step of the `build` script). It follows a simple base-10 "odometer" rule
rather than semantic-versioning judgment calls:

- `patch` +1 on every build
- when `patch` would exceed 9, it resets to 0 and `minor` +1 instead (e.g. `0.0.9` -> `0.1.0`, never `0.0.10`)
- the same carry cascades into `major` if `minor` would exceed 9

The running version is readable live from the API itself: `GET /api/hydra-info`
returns `appVersion`, read straight from this project's own `package.json` at
startup - the same field every client of this server (HYDRA-UMC STUDIO's
About dialog included) already checks.

This file itself is *not* auto-generated per build (most builds are routine
verification runs with nothing changelog-worthy); it's updated by hand when
a change is actually worth summarizing for a human.

---

## Documentation - Real HTTP API reference gaps closed

- **`docs/REMOTE_API.md`** - documented 8 real endpoints that existed in
  `src/server.ts` but were missing from this reference: the 4 admin-only
  `/api/admin/*` routes (clients, logs, server-config read/write, restart
  - new section 2e) and `GET /api/system/metrics`, `GET /metrics`
  (Prometheus), `GET /api/camera/:id/stream` (currently a placeholder
  stream, documented as such), and `POST /api/upload-work` (including its
  real path-traversal and reserved-filename hardening - new section 2f).
  Also fixed a stale file-path reference in section 5 (`server.ts (repo
  root)` -> the real `src/server.ts`). Documentation-only - no code
  changed, no version bump.

## [Unreleased]

### Fixed

- The CM5 systemd unit now runs under the dedicated non-login
  `hydra-umc-server` account supplied by HYDRA-UMC-OS provisioning, rather
  than the obsolete shared administrator identity.

- Added isolated, real-server negative authentication coverage: anonymous
  writes, invalid bearer tokens and operator access to administrative routes
  are rejected; the explicitly operator-authorized work-file route remains
  usable. `npm test` now runs this verification together with the SDK
  ServerDiscovery contract.
- Made both temporary server-contract verifiers retry their cleanup on Windows
  so an already-exited `tsx` handle cannot turn a successful test into EBUSY.

## [0.2.1]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.2.0]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.1.9]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.1.8]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.1.7]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.1.5]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.1.4] - Safety and reliability fixes

Real security/robustness gaps confirmed against the actual current code
(most of that audit's other claims for this project turned out to already
be fixed - CORS, JWT_SECRET default, path traversal, the WebSocket
listener leak, and the kinematics NaN singularity were all already
handled; the public code and tests record the resulting behavior).

- **Real log rotation.** `industrialLog()` used to append to `server.log`
  forever with nothing that ever trimmed it - a real gap (audit #10):
  an industrial cell logs a line on every robot command, so an
  unattended CM5 would eventually fill its own eMMC. Single-file
  rotation at 10MB (current -> `server.log.1`, current truncated).
  Verified live: grew a real 10MB log file, started the server, confirmed
  it rotated to 347 bytes + a `server.log.1` with the old content.
- **Bounded `jog`/`speed` atomic command values.** Both only checked
  `typeof === "number"` before this fix - which NaN/Infinity/an absurd
  value like `1e9` all pass (audit #6). `jog`'s `amount` is now also
  required to be finite and `|amount| <= 1000` (10x headroom over
  STUDIO's own largest `JOG_STEP_OPTIONS` entry); `speed`/`acceleration`
  are bounded to STUDIO's own slider range (10-500).
- **scrypt cost raised to the OWASP Password Storage Cheat Sheet
  baseline** (N=2^17/r=8/p=1, up from Node's un-configured default of
  N=2^14) - login is infrequent (never on a jog/telemetry hot path), so
  the extra ~350ms/~128MB per attempt is a reasonable one-time-per-session
  cost (audit #7). Existing accounts hashed under the old cost still log
  in via an automatic fallback check - no forced password reset.
- **Graceful shutdown on SIGTERM/SIGINT.** Nothing handled either signal
  before this fix - a normal `systemctl stop`/Ctrl-C just killed the
  process mid-flight, leaving the mDNS record to expire only via its own
  TTL instead of unpublishing immediately (audit #8). Verified in-process
  (emitting SIGINT directly at the same process this session's build
  produced, since real cross-process signal delivery isn't reliably
  testable through Windows' signal emulation - the standard
  `process.on("SIGTERM"/"SIGINT", ...)` idiom used here works exactly as
  written on the real Linux/systemd CM5 target).

## [0.1.1] - Admin UI now matches STUDIO's "HYDRA-UMC Studio Fasion" theme

- `admin-ui/src/index.css` now redefines the same Tailwind color tokens
  and embossed button/input CSS rules HYDRA-UMC STUDIO's own
  `src/index.css` uses for its selectable "HYDRA-UMC Studio Fasion" theme
  (brushed-metal industrial panel look) - applied here unconditionally as
  the admin panel's one fixed look, verified end to end (real build, real
  server start, real `curl` of the served CSS confirming the new color
  values reached the browser).
- Found and worked around a Tailwind v4 CSS parser quirk while writing
  this: a header comment containing a mix of backticks, `@`-prefixed
  words, and bracket+quote combinations made the build fail with a
  `Missing opening (` error on an otherwise valid file - `admin-ui/README.md`
  now documents this so it doesn't get rediscovered the hard way.

## [0.0.9] - Fixed: jogging an XY table could crash every other client

- **Root cause of a real, reproducible crash** ("moved robot A1's XY
  table from the Android app while STUDIO was open in a browser - STUDIO
  went blank and the app crashed"). The `"jog"` command's `target ===
  "xytable"` branch broadcast a patch of just `{ xyTable: { pos } }` -
  every client's own delta-merge (STUDIO's `applyRobotDelta`, Android's
  `RobotViewModel.onDelta`, iOS/DSI's equivalents) applies a patch as a
  SHALLOW top-level-key replace, so that incomplete patch silently wiped
  every OTHER connected client's `xyTable.tableSize`/`worldPos`/
  `renderScale`/`worldRot` down to just `{ pos }`. STUDIO's own
  `VirtualKinematics.tsx` then dereferenced `xyTable.tableSize.width`
  with no null-guard - an uncaught exception during render, which is
  exactly what a React "blank white page" is. Now sends the complete
  `xyTable` object, matching how every other jog target (`pos`,
  `joints`) already worked.
- STUDIO's own `VirtualKinematics.tsx` and `RobotDetail.tsx` also
  hardened defensively (optional-chained `tableSize`/`pos` access with
  the same fallback pattern already used elsewhere in those files) -
  belt-and-suspenders against any future incomplete patch, not just this
  one.

## [0.0.8] - New admin UI: devices, logs, server config, users

- **New `admin-ui/`** - a small, separate Vite/React panel for
  administering THIS SERVER itself (not robot control, which stays
  STUDIO-only) - connected devices, its own log file, its own port/name,
  and its own user accounts. Served at `/admin` (alongside STUDIO's own
  optional mount at `/`, see [0.0.6] below) once built via
  `build-frontend.sh`/`.bat`, which now builds both.
- **New API routes backing it** (all `authenticate` + `requireAdmin`):
  - `GET /api/admin/clients` - every currently-open WebSocket connection,
    with metadata (username/role/remote address/connected-since)
    attached at connect time.
  - `GET /api/admin/logs?lines=N` - tail of the real on-disk log file
    (`LOG_FILE`, `industrialLog()`'s own target) - previously reachable
    by NOTHING (the static-file guard explicitly 404s any `/logs`
    request), now readable only through this authenticated route.
  - `GET`/`PUT /api/admin/server-config` - the listen port, previously a
    hardcoded `3000` with no override of any kind. `resolvePort()` now
    reads (in priority order) `process.env.PORT` > this saved config >
    the same `3000` default. A change here only takes effect on the next
    process restart - this server doesn't attempt to rebind its own
    listening socket at runtime.
  - `POST /api/admin/restart` - graceful self-restart for a change to
    actually apply, meaningful only behind a process supervisor
    configured to auto-restart on exit (systemd/pm2/Docker - the CM5
    deployment this targets).
  - User management (`GET`/`POST`/`PUT`/`DELETE /api/users`) already
    existed - this is the first real UI for it.
- Fixed a latent drift bug found while making the port configurable: the
  mDNS advertisement (`setupDiscovery()`) always announced a hardcoded
  `port: 3000` regardless of what the server actually listened on - never
  visible before since `PORT` itself was always exactly `3000` too; now
  both read the same resolved value.

## [0.0.6] - Optional static serving of HYDRA-UMC STUDIO's own frontend

- **New: this server can now optionally serve STUDIO's built frontend.**
  `src/server.ts` mounts `express.static(public/)` (after `data/`'s own
  static mount, so real saved data always wins any name collision) -
  populated by the new `build-frontend.sh`/`.bat` scripts, which build
  HYDRA-UMC STUDIO from a sibling checkout and copy its `dist/` output in
  (excluding STUDIO's own standalone-dev demo `WORKS/`/`settings.json`,
  which have no place next to this server's own authoritative copies).
  `public/` is gitignored and entirely optional - a deployment that never
  runs the new script stays exactly as headless as before.
- **Fixes the mobile/embedded 3D viewer showing "Cannot GET /".**
  HYDRA-UMC-ANDROID-CONTROL (and the iOS/DSI equivalents) embed STUDIO's
  3D viewport in an in-app WebView by loading this server's own
  `ip:port/?hideUI=true&robotId=<id>&token=<jwt>` - a URL that already
  matched STUDIO's own documented production deployment assumption
  (`src/lib/apiBase.ts` in STUDIO defaults to "same host, port 3000" in
  prod) but had nothing actually serving it at this server's `/` until
  now.

## [0.0.3] - Security hardening for internet-facing deployments

This server was previously assumed to run on a fully trusted LAN only.
The owner confirmed exposing it to the open internet via a router's
NAT/port-forward for remote testing - a real change to the threat model
(from "trusted LAN" to "reachable by anyone") - prompting this pass.
Every change below defaults to today's existing behavior; nothing here
breaks an existing trusted-LAN deployment that sets no new environment
variables.

- **`POST /api/login` rate limiting** - added `express-rate-limit`,
  scoped to that one route only. Defaults to 5 attempts per 15 minutes
  per IP (`LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS`), tripped
  requests get a clear `429` JSON error instead of a generic failure.
- **CORS allowlist** - replaced the previously wide-open `cors()` (no
  arguments, reflects any `Origin`) with a configurable allowlist
  (`CORS_ALLOWED_ORIGINS`, comma-separated). Unset, it still reflects any
  origin outside `NODE_ENV=production` (today's zero-config dev
  behavior); in production, unset now means every cross-origin browser
  request is denied by default (with a loud startup warning) rather than
  silently staying open. Non-browser clients (curl, HYDRA-UMC SUITE, the
  mobile apps) are unaffected either way.
- **Startup security warnings** - in `NODE_ENV=production`, the server
  now prints loud, impossible-to-miss warnings at boot if `JWT_SECRET` is
  still the built-in development fallback, or if the seeded `admin`
  account still verifies against its original default password.
  Detection only, not enforcement - the server still starts either way.
- **Configurable JWT expiry** - added `JWT_EXPIRES_IN` (any string
  `jsonwebtoken`'s own `expiresIn` accepts). Defaults to the existing
  `30d` if unset; a deployment reachable beyond a trusted LAN should set
  something much shorter (`24h` recommended in the README).
- **Optional TLS/HTTPS** - set both `TLS_CERT_PATH` and `TLS_KEY_PATH` to
  switch the shared REST + WebSocket listener from `http.createServer()`
  to `https.createServer()`; `/ws` automatically becomes WSS along with
  it. Unset (the default), behavior is completely unchanged - plain
  HTTP/WS. A cert/key path that's set but unreadable/invalid fails
  startup loudly instead of silently falling back to plain HTTP.

A later audit pass, still within this same version (done via `npm run dev`,
so it never triggered the automatic build-bump above), found and fixed
further real issues:

- **Atomic `settings.json` writes** - now written tmp-file-then-rename
  instead of an in-place write, so a power loss or disk error mid-write
  can no longer leave `settings.json` truncated or corrupted.
- **Privilege escalation fix** - an `operator`-role token could overwrite
  `users.json` via `POST /api/upload-work` by sending an empty
  `folderPath`, and a sibling path-traversal issue existed in
  `/api/models/submit`. Both closed.
- **WebSocket heartbeat** - added ping/pong keepalive so half-open
  connections (client gone without a clean close) get cleaned up instead
  of lingering indefinitely.
- **`TOKEN_EXPIRED` vs `TOKEN_INVALID`** - 401/403 responses now
  distinguish an expired token from an actually-invalid one, backward
  compatible with clients that only checked the old generic code.

## [0.0.0] - Split from HYDRA-UMC STUDIO

- Created as a standalone project: the Express/WebSocket API engine that
  used to live inside HYDRA-UMC-STUDIO's own `server.ts` (a "monolithic
  hybrid" that also served the Vite/React frontend from the same process)
  now runs here, headless, independent of any UI.
- Moved from HYDRA-UMC-STUDIO unchanged in behavior: `server.ts` ->
  `src/server.ts`, `kinematics.ts` -> `src/kinematics.ts`, `users.ts` ->
  `src/users.ts`, `data/` (real production `settings.json`/`users.json`/
  `logs/`/`WORKS/`) -> `data/`, `docs/REMOTE_API.md` -> `docs/REMOTE_API.md`.
- Removed all Vite dev-middleware/static-frontend-serving code from
  `server.ts` - this server no longer serves any HTML/JS, it is 100%
  API + WebSocket.
- Added real CORS (`cors` package, `app.use(cors())`) so a frontend running
  on a different origin (HYDRA-UMC STUDIO in dev on `localhost:5173`, or
  hosted anywhere else in production) can reach this API.
- Adopted the same automatic build-versioning convention already used by
  every other project in the ecosystem (`scripts/bump-version.mjs`, the
  odometer rule described above).
