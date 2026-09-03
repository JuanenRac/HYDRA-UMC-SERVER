# Changelog

All notable work on **HYDRA-UMC SERVER** is summarized here, newest first.

## Versioning scheme

`package.json`'s `version` field bumps via `bump_manifest_version.py`
(bare invocation - this repo is a "single owner" of its own version, no
separate `--sync` step), run as the first step of `build.bat`/`build.sh`
before `npm run build` itself. `scripts/bump-version.mjs` is a legacy
native-only helper kept for historical local workflows - see its own
header comment for why it is deliberately NOT wired into `npm run build`
(that would let a second, package-only bump drift the manifest/CHANGELOG
out of sync with `package.json`). Either way, the same base-10 "odometer"
rule rather than semantic-versioning judgment calls:

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

## Unreleased

(nothing yet)

## [0.4.6]

- **A disconnected camera now really stops its real process, instead of
  silently burning CPU/memory forever.** Real user feedback: toggling a
  camera off in Vision Center left its `stream serve` process alive -
  `connected` was deliberately never part of `cameraFingerprint()` (it
  isn't a connection-config field), but nothing else ever checked it
  either, so `reconcileCameraProcesses()` kept a camera's process
  running purely because its config stayed valid, whether or not the
  camera was actually switched on. Now checked explicitly, before the
  fingerprint short-circuit: `connected !== true` stops the real
  process (idempotent) and records the real, honest `"stopped"` status
  - not an error, a deliberate off state; `connected === true` starts
  or restarts it exactly as before. `GET /api/cameras/status` can now
  report `"stopped"` alongside the existing `starting`/`running`/`error`.

## [0.4.5]

- **Real multi-stream RTSP discovery - the actual fix for "an IP camera
  can have more than one real stream, not just Main/Sub".** `discoverRtspPath()`
  used to stop scanning the moment ANY candidate path answered `200 OK`,
  so a camera exposing 2+ real streams at once only ever surfaced the
  first one it happened to try. It now tries every real candidate in
  `RTSP_PATH_CANDIDATES` (same 400ms-spaced, rate-limit-cautious scan as
  before) and returns EVERY one that answered - `RtspDescribeResult.paths`
  (a real array, `paths[0]` still the honest "main" default) replaces
  the old single `path` field. STUDIO/SUITE's own Config UI persists the
  full list client-side and builds a real Main/Sub/Sub N stream picker
  from however many streams a given camera's own last discovery actually
  found - never a fixed pair.

## [0.4.4]

- **The 0.4.3 fixed-10s retry window still wasn't always enough** -
  caught immediately re-testing 0.4.3 live against the same real CM5
  hardware: some of this ecosystem's own real cameras genuinely took a
  little past 10s to answer (this session's own memory already
  documented these cameras as prone to slow/rate-limited responses
  under load - see `project_ip_cameras_investigation`), and a bounded
  window still has no way to notice a camera that WAS running and then
  genuinely drops. Replaced the bounded retry with a real persistent
  health check: ticks every 2s for the lifetime of the process (not a
  fixed count), flips to `running` the instant it answers, and only
  settles on `error` after 10 CONSECUTIVE misses (~20s) - and keeps
  ticking after that too, so a camera that eventually does come up
  self-corrects back to `running` without needing another settings
  write to re-trigger reconciliation. `status: "starting"` (the real
  initial value) is left alone rather than forced to a premature
  `error` during a normal, if slow, cold start.

## [0.4.3]

- **Fixed a real false-negative "error" status on every camera, caught
  live testing 0.4.2 against real hardware on the real CM5.** All 4
  cameras the user configured came up correctly (their real
  `stream serve` process alive, their real HTTP port actually
  answering `200`) but the status badge still showed a permanent
  "Stream Error" - a cold RTSP connect over a real network plus real
  ARM CPU startup overhead genuinely took longer than the one-shot
  1.5s readiness probe allowed for, and nothing ever re-checked
  afterward once that single check said "not yet". The probe is now a
  real retry loop - polls once a second for up to 10s, flips to
  `running` the moment it actually answers, and only settles on
  `error` once every attempt is exhausted (each poll's own timer is
  unref'd, so a pending retry never delays a graceful shutdown).

## [0.4.2]

- **Fixed `visionStreamerExecutablePath()` never actually finding
  HYDRA-UMC-VISION-STREAMER on a real CM5 deployment.** Caught live
  while the user tested the new camera supervisor (0.4.1) against real
  hardware on the real CM5: every camera showed a real, honest `error`
  status instead of `running` - not a bug in the supervisor logic
  itself, but in how it located the executable. The old code hardcoded
  the containing directory name as the literal
  `"HYDRA-UMC-VISION-STREAMER"` sibling-checkout convention this repo's
  own Windows dev layout happens to use; the real CM5's own deployed
  layout names every service directory without the `HYDRA-UMC-` prefix
  (`/opt/hydra-umc/vision-streamer`, matching every other service under
  `/opt/hydra-umc/`) - so the literal never matched there, and
  `fs.existsSync()` silently returned false for every real camera every
  time. Now resolved the same way `getEcosystemStatus()` already
  resolves every OTHER sibling in this codebase: scan `ecosystemRoot()`'s
  own subdirectories for whichever one's own `hydra-umc.project.json`
  has `"name": "HYDRA-UMC-VISION-STREAMER"`, falling back to the old
  literal only if no manifest match is found (keeps the Windows dev
  layout working unmodified). Also added a `[CAMERA]` log line for the
  "executable not found" path, previously completely silent in the
  journal even though it's exactly the case an operator most needs
  visibility into.

## [0.4.1]

- **Real per-camera process supervisor - the actual fix for "I configured
  an IP camera and nothing shows up".** STUDIO/SUITE's own camera config
  UI (`sourceType`/`ipHost`/`rtspPort`/`rtspPath`/`ipUsername`/
  `ipPassword`) was already field-complete and already persisting
  correctly - but `GET /api/camera/:id/stream` has only ever been a pure
  proxy to a local `hydra-umc-vision-streamer stream serve` instance on
  `127.0.0.1:8100+(id-1)`, and nothing anywhere ever launched one. Saving
  a camera's real config had zero effect on whether video actually
  appeared - confirmed live: a real camera already configured with
  `.203`'s own real RTSP path sat there doing nothing until this fix.
  New `reconcileCameraProcesses()` (hooked into the one shared point both
  `POST /api/settings` and the WS `"settings"` message already called -
  folded into a new `applySettingsUpdate()` both now call instead of
  duplicating the same 2-step sequence) diffs every camera's real
  connection-relevant fields against a fingerprint of what's currently
  running, and spawns/kills/respawns a real `stream serve` child process
  per camera as needed - also runs once at startup, so an already-
  configured camera comes up on its own without any user action.
  `computeDeviceArg()` translates real config into the exact `--device`
  argument `stream serve` expects (a real `rtsp://user:pass@host:port/path`
  for `sourceType: "ip"`; a real V4L2 path, a bare index, or this app's
  own `USB_DEV_N` seed-data symbol translated to its real index, for
  `"usb"`). New `GET /api/cameras/status` exposes each camera's real
  live status (`starting`/`running`/`error` + the real last error) so
  the config UI can show honest feedback instead of being a black box.
  Every process this server itself launches is killed on graceful
  shutdown (fixes a real stuck orphan found and killed by hand today).
  **Verified live, end to end, against real hardware on this dev
  machine**: camera 1 (this machine's own real integrated USB camera)
  and camera 2 (a real IP camera, `192.168.0.203:8554/profile0`) both
  auto-started at server boot with zero manual action and served real
  MJPEG/JPEG frames through the complete real proxy path (13MB+ of real
  video in a few seconds); the 6 other seeded-but-nonexistent camera
  slots correctly report a real, honest `error` status with the real
  OpenCV failure reason instead of silently doing nothing or crashing.
- **Real orphaned camera-process reaping on startup.** Windows doesn't
  take a spawned child down with its parent the way POSIX does - killing
  this server by anything other than a clean SIGINT/SIGTERM that
  actually reaches `gracefulShutdown()` (a debugger stopping the
  process, `taskkill /F`, a crash) leaves its `stream serve` children
  running forever, silently holding their camera device and TCP port.
  Caught live on this dev machine: an earlier server incarnation's own
  orphaned camera processes were still holding ports 8100/8101 - one
  more `reconcileCameraProcesses()` at the next boot then had 2 real
  processes fighting over the same webcam/RTSP stream. Fixed with a
  small pidfile (`data/camera-process-pids.json`, gitignored - real
  local runtime state, kept current by `writeCameraPidFile()` on every
  spawn/stop/exit) read once at the very next startup, before this
  incarnation reconciles (and so spawns) any camera process of its own -
  `reapOrphanedCameraProcesses()` does a real liveness probe
  (`process.kill(pid, 0)`, never a guess) and SIGTERMs anything still
  alive from a previous run. New `[CAMERA] starting`/`[CAMERA] stopping`
  log lines for real operational visibility into what this supervisor is
  doing, matching this file's own existing `[STARTUP]` logging
  convention. Separately confirmed while chasing this on this same dev
  machine, for the record: a *working* camera legitimately shows up as
  more than one OS process in Task Manager/`Get-Process` on Windows (the
  installed console-script launcher re-execs a real Python interpreter
  process under it) - that's normal, not a leak; `stopCameraProcess()`'s
  own `proc.kill()` against the one PID Node itself tracks was verified
  to cleanly take the whole real process tree down with it.
- **Real RTSP path auto-discovery** - new `POST /api/camera/discover-rtsp-path`
  (`{host, port, username, password}`). A native Node RTSP DESCRIBE
  client (RFC 2617 Digest, no `qop` - the same real handshake already
  hand-verified against this ecosystem's own cameras) tries a curated
  list of real, previously-confirmed paths one at a time with a real
  pause between attempts (this ecosystem's own cameras are known to
  rate-limit repeated authenticated attempts - see
  `[[project_ip_cameras_investigation]]`), starting with `/11`/`/12`
  (Hipcam) and `/profile0` (YGTek) - both real, already-verified paths
  from this ecosystem's own hardware - before falling back to other
  common real OEM paths. Never invents a path: an exhausted list reports
  honestly which ones were actually tried. **Verified live** against
  both real YGTek cameras (`.203`/`.204`) - correctly tried `/11`/`/12`
  first, found the real `/profile0` on the third attempt, matching
  exactly what manual investigation found earlier today.
- **Real USB camera discovery** - new `GET /api/camera/discover-usb-devices`,
  shelling out to `HYDRA-UMC-VISION-STREAMER`'s own new `discover-usb`
  CLI subcommand (`execFile`, same pattern already used in this file for
  `systemctl`/`vcgencmd`) rather than re-implementing device enumeration
  in Node, where there's no reliable cross-platform way to do it without
  a native dependency - reuses the exact same `cv2.VideoCapture` backend
  that actually captures frames, so a reported device is genuinely
  openable. **Verified live** against this dev machine's own real
  integrated camera (found at index 0, 1280x720).
- **Fixed a real orphaned-file leak in `writeFileAtomic()`.** Windows'
  `fs.rename`-over-an-existing-destination isn't guaranteed atomic like
  POSIX `rename(2)` and can fail with `EPERM`/`EBUSY` if the destination
  is transiently locked (an AV scanner, a backup/sync agent, a file
  watcher) - with no retry and no cleanup, a failed rename left its real
  temp file behind forever. Found 16 real orphaned
  `data/settings.json.<pid>.<timestamp>.tmp` files on this dev machine
  spanning 7 different server runs. Fixed with a few short retries on
  failure plus a real cleanup of the temp file if every retry still
  fails, and a new startup sweep (`sweepOrphanedTmpFiles()`) that removes
  whatever already accumulated before this fix existed - **removed 102
  real orphaned `.tmp` files** on this same dev machine's own first
  restart with the fix in place.
- **`GET /api/camera/:id/stream` crashed the entire server, not just that
  one request, whenever a real camera stream ran past 5 seconds** - real
  bug hit live watching a real camera for the first time (see
  HYDRA-UMC-VISION-STREAMER's own CHANGELOG for the cross-platform
  capture fix that made a real stream possible to watch at all). Root
  cause: the proxy's own `fetch()` to the local `mjpeg_server.py`
  instance reused a single `AbortSignal.timeout(5000)` across the whole
  request, but that signal fires once, 5000ms after creation, regardless
  of whether the MJPEG body is still healthily streaming - it does not
  reset per chunk. Once it fired mid-stream it aborted the piped
  `Readable`, which had no `error` listener, so Node's default "throw on
  unhandled 'error' event" behavior killed the whole process, taking
  every open robot/WebSocket connection down with it, not just the
  camera view. Fixed two ways: the abort timer now only bounds the
  initial connect (cleared as soon as `fetch()` resolves, before any
  body bytes are read) so a healthy stream is never killed by its own
  age, and both the piped `Readable` and the client `res` now have real
  `error` handlers so a genuinely dropped connection (closed tab,
  network blip, upstream restart) ends that one stream cleanly instead
  of ever taking the server down again.
- **`GET /api/system/metrics`'s `cpu_load`/`memory_usage` disagreed with
  the new Supervisor endpoint's own real numbers** - real feedback from
  live testing: the dashboard footer showed 9% CPU while the Supervisor
  panel showed 21% for the same instant. Root cause: `cpu_load` was
  `Math.round(os.loadavg()[0] * 10)`, a "simplified load" heuristic that
  isn't a percentage at all (`os.loadavg()[0]` is the 1-minute average
  number of processes wanting CPU time, not CPU busy%), and `memory_usage`
  used raw `os.freemem()`, which counts reclaimable page cache as "used"
  and so runs high. Both now reuse the exact same real sources the
  Supervisor endpoint computes from - `lastCpuUsage.overallPercent` (the
  delta-sampled `os.cpus()` busy% background sampler) and
  `readMemoryInfo()`'s `/proc/meminfo` `MemAvailable`-based used% - one
  real measurement now, read from two places, never two competing guesses.
- **Real CPU temperature was silently mocked in production** - found live
  while verifying the new Supervisor endpoint below against the real CM5:
  `temp_is_real` was `false` (a random mocked value) even though
  `vcgencmd measure_temp` worked fine when run directly over SSH as the
  same service user. Two real, separate gaps, both from this repo's own
  earlier systemd hardening pass:
  1. The `hydra-umc-server` service user was never added to the `video`
     group Raspberry Pi OS requires for `/dev/vcio` (the VideoCore
     mailbox device `vcgencmd` needs) - real one-time host fix:
     `sudo usermod -aG video hydra-umc-server`.
  2. `PrivateDevices=true` hides `/dev/vcio` entirely inside a fresh
     private `/dev`, with no working way to re-admit it - a same-looking
     `DeviceAllow=/dev/vcio rw` line was tried first and made things
     WORSE (any `DeviceAllow=` at all appears to tighten this systemd
     version's default device cgroup policy, and the path-based rule
     didn't resolve against a device outside `PrivateDevices`' own
     remapped `/dev` anyway) - `PrivateDevices=true` removed instead, a
     real, deliberate tradeoff since this unit has a genuine hardware
     access need. Isolated via a byte-for-byte `systemd-run`
     reproduction of the real unit's full directive set - see
     `systemd/hydra-umc-server.service`'s own comment for the full
     story. Same "verify live, not just syntax check" lesson as this
     repo's earlier `AF_NETLINK`/mDNS regression - `systemd-analyze
     verify` catches neither class of bug.
- **`GET /api/system/supervisor`** - a real, Netdata-style deep-dive host
  monitor, distinct from the lighter `GET /api/system/metrics` (Overview
  footer). Real per-core CPU usage/frequency (a 1s background sampler
  keeps a rolling delta always ready, avoiding a per-request blocking
  sample window), real `/proc/meminfo` breakdown (used/cached/buffers/
  swap, not just the 2 coarse numbers `os.freemem()/totalmem()` gives),
  real root-filesystem (flash/eMMC) usage via `df`, real top-20 processes
  by CPU% via `ps`, plus the existing CPU/RP1 temperature reads. Every
  field is honestly `null`/empty on a host that can't supply it (this
  repo's own Windows dev machine, a CM5 kernel without cpufreq exposed,
  `ps`/`df` missing) - deliberately never mocked, unlike
  `/api/system/metrics`'s own temp fallback (see that route's own
  comment for why the two differ). Powers HYDRA-UMC STUDIO's new
  Supervisor panel - see that repo's own `[Unreleased]`.
- **Three new atomic `/api/robot/:id/command` commands, plus `absolute`
  support for the existing `jog`** - `reset` (target-aware: resets
  pos+joints to a caller-supplied home pose for `target: "robot"`, or
  just `xyTable.pos`/`pos.tx`/`ty` for `target: "xytable"`), `jogStep`
  (validated 0-1000, sets `robot.jogStep`), and `reset3D` (bumps
  `robot.reset3DTrigger` - a pure broadcast signal, no real robot state,
  for every client's own local camera-view remount). `jog`'s existing
  `target: "robot"`/`"xytable"` branches now accept `absolute: true` to
  SET an axis to `amount` instead of adding it (for a position slider
  dragging to an exact target, as opposed to a joystick/D-pad's relative
  nudge), reusing that case's existing axis/target validation rather than
  a bespoke command. All four exist because HYDRA-UMC-STUDIO's own Reset/
  HOME/HOME XY buttons, XY table sliders, and jog-step selector wrote
  through `updateRobot()` - the optimistic-local + 500ms-debounced-
  full-tree settings save, which this endpoint's own broadcast (every
  other command already uses) never touches - so a reset/step/table-drag
  on one connected client silently never appeared on another, in either
  direction. Real feedback from live multi-client testing. See
  HYDRA-UMC-STUDIO's and HYDRA-UMC-ANDROID-CONTROL's own `[Unreleased]`/
  `[0.5.0]` for the client-side half of this fix.
- **CM5 systemd resource and kernel-surface baseline** - the Server unit now
  drops all Linux capabilities, private device access and unneeded namespace,
  realtime and SUID/SGID operations; it restricts address families to local
  Unix, IPv4/IPv6 and netlink networking, locks the personality and protects
  clock, cgroups, kernel logs, modules and tunables. A 384 MiB soft / 512 MiB
  hard memory budget protects the 4 GiB CM5 from a single Server process
  exhausting the node. The service still uses its explicit writable data
  directory and the narrowly-scoped polkit path for approved system actions.
  `AF_NETLINK` is included alongside `AF_UNIX`/`AF_INET`/`AF_INET6` - a first
  deploy against the real CM5 without it crash-looped on startup, since
  Node's own `os.networkInterfaces()` (used by the mDNS advertiser to
  enumerate real network interfaces) needs a netlink socket on Linux; caught
  and fixed against the live service, not just `systemd-analyze verify`
  (which only checks syntax, not runtime behavior under the restriction).
- **RP1 temperature in `GET /api/system/metrics` and `GET /metrics`** - the
  CM5/Pi 5 family's own I/O controller chip (USB, Ethernet, GPIO) exposes a
  real temperature reading via the standard Linux hwmon framework
  (`rp1_adc`), independent of `vcgencmd`'s SoC-only reading. Found by hand
  while investigating other real sensors exposed on the live CM5
  (`hwmon1`), previously unused. `rp1_temp` is `null` (not a mocked value)
  on any host without a real RP1 chip - a real hardware fact, not something
  this host merely can't currently read. New Prometheus gauge
  `hydra_system_rp1_temp_celsius`.

## [0.4.0]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.3.9]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.3.8]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.3.7] - Real per-project start/stop/restart, admin-only, real polkit-gated

- **`POST /api/ecosystem/service/:unit/:action`** (`start`/`stop`/
  `restart`, `admin` only) - real feedback from live testing: the
  Ecosystem > Services panel needed real per-project controls, not just
  status. `:unit` is never trusted from the request - it must match a
  `systemdUnit` a **fresh** `getEcosystemStatus()` scan actually returns
  right now (never a string that merely matches the naming pattern),
  and this server's own unit is refused unconditionally (self-restart
  already has its own route, `POST /api/admin/restart`). Even a
  validated request only actually works with a real, narrowly-scoped
  polkit rule on the host - added
  `HYDRA-UMC-OS/provisioning/polkit/50-hydra-umc-server-service-control.rules`
  (installed by that repo's own `install_server.sh`), granting the
  unprivileged `hydra-umc-server` account start/stop/restart for
  exactly the `hydra-umc-*.service` namespace (verified: `unit ===
  "hydra-umc-server.service"` and anything outside that namespace stay
  refused even with the rule installed) - without it, `systemctl`
  itself refuses the call and this answers a clean `503`. New contract
  test (`verify_ecosystem_service_control_contract.mjs`) covers the
  unauthenticated refusal, an invalid action name, the own-unit
  refusal, an unknown-unit refusal, and a known unit resolving to a
  real success-or-honest-failure outcome (this dev machine has no
  `systemctl` at all, so `503` here is itself the correct, tested
  result - a real CM5 with the polkit rule installed returns `200`).
  Documented in `docs/REMOTE_API.md` section 2i alongside the
  previously-undocumented `GET /api/ecosystem/status`.

## [0.3.6] - Real PID and systemd state per project, independent of whether it exposes a port

- **Most running CM5 services never declared a `service.port` at all and
  looked indistinguishable from a project that isn't a service** - real
  feedback from live testing, after `[0.3.5]` fixed the panel showing
  zero services: of 19 real running units, only 6 declare a TCP/HTTP
  port (`live` stayed `null` - "not applicable" - for the other 13, same
  as a genuine library/CLI). Added an optional `service.systemd_unit`
  manifest field; when present, a new `probeSystemd()` runs
  `systemctl show <unit> --property=MainPID,ActiveState,SubState` (a
  read-only query the unprivileged `hydra-umc-server` user can already
  run for any unit, verified live, no polkit rule needed) alongside the
  existing port probe. `EcosystemProjectStatus` gained `serviceHost`
  (the fixed local probe address, `127.0.0.1`, whenever a port is
  declared), `systemdUnit`, `pid`, `activeState` and `subState` - a
  project can have either, both, or neither of servicePort/systemdUnit,
  probed independently and concurrently. New contract test case (a
  fixture with only `service.systemd_unit`, naming a unit that exists on
  neither this test machine nor CI) proves the field round-trips and
  `pid: null`/real key presence hold even when `systemctl` itself isn't
  reachable, rather than crashing the whole scan.
- Declared `service.systemd_unit` in the 19 real CM5-deployed repos' own
  manifests (`hydra-umc-<name>.service`, the real running unit name in
  each case) - a plain, additive metadata change in each of those repos,
  no version bump needed there since it changes nothing about their own
  behavior.

## [0.3.5] - Ecosystem status panel now finds its real manifests on the CM5

- **`GET /api/ecosystem/status` always reported zero services on a real CM5
  deployment** - real feedback from live testing (STUDIO's Ecosystem >
  Services panel showed nothing at all, not just services marked down).
  The scan's own `../` (this repo's parent directory) is correct for a
  local dev checkout, where every HYDRA-UMC-*/URTC-* repo sits flat next
  to this one - but a real CM5 deployment's `WorkingDirectory`
  (`/opt/hydra-umc/server`) has only each service's own build artifacts
  under its parent (`/opt/hydra-umc/`), never a full checkout with a
  `hydra-umc.project.json` manifest, so every `existsSync()` check
  silently skipped every directory and the scan always returned an empty
  list. Added `HYDRA_UMC_ECOSYSTEM_ROOT` (see `.env.example`) to point
  the scan at wherever a deployment's real manifests actually live;
  unset (every existing dev setup) keeps today's exact `../` behavior.
  New contract test case proves a server whose own cwd has no manifests
  anywhere nearby still finds every real fixture once the override
  points it at them. On the real CM5, `HYDRA_UMC_ECOSYSTEM_ROOT` pointed
  at the staging checkouts under `/home` turned out to still fail -
  `ProtectHome=true` in this service's own systemd unit blocks `/home`
  entirely regardless of file permissions - so the actual live fix was
  copying each running service's own `hydra-umc.project.json` into its
  `/opt/hydra-umc/<service>/` directory instead, letting the unchanged
  default `../` scan find them. `HYDRA_UMC_ECOSYSTEM_ROOT` itself stays
  as a real, tested escape hatch for a deployment without that same
  sandboxing constraint.
- **Atomic Work loading** - added `command: "trajectory"` to the authenticated
  robot-command endpoint. Studio now persists and synchronizes a selected
  Work before Play can reach the server, fixing the race that replayed the
  preceding trajectory. The command validates bounded finite points, accepts
  model-native `motionType: "model-joints"`, resets playback state and never
  overwrites a combined sibling's own Work. Covered by the real temporary
  Server contract fixture.
- **Atomic example selection** - `trajectory` now optionally persists a safe
  `selectedExample` id along with the model-native points. Examples and Works
  therefore share one durable load/reset/broadcast contract instead of relying
  on a delayed full-settings write.

- **Independent XY-table playback** - a trajectory point's `tx`/`ty` now
  moves `xyTable.pos` and mirrors that state in `robot.pos`, while the arm
  continues to resolve only its own `x`/`y`/`z` pose. The Server rejects a
  table trajectory for a robot without a configured table. The playback
  contract now proves both arm and table move together without conflating
  their coordinate systems.

## [0.3.4]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.3.3]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.3.2]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.3.1]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.3.0]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.2.9]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.2.8] - Real Tier 2 relay param (URTC Tool Head, through STACK A)

- **`GET /api/hardware/canota/version`, `POST /api/hardware/canota/flash`**
  now forward a new `relay` query parameter to `spi_bridge`, unchanged
  otherwise - `relay=1` tunnels the request through the resolved Tier 0/1
  target to reach Tier 2 (the URTC Tool Head), via `spi_bridge`'s new real
  `relay_tunnel.py` (RELAY_SEND/RELAY_RECV, architecture.md section 5).
  Verified: `tools/verify_canota_relay_contract.mjs` gained a real
  assertion that `relay=1` is genuinely forwarded to the (stub) upstream,
  not just accepted and dropped.

## [0.2.7] - Real CM5<->STM32H745 SPI-OTA relay (pre-real: connected, not simulated)

- **`GET /api/hardware/canota/version`, `POST /api/hardware/canota/flash`**
  (new) - a real relay to `HYDRA-UMC`'s own new `src/cm5_host/spi_bridge/`
  local service, the real SPI1 + `HYDRA_DATA_READY` GPIO link to the
  STM32H745 "Kinematic Brain". Gated by a new `HYDRA_UMC_SPI_BRIDGE_URL`
  env var (same shape as `HYDRA_UMC_VOICE_UI_URL`/`HYDRA_UMC_DATALAKE_URL`) -
  unconfigured returns a clean `503 { available: false }`. The version
  query is `authenticate` only; `flash` is **`admin` only**, unlike every
  other relay in this file - writing firmware is exactly the kind of
  action every other bridge in this ecosystem gates more tightly than a
  read.
- Real per-page flash progress is broadcast live to every connected
  WebSocket client as a new `{ "type": "canota_progress", "payload":
  {...} }` message while the flash cycle runs, rather than only returned
  once in the final HTTP response - `POST /api/hardware/canota/flash`
  reads spi_bridge's own real newline-delimited-JSON progress stream and
  re-broadcasts each line as it arrives.
- Corrected `docs/REMOTE_API.md`'s WebSocket section, which incorrectly
  claimed only one message `type` (`"settings"`) exists - `"delta"` (from
  `POST /api/robot/:id/command`) was already real and undocumented there;
  both are now listed alongside the new `"canota_progress"`.
- Verified: `tsc --noEmit`, `npm test` (new
  `tools/verify_canota_relay_contract.mjs` - a real Server + a real stub
  spi_bridge over real HTTP + a real connected WebSocket client, proving
  the unconfigured-503 case, the auth/admin gates, real tier/slot param
  forwarding, real firmware bytes forwarded byte-for-byte, and real
  streamed progress arriving over WS).

## [0.2.6] - Real read-only telemetry proxy for STUDIO's Ecosystem panel

- **`GET /api/telemetry/query`, `GET /api/telemetry/aggregate`** (new,
  `authenticate` only) - a thin, authenticated proxy to
  HYDRA-UMC-DATALAKE's own `/query`/`/aggregate` HTTP API, gated by a new
  `HYDRA_UMC_DATALAKE_URL` env var (same shape as `HYDRA_UMC_VOICE_UI_URL`).
  Unconfigured returns a clean `503 { available: false }` instead of an
  error - Server stays the one client STUDIO talks to, never a second
  place that has to know Datalake's own host/port.
- Fixed the same stale "Versioning scheme" documentation bug found twice
  earlier this session (MTCONNECT-ADAPTER, STUDIO): this section falsely
  claimed `scripts/bump-version.mjs` is wired into `npm run build`,
  contradicted by both `package.json`'s real `build` script and the
  script's own header comment.
- Verified: `tsc --noEmit`, `npm test` (new `tools/verify_telemetry_relay_contract.mjs`
  - real Server + a real stub Datalake over real HTTP, proving the proxy
  forwards real query params, surfaces a real upstream failure, and stays
  a clean 503 when unconfigured) and `tools/ci_validate.py`.

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

### Added

- **V0 server-authoritative playback engine.** `play`/`pause`/`stop` used
  to only ever set a `playbackState` flag - the actual recorded-trajectory
  motion was entirely driven by whichever HYDRA-UMC STUDIO browser tab
  happened to have that robot's panel open, polling that same flag
  locally (`RobotDetail.tsx`'s own `playRobotTrajectory`). If no such tab
  was open - a common real case when only Android/iOS/DSI/SUITE are
  controlling a robot - pause/play/stop updated state but physically
  moved nothing. The server now linearly replays a robot's own
  `recordedPoints` itself (each point's own already-recorded `j1..j6`/
  `pos`, not a re-derived inverse-kinematics guess, and not yet the full
  velocity/acceleration interpolation curve STUDIO's own client-side
  player still renders with - see this session's own investigation notes
  for the deliberately-scoped V0 boundary), broadcasting a real delta on
  every step so play/pause/stop work from any client without depending on
  a STUDIO tab being open anywhere. New
  `tools/verify_server_playback_contract.mjs` proves this against the
  real API in an isolated temp data directory: a robot with no recorded
  points doesn't get stuck "playing", play physically advances pos/joints
  through real recorded values, pause halts advancement and resume
  continues it, reaching the end sets `isFinished`, and stop halts it for
  good.

### Fixed

- Made the real Voice UI relay contract test use the `python` command
  guaranteed by this workflow's successful Python validation step, while
  retaining `PYTHON` as an explicit override. The test now also reports a
  process-start failure cleanly instead of crashing Node on an unhandled
  child-process error.

- Resolved the Voice UI interpreter in the GitHub Actions Bash step and pass
  its executable path explicitly to the Node relay-contract test. This avoids
  runner-specific Python PATH differences without weakening the real
  cross-service check.

- Check out the real HYDRA-UMC-VOICE-UI source in Server CI and pass its
  location through `HYDRA_UMC_VOICE_UI_ROOT`. The relay contract now fails
  clearly if that source is unavailable instead of reporting a misleading
  child-process `ENOENT`.

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

## [0.2.6]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.2.5] - Independent remote-access gate for HYDRA-UMC-WATCH

- **`remoteAccessAllowed()`** now recognizes a 4th client type, `"watch"`,
  alongside the existing `suite`/`android`/`ios` (Config > Remote Access
  in the browser UI, `src/store.tsx`'s own `SystemSettings.remoteAccess`).
  Watch has no direct connection of its own - the paired phone's
  `HydraApiClient` sends `X-Hydra-Client: watch` only for the 2 real
  Watch-relay calls (`POST /api/voice/turn`, `GET /api/watch/system-status`),
  never for that same phone's own ordinary Android traffic - so Watch
  access can be revoked independently, without also locking that phone
  out of its own session.
- Both routes now 404 for a gated-out request, matching the existing
  `GET /api/hydra-info` gate's own semantics.
- New real end-to-end test in `tools/verify_voice_relay_contract.mjs`:
  disables `remoteAccess.watch` via a real `POST /api/settings`, proves
  both routes 404 for `X-Hydra-Client: watch`, and proves the same admin
  session's own direct access is unaffected.

Verified: full `build-test.bat` suite passes (8 contract scripts
including the new watch-gate assertions).

## [0.2.4] - Real Integrations "Test Connection" + fail-closed production bootstrap

### Added

- **`POST /api/integrations/test-connection`** - the real backend for
  STUDIO's Config > Integrations panel (OpenPnP/CNC/Laser/ROS2/
  Printer3D bridges), whose cards used to only save an ip/port to
  `settings.json` with zero verification either way. A real bare-TCP
  reachability probe (reuses `probeTcp()`, the same primitive
  `GET /api/ecosystem/status` already uses) against the client-supplied
  `host`/`port` - deliberately generic rather than bridge-specific, so
  one route works uniformly across every bridge without this server
  needing to know any of their individual real HTTP APIs. Requires a
  real session (`authenticate`) - unlike the ecosystem scan, this takes
  client-supplied host/port, so an anonymous version would let anyone
  use this server as a blind network-reachability oracle. `host` is
  checked against a conservative hostname/IPv4 character allowlist
  before it ever reaches a real socket connect. New
  `tools/verify_integrations_test_connection_contract.mjs`: a real
  listening fixture reports `reachable:true`, a closed port reports
  `reachable:false`, malformed host/port is rejected with 400, and an
  anonymous request is rejected with 401.
- **Fail-closed production bootstrap** - a production start
  (`NODE_ENV=production`) now refuses to boot with an empty
  `JWT_SECRET` (previously only a loud warning; the server started
  anyway on the source-published development signing key). The first
  administrator account now requires explicit
  `HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME`/`_PASSWORD` on a real first start
  rather than a fixed, well-known `admin`/`admin` seed. `startServer()`
  is now awaited with a real `.catch()` at the top level, so a rejected
  bootstrap actually terminates the process instead of risking an
  unhandled rejection keeping a misconfigured instance alive. New
  `docs/PRODUCTION_BOOTSTRAP.md` and
  `tools/verify_production_bootstrap_contract.mjs`; `.env.example` and
  all 7 README language files updated to document the two new required
  variables.

### Verified

- `npm run typecheck` clean; full `npm test` - 8/8 contract scripts
  passing, including both new ones above.

## [0.2.3] - Real per-service liveness probing on GET /api/ecosystem/status

### Added

- **A real live probe per declared sibling service.** A repo whose
  `hydra-umc.project.json` opts in with a new, optional `service` object
  (`{port, health_path?}` - see HYDRA-UMC-UPDATER's schema) now gets a
  genuine TCP connect (or an HTTP GET expecting 2xx, when `health_path`
  is declared) run concurrently against every declared sibling on this
  same host. Each project in the response now carries `servicePort`,
  `serviceHealthPath`, and `live` (`true`/`false` for a real probe
  result, `null` for a project that never declares a service - a
  library/CLI/firmware/UI, "not applicable", never shown as down for
  something it was never meant to do). This is the real "Integración
  real entre proyectos" gap this endpoint previously only described in
  its own header comment as future work: a maturity label is a claim, a
  live probe is a fact.
- This server's own manifest now declares `service: {port: 3000,
  health_path: "/api/system/metrics"}`, so it shows up correctly in its
  own scan the same way every other opted-in sibling does.
- New real contract test (`tools/verify_ecosystem_status_contract.mjs`,
  wired into `npm test`): builds an isolated fake workspace with a real
  listening fixture service, a reserved-then-closed port, and a
  service-less library fixture, starts a real Server instance against
  it, and asserts the live HTTP response reports `true`/`false`/`null`
  correctly for each. Full suite: 6/6 contract scripts passing.

## [0.2.2]

### Added

- Real, honest V0 ecosystem-status endpoint: `GET /api/ecosystem/status`.
  NOT a live health check of every ecosystem project as a running network
  service (almost none of the wider ecosystem is actually deployed
  anywhere yet) - scans this process's own parent directory (matching how
  a real HYDRA-UMC-SERVER instance is actually launched today, from
  inside its own checkout sibling to every other repo on the same
  dev/staging machine) for each sibling's own `hydra-umc.project.json`
  self-description, mirroring the same dynamic-manifest-discovery pattern
  the dashboard/updater tools already use rather than duplicating a static
  catalog a third time. Gives up cleanly (`available: false`, never an
  error) when siblings aren't there to find - a real CM5 deployment won't
  have 49 other repos checked out next to it, and this must never affect
  startup or a real request over that. Same trust tier as the existing
  `/api/system/metrics` (read-only host introspection, no auth). Built
  for HYDRA-UMC-ANDROID-CONTROL's own new ecosystem-status tab, but
  usable by any client.

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
