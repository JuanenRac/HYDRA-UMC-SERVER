# Changelog

## [Unreleased]

- **The routes of the status feed of the dev server have the names of the SDK (`/api/ingest/dev-server/status`, `/api/dev-server/status`):** they answer exactly like the `developer-node` routes, which stay as deprecated aliases for one version, and a test compares both. `docs/openapi.json` lists the four routes.

- **The SDK is pinned to its newest release, and the answers of the update routes use its shapes:** the pin of the workflow moves to `v0.6.4`, the byte copy of the shapes of the SDK (`tools/sdk/server.shapes.json`) is refreshed, and the self-update and fleet-update routes name `SelfUpdateStatus`, `SelfUpdateJob` and `FleetUpdateStatus` as their answers, so `docs/openapi.json` shows them.
- **An update from Studio is no longer reported as done when the server that answers still runs the old version, and an update tool that never started is told as such:** a signed package whose deploy tool ends well but whose unit does not start from the release in use now ends as failed (`deploy_failed`, with the version in place and the one that runs) instead of done, and a run of the fleet update whose tool left no trace within twenty seconds (the interpreter or the tool is not where the settings say) is read as interrupted with the last line the process printed, instead of staying as planned for ever; the update can then be asked again. Tests of both cases.

- **The ports of the local AI services can be read from the registry of the SDK (`HYDRA_UMC_AI_PORTS_FROM_REGISTRY=1`, off by default), and a check finds a port that moved:** the relay `/api/ai/<service>/...` sent visual servoing to the voice service once because the port of one had moved and the built-in table had not. The table stays the default; with the variable on, a service that the table knows and the registry (`contracts/ports.yaml` of the SDK next to this server) names with a valid port takes the registry's port (read again after a minute), and the registry can never add a service. A test lists the services whose built-in port differs from the registry when the SDK is at hand, so the next move is found by the CI instead of by a user. `LOCAL_AI_SERVICE_PORTS` is now exported from `localAiRoutes.ts`. Tests of the names, the default, the correction, what the registry cannot do and the drift.

- **The server can show the last health frame of a controller board as the brain heard it (`GET /api/ecosystem/node-health?slot=N`, off by default):** the brain keeps the last health frame of each of the eight slots and the SPI bridge of the CM5 offers it (`GET /node-health`); the server reads it and passes it on in a fixed shape (`online`, `heard`, `ageMs`, `sequence`, `flags` and `flagNames`, the counters and the uptime, `source: brain-health`) for an operator or an administrator. Read only: nothing is sent to the board, nothing is invented (`heard: false` when no frame was heard, `online: false` when the brain does not answer) and a damaged answer of the bridge is not passed on. The route answers `404` until `nodeHealth.enabled` is on (Server Admin, `PUT /api/admin/server-config`, or `HYDRA_UMC_NODE_HEALTH=1`, which wins and locks the switch), `400` for a slot that is not 0 to 7 and `503` when the bridge is not configured or silent. In `docs/openapi.json` and `docs/REMOTE_API.md`. Tests of the shape, the fetch, the route behind its switch and the switch.

- **The Security tab of the web page of the server has the two switches of the executor of the assigned jobs:** "Run the jobs the job dispatcher assigns to the robots of this server" (off) and "Really move the robots" (off: a dry run), each with its source, a lock when the environment sets it, the warnings after saving and a confirmation with its own words before the robots may move by themselves; only the switches that are not locked are sent, and a server that predates the executor shows nothing. The sentences are in the eight languages. Tests against the real security configuration: the reading, the request the tab builds and the server accepts, the confirmation, the lock and the sentences.

- **The executor of the assigned jobs has its two switches in Server Admin:** `jobDispatcher.executor.enabled` (off) and `jobDispatcher.executor.live` (off: a dry run that only audits what it would start) can be read and set with `PUT /api/admin/server-config`, with the source of each (default, file or environment), the lock when `HYDRA_UMC_JOB_EXECUTOR` or `HYDRA_UMC_JOB_EXECUTOR_LIVE` sets them, the note that they apply on the next start, the warnings `job_executor_on` and `job_executor_live`, an audit record and a log line that says whether it is off, a dry run or live. The other keys of the section are kept. Tests of the defaults, the lock, the write, the restart note and the refusals.

- **The server can run the jobs the dispatcher assigns to its robots (`jobDispatcher.executor`, off by default and a dry run when on):** the dispatcher decides who does a job and keeps no content for it, and nothing turned "robot 3 has job J" into motion. `src/dispatcherExecutor.ts` reads the assigned jobs (`GET /jobs?status=assigned`), starts the server playback of the recorded trajectory of the robot of the robot map (the same "play" as the command of a person) and, when the playback ends by itself, reports `POST /jobs/complete` with the job, the robot and the attempt. It starts nothing while the server is read-only or stopped, or when the robot is disabled, reserved by a person, without a trajectory, already playing or busy with another job of the executor; it never reports a job done when a person stopped the playback, when the job left the assigned list (a robot still moving for it is stopped) or when the run exceeds `maxRunSeconds`; it never starts the same attempt twice; every step is in the audit log. The switch is `jobDispatcher.executor.enabled` or `HYDRA_UMC_JOB_EXECUTOR=1`, and it only audits what it would start until `jobDispatcher.executor.dryRun` is `false` or `HYDRA_UMC_JOB_EXECUTOR_LIVE=1`; `jobDispatcher.executor.tools` limits the tools. Tests with a simulated dispatcher, robots and clock. A switch in Server Admin is not there yet.

- **A light container bench on the pull requests that touch what it covers (`.github/workflows/container-bench.yml`):** the workflow calls the reusable bench of HYDRA-UMC-DEV-SERVER (pinned by commit hash), which builds the image of `scripts/Dockerfile` from the head of the pull request, starts it as a real container and runs 7 scenarios (the version route without a token, the refusals without a token, with a wrong token and with a wrong password, the sign-in of the first administrator, the settings and a command to a robot that does not exist). It runs only when the pull request touches the start of the server, the sign-in and the routes, the settings store, the policy, the security configuration, the image or its dependencies; never on a push to main; a second push to the same pull request cancels the run in progress. A test checks the pin, the list of paths, that there is no push trigger and the cancel rule.
- **A Dockerfile of the server (`scripts/Dockerfile`, built from the root with `docker build -f scripts/Dockerfile .`), for the container bench:** two stages (the build with all the dependencies and the bundle of esbuild; the run with the production dependencies and the bundle only), the user `node` and never root, `/app/data` as the only folder it writes, a health check on `GET /api/hydra-info` (it answers without a token) and `CMD node dist/server.cjs`. No secret is in the image: the signing key (`JWT_SECRET`) and the first administrator (`HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME`, `HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD`) are given when the container starts, and `.dockerignore` keeps the local data folder, the logs, the dependencies and the keys out of the build. It is for the bench of HYDRA-UMC-DEV-SERVER (and for anybody who wants the server in a container); the installation on the CM5 stays on systemd and nothing in it changes. A test checks the user, the health check, the absence of secrets and the ignore list.
- **The tool of a robot command is checked against the common list of the URTC family, and an unknown one is only said in the log:** `POST /api/robot/:id/command` with `tool` has always taken any text. The server now knows the 25 tools of `contracts/urtc_tools.json` of the SDK (its constant name with or without `TOOL_`, its title, which is what STUDIO sends, `None`, or its identifier from 0 to 25) and writes a line `[tool] robot N: ... is not a tool of the URTC family (the command is applied as sent)` when the value is none of them. Nothing is refused or changed: the answer, the robot and the broadcast are as before, and the line cuts a long value. A test compares the table with the file of the SDK when a checkout is at hand.
- **The server can register the robots of its roster in the job dispatcher (`jobDispatcher.registrar.enabled` or `HYDRA_UMC_JOB_ROBOT_REGISTRAR=1`, off by default):** the dispatcher assigns jobs only to robots it knows and nothing told it about the robots of the roster. A loop reads `GET /robots` of the dispatcher and registers with `POST /robots` (`id`, `available: true`) the robots of the roster that have an entry in the robot map of the stop relay (or, with `registerUnmapped`, all of them with their id as text), and never touches a robot the dispatcher already knows, so a robot at work is not overwritten. A robot id used by more than one robot is never registered. The pause, the time limit and the back-off are parameters of the file; every registration is in the audit chain. The reader accepts the field names of the dispatcher both as its structure writes them (`ID`) and as its camelCase alias (`id`). Documented in `docs/JOB_STOP_RELAY.md` and `docs/REMOTE_API.md`; tests with a simulated dispatcher and simulated timers.
- **`npm test` runs every contract check and reports all of them (`tools/run_checks.mjs`, the list in `tools/checks.json`):** the checks were joined with `&&` in one line of `package.json`, so the first one that failed hid every check after it and the output did not say which were left out; and one line named two scripts in a single `node` call, so `verify_discovery_contract.mjs` was never run (and `verify_robot_command_race_contract.mjs` was not in the line at all). The runner runs each script on its own, with a time limit, prints one `PASS` or `FAIL` line for each and a verdict, and exits 1 if any failed. A test (`tests/checkList.test.mjs`) fails when a `tools/verify_*.mjs` script is neither in the list nor excused with a reason, when a name is twice in the list or does not exist, when a failing check hides the next ones, and when `package.json` chains the scripts again.
- **The contract checks wait up to 60 seconds for the server to start, and the wait can be changed (`HYDRA_UMC_TEST_START_TIMEOUT_MS`):** six of them waited 15 seconds for a freshly spawned server to answer, which a loaded runner does not always give after dozens of contracts in one step; `SERVER_ECOSYSTEM_HEALTH_CONTRACT` failed with "timed out waiting for: server to accept connections" on a commit that changed nothing near it. Checks only; the server is untouched.
- **The update of everything installed is tested across a restart of the server:** a new object over the same progress file and heartbeat (the server restarted by its own installer) tells the run is going on, refuses a second one, shows the final file when the tool ends well, reports a run whose heartbeat stopped as interrupted and starts again only the program asked.

- **Every installed program can be updated from Studio, one after the other, with the progress of each (off by default):** `GET /api/admin/fleet-update`, `POST /api/admin/fleet-update/plan`, `/apply` and `/resume` (administrator; the look is `updateCheck.enabled`, applying is `maintenance.enabled`, `confirm: true`, audited, one run at a time) start `tools/fleet_update.py` of HYDRA-UMC-OS detached and read the progress file it writes: each program with its step (disk, fetching, backup, building, installing, verifying), its state (waiting, running, done, failed, rolled back, interrupted, skipped or blocked), the free disk against what the program needs, and whether the unit files are as they were after a rollback. A run whose heartbeat stopped is reported as interrupted and the program that was cut can be taken up again; the server may restart in the middle (its own update is the last one) and answer about the same run when it is back. The names are checked against the plan before they reach a command. `tests/fleetUpdate.test.ts` runs it on a double of the tool; not run on a CM5 yet.

- **The programs of the machine can be updated from Studio, step by step (off by default):** `GET /api/admin/self-update` sets the server, Studio and the agent of the operating system against the newest signed release of each (the look is `updateCheck.enabled`), and `POST /api/admin/self-update/apply` and `/rollback` (administrator, `confirm: true`, `maintenance.enabled`, audited, one at a time) fetch the package, its hash and its signature from the release of its repository, have them checked by the family's own check of the signature, and hand them to the deploy tool, which keeps the release in use as `previous`, restarts only that program and puts the earlier release back when it does not hold. The job tells `checking`, `downloading`, `verifying`, `applying`, `restarting`, `done` or `failed` with a reason, lives in a file so it can be read again after the server restarts in the middle of its own update, and ends as `timeout` when the tool reports nothing. `tests/selfUpdate.test.ts` runs the whole way on doubles (GitHub, download, check, tool): the way to done, a signature that does not hold, a cut download, a restart in the middle, a deploy that goes back by itself, the way back by hand and every refusal. Not proved on the CM5 yet: a real package, the real unit restarting.

- **The shared tools and the CI jobs have time limits:** the project tool, the validators and the build test pass a timeout to every child process (`HYDRA_UMC_GIT_TIMEOUT_S`, 120 s by default, and `HYDRA_UMC_COMMAND_TIMEOUT_S`, 3600 s by default; a value that is not a positive number means the default), and the baseline and notify jobs of the workflows carry `timeout-minutes`, so a stuck step ends with a message instead of holding a runner.
- **Tests of the static mounts:** the sensitive files of `data/` stay hidden under every spelling of the address (encoded characters, doubled slashes, dots, other letter case), the folders that are never public answer not found, a damaged percent-encoding is refused and the built front ends are served only when their folders exist. The coverage step of the CI now keeps a floor (94 % lines, 92 % branches, 93 % functions, the measured values).
- **The CI measures the coverage of the unit tests:** a step of the workflow runs the unit tests with the coverage of Node.js and prints the table of each file and a summary (report only, no floor yet); the floor will be fixed with the measured number.
- **The server can issue the one-use confirmation of a person for a flight or walking request (`POST /api/operator/confirmations`, off by default):** with `HYDRA_UMC_HUMAN_CONFIRMATION=1` an operator or an administrator gets, after confirming on a screen (`confirm: true`), a short HS256 token for one action and one job (`ARM`, `TAKEOFF`, `GOTO_WAYPOINT`, `HOVER_AND_CAPTURE`, `WALK_TO`, `PICK_OBJECT`, `PLACE_OBJECT`) that the UAV and droid bridges check and accept once. It has its own key file (`HYDRA_UMC_HUMAN_CONFIRMATION_KEY_FILE`), a lifetime of 60 s by default and 120 s at most, answers 404 while off and 503 without a key, and every issue and refusal is audited without the token. 9 tests.
- **The flight policy of the machine bridges has switches in Server Admin:** `bridges.uav.envelopeRequired`, `confirmationRequired` (both on by default), `chainInFlight` and `uploadGeofence` (off), and `bridges.droids.confirmationRequired` and `returnHomeAlways` (on). Turning off a requirement or turning on chaining or the geofence upload asks for a confirmation and answers the warning `bridge_<bridge>_<option>`. The bridges apply them in the tightening direction only, under the same host switch and the same signature as the other bridge switches.
- **Read-only mode can be switched in Server Admin (`robots.readOnly`, off by default):** besides `HYDRA_UMC_READ_ONLY`, an administrator can switch the mode with `PUT /api/admin/server-config` (`{ "robots": { "readOnly": true } }`); the answer warns with `server_read_only_on`, the change is logged and applies at once, and the variable, when set, wins and locks the option (409). The WebSocket settings write follows the same switch. Tests in `tests/securityConfig.test.ts`.
- **A read-only mode of the server (`HYDRA_UMC_READ_ONLY`, off by default):** with `1` the server shows its robots and data and changes nothing, for every account and app: a request that writes is answered with `423` and the code `server-read-only` before it reaches a route (and the settings write of the WebSocket the same), while reading, the sign-in and sign-out, STOP, the global stop and the safe-mode disable go on. Read on every request. `src/readOnlyMode.ts`, `.env.example`, `docs/REMOTE_API.md`, `tests/readOnlyMode.test.ts`.

## [0.8.3.0] - The F-RAM erase and self-test of the kinematic brain, one stop state for the apps and the stop watch interval as an option

- **README: the platform statement:** the description says what this project serves today (the CM5 pilot bench) and that the target platform of HYDRA-UMC, an NVIDIA Jetson Orin NX 16 GB, is a design that has not been built or tested.
- **The F-RAM erase is a switch of the Security tab of the web administration, and the kinematic table is the document of the SDK:** the tab lists `safety.framErase` with its label, its warning and its question in the eight languages, and `switchPatch` sends `confirm: true` next to the risky value once the question has been answered (the server refuses to turn the erase on without it); the tests count fifteen switches. `src/data/kinematicData.json` is now byte for byte `contracts/kinematics.json` of the SDK (a test compares both wherever the SDK checkout is next to this repository or in `HYDRA_UMC_SDK_DIR`), and the continuous integration is pinned to the SDK tag that carries the F-RAM routes and that document.

- **The F-RAM of the kinematic brain can be erased and tested through this server, off by default:** `POST /api/hardware/fram/erase` (it needs `{ "confirm": "ERASE" }`) and `POST /api/hardware/fram/selftest` relay to the SPI bridge; administrators only, and while `safety.framErase` of Server Admin (or `HYDRA_UMC_FRAM_ERASE=1`, which wins and locks it) is off both answer `403` and nothing leaves. The bridge (`--enable-fram-erase`) and the firmware (`HYDRA_FRAM_ERASE`) keep their own switches. `GET /api/hardware/canota/version` carries `capabilities.fram_erase`, true only when the bridge and this server both offer the operation, so an app offers the button only then. Every attempt and its outcome goes to the audit record. Tested against a stand-in for the bridge; the chip driver of the firmware has not run on a board.

- **The interval of the emergency stop watch is an option of Server Admin:** `safety.estopWatchMs` (0, the default, is off; otherwise 500 to 60000 milliseconds) sets the watch that until now only `HYDRA_UMC_ESTOP_WATCH_MS` could turn on; the environment still wins and locks it, and a change applies on restart.

- **One stop state for the apps, joining the physical emergency stop with the global stop:** `src/stopState.ts` reads the stop as the kinematic brain holds it (the frame on identifier `0x001` of the stack bus) from the SPI bridge of the CM5 (`GET /estop`) every `HYDRA_UMC_ESTOP_WATCH_MS` milliseconds (500 to 60000; off at `0`, the default), joins it with the global stop of the server and pushes a `stop-state` message on `/ws` (clients with `remoteApiVersion=2`) at every change and right after the first `settings` message. `STOPPED` when either stop is on, `READY` only when the physical stop is known to be released and the global stop is not on, `UNKNOWN` otherwise; a bridge that is silent, fails or answers something unusable is never read as a released stop, and releasing the global stop does not release a latched physical one. Read only: nothing here can cause or release a stop. Unit tests with a fake bridge; not run against a real brain.

## [0.8.2.9] - More tests for the live connection hub, the Bluetooth calls and the administration routes: the WebSocket hub is checked for what each kind of client hears (the credentials of the cameras only for an administrator, the small patch only for a client that declare

All notable changes to this project are documented here.

- **More tests for the live connection hub, the Bluetooth calls and the administration routes:** the WebSocket hub is checked for what each kind of client hears (the credentials of the cameras only for an administrator, the small patch only for a client that declared schema 2, a fault in the telemetry or phone callbacks never reaching the write), and its endpoint for a missing, malformed, foreign, expired or revoked token, the first push, the admin-only settings message, a demotion that takes effect on the next message, a duplicated robot id and the heartbeat that drops dead and revoked sockets; the `bluetoothctl` wrapper is run against a stand-in program (pairing order, a vanished device, each step failing, the address as one argument); and the account and administration routes get both middlewares, the last-administrator guard, the log tail limits, the port bounds, the refused options written to the audit record and the restart that answers before it exits. Line coverage of `ws.ts` goes from 47 % to 100 %, `bluetooth.ts` from 52 % to 100 % and `adminRoutes.ts` from 76 % to 93 %; the whole unit run now measures 97.3 % of lines.
- **The flash relay passes the manifest fields on to the flashing service:** `POST /api/hardware/canota/flash` takes `target` (the board the image is for) and `min_bootloader` (`major.minor.patch`) from the caller that holds the update manifest, checks their shape (`400` `invalid-flash-signature` otherwise) and hands them on, so the flashing service refuses a target that is not the board and a bootloader that is older, or whose version cannot be read, before it sends a byte. Without them nothing is checked.
- **The voice status of one robot now says when the server last had news of it:** asked for the status of a registered robot, the spoken answer adds that its last news (a command carried out, a change of its state or a heartbeat) arrived some seconds ago, that it has been silent for longer than the stale limit, or that it has sent nothing since the server started, in the eight languages. It is what this server has heard, never a claim about the machine, and a robot the server does not have gets no such sentence.
- **A relay for the live state of the twin (`WebSocket /api/twin/ws`, off until an administrator turns on `twinRelay.enabled` in Server Admin or sets `HYDRA_UMC_TWIN_RELAY=1`, and `HYDRA_UMC_TWIN_WS_URL` names the twin):** the twin pushes over a WebSocket that asks for an `Authorization` header and refuses an `Origin`, which a browser cannot send. A panel now opens `/api/twin/ws` with the `hydra.bearer` subprotocol (a token in the address is not accepted), the server checks the session as for `/ws`, opens the twin's socket with the person's own token and passes on what the twin pushes; nothing a panel sends reaches the twin. At most 8 panels, a session whose account changes closes within 30 seconds, a panel that falls 4 MiB behind is dropped. `/ws` and the relay share one listener, now told apart by path in `verifyClient`.

## [0.8.2.8] - Tests for the playback engine, the part of the server with the least coverage: one point per tick, the wrist values a point does not carry, cartesian and compact points, the table axes that only a robot with a table moves, the speed that sets the interval (nev

- **Tests for the playback engine, the part of the server with the least coverage:** one point per tick, the wrist values a point does not carry, cartesian and compact points, the table axes that only a robot with a table moves, the speed that sets the interval (never below 50 ms), pause, stop request, repeat, the natural end that tells the phones once, an id used by two robots that names none, and the helpers of the reservation (active until it expires, a history of the last twenty entries).

- **The Live Activity of a robot on the lock screen, at a level an administrator chooses (off by default, `push.liveActivity`):** `POST /api/push/live-activities` and `DELETE /api/push/live-activities/{token}` register the token of the activity a phone started; the card is updated through the Apple push service (key only in the environment) with the state of the robot only (the default), the state and the progress, or everything of the panel, and the level is applied on the server so a phone cannot ask for more; turning the card on or raising the level needs a confirmation, lowering it never does; a card ends when the job finishes.
- **A reset of the arm state of one URTC tool changer (off by default, `atc.resetEnabled`):** `POST /api/tool-arms/reset` (administrator) takes the robot, the tool and the robot id typed again, checks with the arm state of the tools and the motion of the robot that the robot is stopped and every tool of it is reported disarmed and fresh (`409` with the reason otherwise: an old report, an unknown motion or an unreadable state is a refusal, never a guess), forwards the reset with the administrator's own token to the tool changer service (`HYDRA_UMC_ATC_URL`) and writes every attempt to the audit record. It moves nothing mechanical; while the switch is off the route answers `404` and nothing is forwarded.
- **The panels can read the arm state of the URTC tools through the server:** `GET /api/tool-arms` (any signed-in account) carries the answer of `GET /tool-arms` of the safety zones service (`HYDRA_UMC_SAFETY_ZONES_URL`, off by default: 503 until it is set) with the caller's own token and passes it on unchanged, a stale report included. The contract is `ToolArmsReport` in the SDK. Read only: it arms, disarms and stops nothing.

- **Maintenance routes for the installed releases (off by default, `maintenance.enabled`):** `GET /api/admin/maintenance/status` and `POST /api/admin/maintenance/install`, `/rollback` and `/prune` (administrator) wrap the deploy tool of the operating system image without a shell. A package is named, never given as a path, and must be a regular file inside one folder; a component is a short plain name; every change needs `confirm: true`, runs one at a time and is written to the audit record whatever its result. The environment variable `HYDRA_UMC_MAINTENANCE` locks the switch.
- **The reports of loaded models of DETECTION-HEF can be switched from Server Admin (off by default, `detectionHef.acceptLoadedReports`):** the saved value is also written to the settings file that service re-reads while it runs, whole and readable by its owner and group only, so no restart is needed; a file that cannot be written is told in the answer.

## [0.8.2.7] - Signed tokens of one device: an administrator can issue a token for a device (the screen of a Compute Module) with POST /api/admin/device-tokens, list the tokens with GET /api/admin/device-tokens and revoke one with DELETE... (and 2 more changes)

- **Signed tokens of one device:** an administrator can issue a token for a device (the screen of a Compute Module) with `POST /api/admin/device-tokens`, list the tokens with `GET /api/admin/device-tokens` and revoke one with `DELETE /api/admin/device-tokens/{id}`; the device signs in with `POST /api/device/login` and gets a short sign-in (15 minutes by default) that it renews until the token expires or is revoked. A token belongs to one operator or viewer account, never an administrator's, expires, is shown once and is not kept. Off by default (`deviceTokens.enabled`, `HYDRA_UMC_DEVICE_TOKENS`), the routes then answer 404, and turning it on needs a confirmation.
- **The newest published version of each program:** `GET /api/admin/updates` sets the installed version of every program of the ecosystem against its newest GitHub release, keeps the answer six hours by default and stops at the first refusal for quota. Off by default (`updateCheck.enabled`, `HYDRA_UMC_UPDATE_CHECK`); it reports and never installs.
- **The addresses of the server in the discovery answer:** `GET /api/hydra-info` can list the local-network addresses of the server in `addresses`. Off by default (`discovery.advertiseAddress`, `HYDRA_UMC_ADVERTISE_ADDRESS`).

## [0.8.2.6] - The contract check also compares the route table the SDK generates for its clients: when the SDK checkout carries generated/hydra-routes.json, tools/verifysdkcontract.mjs fails if the server registers a route the table does... (and 1 more changes)

- **The contract check also compares the route table the SDK generates for its clients:** when the SDK checkout carries `generated/hydra-routes.json`, `tools/verify_sdk_contract.mjs` fails if the server registers a route the table does not list, if the table lists a route the server does not register, or if the kind of access or the query parameters of a route differ. A checkout without the table leaves nothing to compare.

- **Dependencies updated:** the npm dependencies of the server and of the administration interface move to their latest compatible releases (express 5.3, express-rate-limit 8.7, ws 8.22, React 19.3, lucide-react, Vite React plugin and the type definitions); TypeScript stays on its current line.

## [0.8.2.5] - The relay reaches the trajectory check of the semantic planner: POST /api/ai/semantic-planner/plan/trajectory-check is forwarded like the dry run of a plan (same sign-in, role and body limits; the exact request only, anything... (and 2 more changes)

- **The relay reaches the trajectory check of the semantic planner:** `POST /api/ai/semantic-planner/plan/trajectory-check` is forwarded like the dry run of a plan (same sign-in, role and body limits; the exact request only, anything near it is still `403`), so STUDIO and SUITE can check a plan as a trajectory. The planner keeps it off until its own switch is on, and then the relay answers `404`. No new route of this server.

- **The server tells a scenario outcome of a live service check from one of a manifest:** a `ScenarioOutcome` may carry `fingerprint_kind` (`manifest`, the default, or `live-service`); another value in a document is refused with a `400`, the kind is written to the audit record, and `GET /api/ingest/scenario-outcomes` takes `fingerprint_kind` to list one kind only (a document without the field counts as `manifest`). The feed is still off until its switch is on. Declared in the SDK source of the feeds, with a test of both kinds.

- **What the sibling services hand to the server can be switched on from Server Admin, off by default and with a confirmation:** the `ingest` block of `GET` and `PUT /api/admin/server-config` carries `faultFeed`, `scenario`, `developerNode`, `anomalyFeed`, `anomalyVoiceRelay`, `voiceChain` and `proposalVerify` (booleans, all off) and `proposalKeysFile` (a file name inside the data folder, for the public keys that vouch for trajectory proposals). Turning one on, or changing the keys file, needs `confirm: true` and answers the warning `ingest_on`; every change is logged with the account. The environment variable of each switch (`HYDRA_UMC_FAULT_FEED` and the others) still decides and locks it (`409`), and the feeds that read the broker ask for a restart (`appliesOnRestart`). Tests in `tests/ingestOptions.test.ts`.

## [0.8.2.4] - A route cannot ship without being declared in the SDK: tools/verifysdkcontract.mjs now also compares the routes this server registers (docs/openapi.json) with the full inventory of the SDK (server.full.openapi.json) and fails,... (and 24 more changes)

- **A route cannot ship without being declared in the SDK:** `tools/verify_sdk_contract.mjs` now also compares the routes this server registers (`docs/openapi.json`) with the full inventory of the SDK (`server.full.openapi.json`) and fails, naming the method and route, when the server registers one the SDK does not declare. It was one-way before (only what the SDK promises had to exist here). The inventories agree today (111 routes each); an SDK checkout without that file leaves nothing to compare. 1 more test.

- **The read-out protection level of a production flash is a setting of the server (`production.rdpLevel`, off by default):** `GET` and `PUT /api/admin/server-config` carry `production.rdpLevel` (`0` or `1`; `400` for anything else, level 2 is permanent and is not offered), the variable `HYDRA_UMC_PRODUCTION_RDP_LEVEL` locks it, and a change is written to the log. STUDIO and SUITE show it as a switch with a confirmation. It only records the choice; no flashing tool reads it yet.

- **The server keeps the verdicts of the anomaly detector, a signed record of the voice commands, and checks a proposal signed with Ed25519, each off until its switch is on:** `GET /api/anomaly/verdicts` answers the latest `anomaly-verdict/1` of every series, read from the retained messages of the broker (a change to suspect or anomalous can be told to the voice interface); `GET /api/voice/chain` (administrator) lists the voice turns and confirmations, each entry signed with the key of the server and chained by hash to the one before it, without the transcript or any text; `POST /api/trajectory/proposals/verify` says whether a proposal is genuine, current and for the robot, using the public keys of the operators listed in a file and the Ed25519 of Node, so no library is added. A spoken question about a node or a motor (`query_node`) is answered by the server from the same verdicts, in the language of the client. 15 tests.

- **The server keeps the state of three feeds that its sibling services hand to it, each off until its switch is on:** `POST /api/ingest/scenario-outcome` stores a `ScenarioOutcome` of the shared contract (operator or administrator, audited); `POST /api/ingest/developer-node/status` stores `developer-node-status/1`, sent over HTTPS with the token of that node (only the hash of each token is kept, in a registry file read on every call); `GET /api/faults` answers the active faults and the history of the `fault-event/1` messages the server reads from its broker. Everything is written to a signed record chained by hashes with a retention that can be set, and each feed has a read route (`verify=1` checks the chain). 13 tests.

- **A relay for the switch that requires a pass verdict of the twin before the real robot moves (`GET` and `POST /api/hil-bridge/settings`):** STUDIO and SUITE read and edit `require_twin_pass` of the HIL bridge through the server, with the administrator's own token. Reading is open to any signed-in account; changing is for an administrator, needs `confirm: true` in both directions (nothing leaves this server without it), and is written to the audit record (`hil-bridge-twin-pass`). Off until `HYDRA_UMC_HIL_BRIDGE_URL` is set (`503`). 8 tests.

- **The build test of the repository compiles only on CI or when allowed:** for the stacks that compile (`rust`, `go`, `android`, `flutter`, `firmware-c`), `tools/build_test.py` prints `BUILD_TEST=SKIPPED` with exit status 2 on a plain PC, never a pass; `ALLOW_LOCAL_BUILD=1` allows it and a CI runner always may. The `python` and `node` stacks are not locked.

- **The proposals of the node watchdog can be listed and decided from STUDIO and SUITE:** `GET /api/ops-agent/proposals` and `POST /api/ops-agent/proposals/decide` (administrators only) speak to the watchdog over its signed channel (`incident-transport/1`: HMAC-SHA256 over the canonical JSON, nonce, time window, contract version; the check of the wire format is tested against vectors written by the watchdog's own code). The reply is accepted only if it is signed by the watchdog, addressed to this server, fresh and new. Approving needs `confirm: true`, the person who decides is the signed-in account, and every attempt is written to the audit record (`ops-agent-proposal-decision`). Off (`503`) until `HYDRA_UMC_OPS_AGENT_URL` and `HYDRA_UMC_OPS_AGENT_REGISTRY_FILE` are set. 15 tests.

- **The list of services that take the identity includes the connector hub:** it now reads the same key file and variable as the others and keeps its own verifier next to the shared one, so `GET /api/admin/service-identity` lists it among the services that accept the identity.

- **An administrator can switch on the identity of the server in its calls to the services:** `auth.serviceIdentity.enabled` of `PUT /api/admin/server-config` (off by default; a confirmation to turn it on, a warning when turned off, locked by `HYDRA_UMC_SERVICE_IDENTITY`, written to the audit record) makes the server present its signed token to the services, and `GET /api/admin/service-identity` (administrators) answers the switch, whether `JWT_SECRET` can sign, which services take the identity, which keep a verifier of their own and which do not yet, and the codes of the safe order (the server first, then the key of each service one by one). The key is still given to each service on the machine by its operator.

- **A relay for the switch that relaxes the identity of the approval of a plan (`GET` and `POST /api/semantic-planner/settings`):** STUDIO reads and edits `plan_approval.require_identity` of the semantic planner through the server, with the administrator's own token. Reading is open to any signed-in account; changing is for an administrator, needs `confirm: true` to relax it (nothing leaves this server without it), and is written to the audit record (`semantic-planner-settings`). Off until `HYDRA_UMC_SEMANTIC_PLANNER_URL` is set (`503`). The relay of the hub gate and this one share one function. 7 tests.

- **The calls of the server to the services can carry the identity of the server:** with `HYDRA_UMC_SERVICE_IDENTITY=1` every outgoing call (the status scan and the health probes of the family, the relays to the AI, data and speech services, the connector hub catalog, the CAN-OTA bridge, the telemetry producer, the stop relay, the takeover and the reload of the job dispatcher) presents one short token signed by this server (HS256 with `JWT_SECRET`, sixty seconds, the role the request needs), which is what a service with its identity key switched on requires. One outbound client does it (`src/serviceIdentity.ts`); a service that has a token of its own keeps receiving that one; nothing is signed with a `JWT_SECRET` that is unset, an example value or too short; off, which is the default, no call changes.

- **STUDIO can read and change the switch of the connector hub that answers a caller with no identity:** `GET` and `POST /api/connector-hub/gate/settings` relay to the new settings route of the hub with the administrator's own token. Changing it is for administrators only, turning it on needs `confirm: true`, the attempt and its outcome are written to the audit record (`connector-hub-gate-settings`), and the switch stays off by default.

- **The Security tab of the admin page draws a pairing code for the control apps:** hidden until an administrator asks for it, it carries this server's address and port, the SHA-256 fingerprint of its TLS certificate (read from the same `GET /api/admin/server-config` answer) and a name, as `hydra-umc://pair?host=..&port=..&fp=..&name=..`, with the limits of the apps' command contract (at most 600 characters, name of at most 64). A server without TLS gives a code without fingerprint and says the first connection cannot be pinned. The sentences are in the eight languages and `tests/adminUiPairing.test.ts` covers the link, what the apps would refuse and the texts.

- **A model submission carries its own licence and credit:** `POST /api/models/submit` accepts an optional `attribution` text (at most 8000 characters), keeps it in the index, in `ATTRIBUTION.txt` next to the model and in the download answer; the audit record only counts its characters. The new setting `modelSubmissions.requireAttribution` (off by default, in Config > Models) refuses a submission without it.

- **`POST /api/robot/:id/command` answers with an Operation and the first lifecycle event:** an accepted command now carries `operation_id`, `operation` (the closed `Operation` shape of the SDK: kind `robot.command`, status `authorized`, the robot as target, the `X-Correlation-Id` of the caller when it fits the pattern) and `lifecycle` (the closed `CommandLifecycleEvent`, state `ACCEPTED`, sequence 1). The same event goes over the WebSocket as `{ "type": "command-lifecycle", "schema": 2, "event" }` to the clients that opened `/ws` with `?remoteApiVersion=2`. The old fields are unchanged. The server only vouches for ACCEPTED; RUNNING, COMPLETED, FAILED and CANCELLED need a controller that reports them and are not announced yet. A refused command announces nothing.

- **The health probes fall back from `/health` to `/stats`:** the status scan and the ecosystem health report probe the uniform `GET /health` route of a service and, when it answers `404` (the service keeps it closed until its own switch opens it), probe `/stats` instead. Any other answer on `/health` (for example `503`) counts as the service reports it, and no other route has a fallback.

- **The AI dashboard can be framed by its own origin only:** the page served at `/dashboard-ai` now answers with `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so the panel of STUDIO can show it (`/dashboard-ai/?embed=1`, the same origin and the same login) and a page of another origin cannot. Tested against a real listener.

- **A relay to the decision gate of the connector hub, with the identity of the caller:** `POST /api/connector-hub/gate/evaluate` (operator or administrator) and `GET /api/connector-hub/gate/audit` forward the token of the signed-in person to the `serve-gate` of the hub, which verifies it with the public keys of this server and records who asked. Off until `HYDRA_UMC_CONNECTOR_HUB_GATE_URL` is set (`503` otherwise); a body that is not a JSON object is a `400`; a refusal of the hub is passed on. A new contract test starts the real gate and checks the decision, the caller in its audit file and the refusal of a foreign token. The edge of a data-lake window (`before` exclusive, `end` inclusive) is checked to cross the relay unchanged.

- **The restarts and the power actions are in the audit record:** the loopback `POST /api/system/reboot` and `/api/system/shutdown` write `power-reboot` and `power-shutdown` entries (`ok`, `failed`, or `refused` with the address and the reason when the caller is not this machine), and `POST /api/admin/restart` writes `server-restart` with the account and the address. `GET /api/audit` lists them like the other types.

- **The switches of the machine bridges can be set in Server Admin (`bridges`):** BRIDGE-DROIDS (`globalStop`, `cutOnGlobalStop`), BRIDGE-UAV (`missionUploadEnabled`), BRIDGE-AMR (`publishState`, `publishOpcua`, `zoneInterlock`, `zoneUnknown`) and BRIDGE-OPENPNP (`boardCode`) have one place and one way to be set. Everything that moves hardware is off by default; turning on a risky function or turning the cut on a global stop off is answered with a warning and is written to the security log and to the audit record `bridge-options`. The values are saved in the server configuration and, while the bridge gateway is on, published retained on `<prefix>/<bridge>/settings` when they are saved and when the gateway connects. A bridge applies them only when its own host allows remote settings (off by default on every bridge); BRIDGE-UAV, which has no broker connection, reads its switch from the server configuration file.
- **The retained settings of the machine bridges are signed:** the message on `<prefix>/<bridge>/settings` is now schema 2 with a counter (`seq`), `issued_at_ms`, `expires_in_ms` and the HMAC-SHA256 `signature` of the signed commands of the SDK, made with one key per bridge that is kept in a file (`~/.hydra-umc-keys/bridge-settings/<bridge>.key`, or `HYDRA_UMC_BRIDGE_SETTINGS_KEY_DIR`; made once with mode 600 when missing, never shown, logged or put in an answer). The gateway signs and publishes the messages again every 60 seconds, each valid for 120, so a bridge that restarts finds a current one; a bridge whose key is unusable gets nothing. A bridge applies a message only with a valid, current signature and a counter that is not older than the last one it applied, even when its host allows remote settings, and the unsigned schema 1 is no longer sent. `GET /api/admin/server-config` reports `bridgeSigning` (key file path, key state, last signature, counter) so STUDIO and SUITE can show it. 7 more tests, including signatures checked against the ones the SDK makes.

- **The request limits per address have a switch and numbers in Server Admin (`rateLimits`):** the sign-in, renewal, general API, code and service routes and global stop limiters are on by default, as before. An administrator can now switch them off (it asks for a confirmation and warns with `rate_limits_off`) and change each number (`loginMax`, `loginWindowSeconds`, `refreshMax`, `apiMax`, `sensitiveMax`, `apiWindowSeconds`, `stopAllMax`, `stopAllWindowSeconds`) with `PUT /api/admin/server-config`; every number is a whole number inside a fixed range (the lowest values cannot lock an administrator out, the highest cannot turn a limiter into a formality) and a very high one warns with `rate_limits_loose`. The values are saved in `data/server-config.json`, a change applies at once (the counters start again), is written to the security log and recorded in the audit record as `rate-limits-options`, and the answer of `GET /api/admin/server-config` reports each value with its source and range. The variables `HYDRA_UMC_RATE_LIMITS=off`, `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS`, `REFRESH_RATE_LIMIT_MAX`, `API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_WINDOW_MS`, `SENSITIVE_RATE_LIMIT_MAX`, `STOP_ALL_RATE_LIMIT_MAX` and `STOP_ALL_RATE_LIMIT_WINDOW_MS` still win and lock the option in the screen; a variable outside the range is ignored instead of clamped. The Security tab of the admin UI has the switch and the eight numbers in the eight languages.

- **Optional asymmetric sign-in tokens and a public key set (`auth.jwtAlgorithm`, `GET /.well-known/jwks.json`):** the server still signs HS256 with `JWT_SECRET` by default. An administrator can choose `EdDSA` (Ed25519) in Server Admin or with `HYDRA_UMC_JWT_ALGORITHM`: new tokens carry a `kid`, the public keys are published at the public `GET /.well-known/jwks.json` (public parameters only, `Cache-Control: public, max-age=300`, `404` while HS256 is in use), so another service can verify a token without holding a secret that could forge one. The private keys live in one file outside the repository (`HYDRA_UMC_JWT_KEYS_FILE`, mode `0600`), `POST /api/admin/jwt-keys/rotate` makes a new key the active one and keeps the previous one valid for `auth.keyOverlapSeconds`, and `GET /api/admin/jwt-keys` shows the state without any private part. The check is strict for HTTP and the WebSocket: the algorithm comes from the configuration, never from the token; `alg: none`, RS/ES/HS384 and an HS256 token signed with the public key are refused, and `kid`, `exp`, `nbf` and `iat` are validated. `auth.acceptHs256` (default on) keeps the old HS256 tokens working during the switch. The answer of `/api/admin/server-config` carries `auth`; the shapes `JwksDocument`, `JwtKeys` and `JwtKeyRotated` are in the contract of the SDK. Every answer of the server no longer carries `X-Powered-By`.

- **`PUT /api/settings` with a mandatory `If-Match` (optimistic concurrency):** the administrator saves the whole configuration (racks, pick-and-place, catalogue, cameras) sending the `ETag` of `GET /api/settings` as `If-Match`; without it the answer is `428` (`if_match_required`), when the settings changed since they were read it is `412` (`settings_changed`, with the current `revision`) and nothing is stored, and a successful save answers the new `ETag`. `POST /api/settings` keeps working as before (optional `If-Match`, `409`). See `docs/REMOTE_API.md` section 2c.

- **Behaviour change: robot ids are global.** Registering a robot whose id another robot already uses (in the same or another controller) through `POST /api/settings` or the `settings` message of the WebSocket is refused with `409` `robot_id_duplicated` and the list of controllers involved, and nothing is stored. A configuration that already repeats ids (from an older version) still starts, but the routes by such an id (`/api/robot/:id` and its `command`, `claim`, `release`, `heartbeat`, `jog-arm`, and `safety-limits?robotId=`) now answer `409` `robot_id_ambiguous` instead of acting on the first controller that had the id; the robots with a unique id are not affected. Each ambiguous id is written to the log at start and listed by the new `GET /api/admin/robot-ids` (administrator). Fix the repeated ids in the settings to get the routes back. See `docs/REMOTE_API.md` section 2v.

## [0.8.2.3] - The motion commands and the model submissions are in the audit record, the operator presence routes have named shapes, the interval of the jog flow in the audit is a safety limit and a bench test script lists what needs a robot

- **Model submissions are in the audit record:** `POST /api/models/submit` (administrator only) records a `model-submit` entry with the account, the address, the model name, the category and whether it replaces an existing one; refusals carry the reason, and the model content is never recorded.

- **Named shapes for the operator presence routes:** `GET` and `POST /api/operator/presence` answer with `OperatorPresence` and `OperatorPresenceAck` in `docs/openapi.json`, instead of inline schemas; the two shapes now come from the copy of the shapes file of the SDK like all the others.

- **Bench test script:** `docs/BENCH_TESTS.md` lists the checks of the frame probe, the live state of a robot and the global stop that need a camera and a robot, all marked not executed.

- **The motion commands are in the audit record:** play, pause, stop, trajectory, table, speed, tool, valve and pump are recorded as `robot-motion` with the account, the controller, the address and the robot, and a stream of jogs is recorded at most once per account and robot every `audit.motionIntervalSeconds` seconds (10 by default, 0 leaves the stream out, set in the safety limits)

## [0.8.2.2] - A relay of the tier plan of the data lake for administrators, the dead-man of the presence of the operator that lowers the speed when the heartbeat is lost, and screenshots of Server Admin in the README

- **Relay of the tier plan of the data lake for administrators (`GET` / `PUT /api/telemetry/downsample-plan`):** the editor of Studio reads and saves the plan of the data lake through the server, which presents the administration token of the data lake (`HYDRA_UMC_DATALAKE_ADMIN_TOKEN`, else `HYDRA_UMC_DATALAKE_TOKEN`) and returns the status and body it receives, so the validation, the confirmation of deletion and the hash check stay in the data lake. `404` when the data lake has the option off, `503` when it is not configured. Checked against a stand-in data lake by the telemetry relay contract.
- **Dead-man of the presence of the operator, off by default (`POST /api/operator/presence`, `presence.enabled`):** the numbered heartbeat the watch sends is accepted (authenticated, idempotent by its sequence number). When the heartbeats stop, or the person says they left, the server acts on the robots that account holds a claim on: by default it slows them down to a share of their speed and warns the registered phones; Server Admin (`presence.action`, or `HYDRA_UMC_PRESENCE_ACTION`) chooses between slowing down, pausing, only warning and stopping. The timeout, the share of speed, the number of heartbeats that bring the operator back and the ramp that returns the speed without a jump are in `data/server-config.json`. It is written to the log and to the audit record, the global stop is never held back by it, and a paused or stopped robot is never resumed by it. Tried with simulated robots only. `GET /api/operator/presence` shows the state of the signed-in account.
- **The README shows screenshots of Server Admin** (security, user accounts and server configuration), taken against a throw-away server with a made-up administrator by `tools/capture_screenshots.mjs`; the list and the captions in the eight languages are in `docs/screenshots.json`.

## [0.8.2.1] - Signed tickets for the information routes, a Home Assistant device for every robot and the trusted networks switch

- **Signed tickets for the information routes, off by default:** with the option `infoTickets.enabled` (or `HYDRA_UMC_INFO_TICKETS=1`) on and the information routes closed by `HYDRA_UMC_INFO_AUTH=required`, `POST /api/info/ticket` gives a signed-in account a ticket for the address (`?ticket=`) that opens `/metrics`, the system metrics, the supervisor, the ecosystem status and the model catalogue for a scraper or a dashboard that cannot send a token. The ticket is signed with a key of its own (a camera ticket does not open these routes, nor the reverse), lives 300 seconds, and only an administrator can ask for longer, up to `infoTickets.maxTtlSeconds` of the configuration file. Off, the route answers `404` and a ticket is ignored.

- **Home Assistant finds the robots by itself, off by default:** with `mqtt.homeAssistant.enabled` (or `HYDRA_UMC_MQTT_HOME_ASSISTANT=1`) the MQTT bridge also publishes, retained, the discovery configs of each robot (online flag, tool, playback state, the six joints and, in `commands` mode, a stop button) under `homeassistant/` or the prefix chosen in `mqtt.homeAssistant.discoveryPrefix`. It is a switch of Server Admin and applies on the next start.

- **Trusted networks, off by default:** an administrator can turn on (Server Admin, the configuration file or `HYDRA_UMC_TRUSTED_NETWORKS=1`) a rule that tells the house and its VPN (the private ranges or the ranges listed in `data/server-config.json`) from any other address. From outside, administering the server is refused (`403`, `remote-policy`), the policy `view` also refuses every command but a stop, and only accounts with the second factor can sign in or renew a session. Overwriting the settings over the WebSocket is refused from outside too. Refusals are audited, a damaged range only makes the trusted area smaller, and nothing changes while the option is off. The Security tab of the admin panel shows the switch in the eight languages. See `docs/REMOTE_ACCESS_VPN.md`.

- **HOME / RESET is held to the rules of the jog:** the `reset` command now needs the jog armed where the administrator requires it, is ordered by `seq` like the jog, and sends the arm to the home pose of the model of each robot it reaches (the table the control programs share) instead of a formula that fits only the generic robot. A pose that is not that home pose answers `400` (`home-pose-mismatch`), one with a joint outside its range answers `422` (`home-out-of-limits`), and a refused reset moves nothing.

## [0.8.2.0] - A gateway to the machine bridges and push notifications to the iPhones, both off by default, and TypeScript 7

- **A gateway to the machine bridges, off by default:** `GET /api/bridges`, `GET /api/bridges/{name}/state` and `POST /api/bridges/{name}/cmd/{verb}` read the retained state of a bridge from the broker and publish a command on its topic, waiting for its answer. Behind the switch `bridgeGateway.enabled` (`HYDRA_UMC_BRIDGE_GATEWAY=1`; off, the routes answer a bare `404`), only a bridge that announced itself can be addressed, only the verbs of a list (`status`, `stop`, `pause`, `resume` by default; never `job`) are accepted, the pace is limited (a stop never waits) and every command is audited without its parameters. See `docs/REMOTE_API.md` section 2s.

- **TypeScript 7:** the type checker is the native TypeScript 7 compiler; the typecheck, the unit tests, the OpenAPI check and the bundle pass with it.

- **Push notifications to the iPhones, off by default:** `POST /api/push/devices` and `DELETE /api/push/devices/{token}` register and remove the device token of a phone (with its language) and `GET /api/admin/push` tells an administrator whether the service is on and whether its credentials are usable, never the credentials or the tokens. When `push.enabled` is on (Server Admin, the configuration file or `HYDRA_UMC_PUSH=1`) the server tells the registered phones, through the Apple push service and in their language, when a job finishes and when a global stop is issued. The credentials of the Apple account come only from the environment (`HYDRA_UMC_APNS_KEY_FILE`, `HYDRA_UMC_APNS_KEY_ID`, `HYDRA_UMC_APNS_TEAM_ID`, `HYDRA_UMC_APNS_TOPIC`), the key file must be outside the directory the server runs from, and nothing of it is ever logged or returned. Tested against a simulated push service; see `docs/PUSH_NOTIFICATIONS.md` for what the Apple account needs.
## [0.8.1.9] - The job dispatcher options are edited in Server Admin and read again at once, the missions pass to a standby orchestrator with the proofs of the stops, off by default, and the admin panel has a Security tab

- **The dispatcher reads its file again right after the server writes it:** after the two replanning options are written, the server calls `POST /admin/reload-config` of the dispatcher. The answer of `server-config` says whether it took it (`jobDispatcher.replan.reload`); a file the dispatcher refuses leaves its previous values in force. `appliesOnDispatcherRestart` is now true only while the dispatcher has not taken the file.

- **The missions are handed over to a standby orchestrator with the proofs of the stops, off by default:** with `jobDispatcher.takeover.enabled` (or `HYDRA_UMC_ORCH_TAKEOVER=1`) the server keeps the last replica of the primary orchestrator and the stops that the relay acknowledged, and when the primary has been silent for `failuresBeforeTakeover` checks it sends the standby `POST /replica/takeover` with the replica and the proofs that still apply, once per outage. Nothing is delivered with a replica that is too old or none at all, a standby that refuses is not tried again, and the times and limits are in the settings file. See `docs/ORCHESTRATOR_TAKEOVER.md`.

- **The admin panel has a Security tab:** administrators see the nine access switches (`health.open`, `safety.publishGlobalStop`, `connections.recordAddress`, `camera.open`, `websocket.allowQueryToken`, `logging.redactSecrets`, `voice.requireSignature`, `camera.credentialsViaEnv`, `install.newInstallTls`) and the job dispatcher options (the delivery of its stop requests, its robot map and the two options of its replanning), as in Server Admin of STUDIO and SUITE. A switch fixed by the environment is locked, the value that lowers the protection asks for a confirmation, only what changed is sent, and the sentences of the server's warnings are shown. The tab speaks the eight languages (the rest of the panel is still English only).

- **The relay reaches the dry run of a plan and the estimates of the dispatcher:** `/api/ai/semantic-planner/*` and `/api/ai/job-dispatcher/*` are forwarded only for `POST /plan/simulate`, `GET /dispatch/eta` and `GET /health`; every other request to them is refused with `403` before it is forwarded. The dispatcher token is presented from `JOB_DISPATCHER_TOKEN`. The read-only list of the data lake gains `/windows`, so that a client can tell whether the window statistics are on; the downsampling routes stay closed.


- **The job dispatcher options are edited in Server Admin:** `GET`/`PUT /api/admin/server-config` carry a new `jobDispatcher` section. `stopRelay.enabled` (locked by `HYDRA_UMC_JOB_STOP_RELAY`, applied on the next start) and `stopRelay.robotMap` (dispatcher robot id to numeric robot id, validated, read again at every pass of the relay) belong to the delivery of the stop requests. `replan.allowUnconfirmed` and `replan.stopAckTimeoutSeconds` (greater than 0, at most 86400) are written, atomically and only those two keys, into the JSON file that the dispatcher reads when it starts; the path of that file comes from `HYDRA_UMC_JOB_DISPATCHER_CONFIG` or `jobDispatcher.configFile`, never from a request, and without it the same request answers `409`. A file that is not valid JSON is never overwritten and, if it cannot be written, nothing is saved. Administrators only; every change is logged and written to the audit record (`job-dispatcher-options`), and the answer warns when the delivery is switched on or a job may move without a confirmed stop.


- **The stop that the job dispatcher asks for is delivered, off by default:** with `jobDispatcher.stopRelay.enabled` (or `HYDRA_UMC_JOB_STOP_RELAY=1`) the server reads `GET /jobs/stop-requests` of the dispatcher, stops the robot named there through the map `jobDispatcher.stopRelay.robotMap` (the same stop as the `stop` command, which no reservation holds back) and only then sends `POST /jobs/stop-ack`. A stop that could not be applied, a robot that is not in the map, an expired or too old request are never acknowledged, so the dispatcher keeps the job `unknown` unless its own `replan.allow_unconfirmed` is on. The times and limits are in the file, the address and the token in the environment, a wrong setting stops the relay from starting, and every outcome is audited. See `docs/JOB_STOP_RELAY.md`.

- **The shapes of the answers of the inventory come from the SDK:** the 40 shapes that `tools/openapi_types.mjs` wrote by hand are now the file `tools/sdk/server.shapes.json`, a byte copy of `contracts/sources/server.shapes.json` of the SDK, and the module reads it (it refuses a file that is not a file of shapes). `tools/verify_sdk_contract.mjs` compares the copy with the SDK checkout whenever one is near and fails on a difference or on a missing copy; `docs/openapi.json` is unchanged byte for byte. New `tests/sdkShapes.test.ts`.

## [0.8.1.8] - A client can read whether the remaining-useful-life relay is open, the last contact of each service survives a restart and the route inventory is more exact

- **A client can read whether the remaining-useful-life relay is open:** the new `GET /api/rul/config` (any signed-in account, read only) answers `{ enabled, maxPoints, timeoutMs }` and nothing else, so the card of the AI dashboard appears only when the server has `rul.enabled` on and sizes its request to `rul.maxPoints`. A missing or unreadable configuration gives the closed default (`enabled` false) instead of an error. Characterization and route tests in `tests/rulRelay.test.ts`, a live check in `tools/verify_local_ai_proxy_contract.mjs`, and the answer is typed in `docs/openapi.json`.
- **The last contact of each service survives a restart:** the time the health of the ecosystem last heard from each service is kept in `data/ecosystem-health-last-seen.json`, written atomically (temporary file, then rename) at most once per `ecosystemHealth.lastSeenSaveIntervalS` seconds (30 by default) and capped to `ecosystemHealth.lastSeenMaxEntries` services (256 by default, the most recently heard are kept). A file that is missing, damaged, over 256 KiB or with times in the future is ignored.
- **The route inventory is more exact:** `docs/openapi.json` now lists the `404` a signed-in client gets from `GET /api/ecosystem/health` while `ecosystemHealth.enabled` is off (and the `403` for a viewer), and the `{id}` of the robot and camera routes is an integer, as the handlers read it.

## [0.8.1.7] - A relay of the remaining useful life for operators behind a switch, an ecosystem health route, a frontend build that brings the 3D models first and a gate of remote access by the type of the client

- **The remaining-useful-life card of the AI dashboard can use the relay:** `POST /api/ai/anomaly-detector/rul` is a write to the detector, so until now only an administrator could send it and the card failed for an operator. The new option `rul.enabled` (Server Admin, `PUT /api/admin/server-config`, or `HYDRA_UMC_RUL=1`; off by default, which keeps today's behaviour exactly) opens only that exact request to operators, with the same session, the same token held only by this server and the same destination (the anomaly detector on loopback); a body above `rul.maxBodyBytes`, more than `rul.maxPoints` points or a body of another shape is refused before it is forwarded, and the detector gets `rul.timeoutMs` for the whole exchange, answer included. New `tests/rulRelay.test.ts`.
- **`build-frontend.sh` and `build-frontend.bat` bring the 3D models first:** the STUDIO tree no longer holds the model files (they come from one verified package), so the frontend build runs `node scripts/mesh_pack.mjs ensure --source auto` in STUDIO before `npm run build` and stops with the message of that command when the package can neither be downloaded nor found in the cache (`~/.cache/hydra-umc/meshes`, or `HYDRA_UMC_MESH_PACKAGE`).
- **The health of the ecosystem in one answer:** the new `GET /api/ecosystem/health` (operators and administrators) lists every service that declares a port or a systemd unit as `ok`, `degraded`, `down` or `unknown`, with a reason code, the version it reports against the version of its manifest (drift), when the server last heard from it, the days left of the TLS certificate of the server itself and a list of warnings. Each service is asked at the same time with a short timeout and no side effect, so a service that is dead or hangs never hides the others; only an administrator sees ports, health paths and units. It is behind the new option `ecosystemHealth.enabled` (Server Admin, `PUT /api/admin/server-config`, or `HYDRA_UMC_ECOSYSTEM_HEALTH=1`; off by default: `404`), and `ecosystemHealth.certWarnDays` and `ecosystemHealth.probeTimeoutMs` of `data/server-config.json` set the warning window and the wait for each service. New `tests/ecosystemHealth.test.ts` (simulated services, simulated clock), `tests/ecosystemStatus.test.ts` (the existing status scan, fixed first) and `tools/verify_ecosystem_health_contract.mjs`.

## [0.8.1.6] - A remote-access gate that compares only the type of the client, two more security options set from Server Admin and the version of the client kept in the history of connections

- **The remote-access gate compares the type of the client only:** `X-Hydra-Client: android/0.7.5` was not recognised as `android`, so a client that sent its version slipped past the per-client Remote Access switch. The gate now cuts the version off (and ignores the case and the spaces around the type, and reads every value of a header that has several), so a header with a version, any text after the slash or a very long one opens and closes access exactly as the same header without it; the version still goes to the history of connections apart from the type. New `tests/remoteAccessClientType.test.ts` and checks in `tools/verify_voice_relay_contract.mjs`.
- **Two more security options can be set from Server Admin:** the password of an IP camera on the command line of its process (`camera.credentialsViaEnv`, next to `HYDRA_UMC_CAMERA_CREDENTIALS_VIA_ENV=off`) and a new installation not switching TLS on by itself (`install.newInstallTls`, next to `HYDRA_UMC_NEW_INSTALL_TLS=off`). Both are options of `PUT /api/admin/server-config` and of the security snapshot, start on the safe side, are won by the environment variable (`409` when it is set), return the warnings `camera_credentials_in_arguments` and `new_install_tls_off` when loosened and are written to the log. The camera option applies the next time a camera process starts; the installation option is only read at the first start of an installation. New `tests/installAndCameraCredentialsOptions.test.ts` and a check in `tools/verify_legacy_opt_out_contract.mjs`.

## [0.8.1.5] - Four more security switches in Server Admin, updated dependencies with known vulnerabilities and an inventory of routes checked against the SDK

- **The server's inventory is checked against the routes the SDK declares as a source:** `tools/verify_sdk_contract.mjs` also reads the OpenAPI documents the SDK generates from its own route sources (the connection routes first) and fails when a declared route is not registered, its access differs, a status code is missing, the handler reads a query parameter that is not declared (or the reverse), or the `ConnectionClient` and `ConnectionEvent` schemas of the inventory differ from the closed schemas of the SDK. It does nothing when the SDK checkout has no such document. The check found one real difference, now fixed: the inventory described `app_version` as any text although the handler only keeps values of 1 to 24 letters, digits, dots, hyphens and underscores; `docs/openapi.json` now carries that pattern.
- **Dependencies with known vulnerabilities are updated:** the request-body parser, the query-string parser, the proxy-address check and the address library move to their patched releases inside the same major version (a spoofing fix for trusted proxies and denial-of-service fixes); only the lock file changes and `npm audit` now reports nothing.
- **The four remaining security opt-outs can be set from Server Admin:** the camera pictures without a ticket (`camera.open`), a token in the WebSocket address (`websocket.allowQueryToken`), secrets in the log (`logging.redactSecrets`) and the signature of a confirmed spoken request (`voice.requireSignature`) are now options of `PUT /api/admin/server-config` and of the security snapshot, next to the environment variables they always had (which still win and lock the option with `409`). They apply on the next request, with no restart; each one starts on the safe side and loosening one returns a warning and is written to the log. New `tests/legacyOptOutOptions.test.ts` and a check of the saved options in `tools/verify_legacy_opt_out_contract.mjs`.

## [0.8.1.4] - The global stop announced to the rest of the ecosystem, a signal of life per robot, the health route behind a switch, the history of the clients that connect, the enable and disable commands of a robot, TLS by default and a variable for the listen port

- **The global stop can be announced to the rest of the ecosystem:** with the new option `safety.publishGlobalStop` (Server Admin, `PUT /api/admin/server-config`, or `HYDRA_UMC_SAFETY_PUBLISH_STOP=1`; off by default) a `POST /api/stop-all` also publishes a retained `SAFE_STOP` (the `SafetyState` contract of the SDK) on `<mqtt prefix>/safety/estop`, after the stop was applied and without ever delaying or breaking it; the answer then carries `announced`. The state stays latched until an administrator calls the new `POST /api/stop-all/release`, which publishes `READY` and is written to the audit record. The contract, and what a bridge does to honour it, are in `docs/GLOBAL_STOP.md`. Tested, including a retained message on a real broker.
- **A signal of life per robot:** `GET /api/robots/liveness` says whether the server had news of each robot of the roster (`live`, `stale` or `unknown`, with the age of the last news and where it came from) instead of repeating the `online` flag that only records what an operator switched on; `POST /api/robot/:id/heartbeat` lets a bridge or controller report real news. The limit is `liveness.staleAfterS` in `data/server-config.json` (30 seconds by default).
- **`GET /health` without a sign-in, behind a switch:** the new option `health.open` (Server Admin, or `HYDRA_UMC_HEALTH_OPEN=1`) lets a supervisor or load balancer that cannot sign in read a bare `HealthReport` (no version, host or counts). It is off by default and the route then answers `404`, as if it did not exist.

- **Who connects: the list of clients and the history of sign-ins:** `GET /api/connections/clients` and `GET /api/connections/events` answer in the closed shapes of the `ConnectionClient` and `ConnectionEvent` contracts of the SDK. The server writes `first_seen`, `login`, `login_failed`, `second_factor_failed`, `logout` and `session_expired` as they happen, counts the open sessions of each client (the refresh token remembers which client opened it), and tells a client by the header `X-Hydra-Client` (`kind` or `kind/version`) or by its user agent. No password, token, cookie or code is ever in it, and a refused sign-in keeps the typed name only when it belongs to a real account. An administrator sees every client; any other account sees only its own. The address and user agent are written only when the new option `connections.recordAddress` is on (Server Admin, or `HYDRA_UMC_CONNECTION_RECORD_ADDRESS=1`; off by default) and are shown to administrators only. The history lives in `data/connections.json`, bounded to 500 events and 300 clients. New contract script `tools/verify_connection_history_contract.mjs` and `tests/connections.test.ts`.

- **The spoken status is written in the language of the client:** the status text that the server puts into a voice reply (`POST /api/voice/turn`) follows the `locale` of the turn, in English, Spanish, German, French, Italian, Japanese, Chinese or Portuguese (any other locale gets English). The reply says which sentence it is (`messageCode`) and in which language (`textLanguage`), and the replies of the voice service already carry the same fields, so the watch no longer has to show English text.

- **The `enable` and `disable` commands of a robot (safe mode):** `disable` stops the robot, switches its valves and pumps off, drops the arming of its jog and marks it `enabled: false`; like a stop it is open to every signed-in account, needs no claim and no `If-Match`, and is recorded in the audit record. From then on every command of that robot except `stop`, `disable` and `enable` is refused with `423` (`robot-disabled`), and the robot cannot be armed. `enable` brings it back and restarts nothing; it is the risky direction, so it is off by default (`403`, `enable-not-allowed`) until an administrator turns on the option `robots.allowEnable` (Server Admin, `PUT /api/admin/server-config`, or `HYDRA_UMC_ROBOT_ALLOW_ENABLE=1`), and then only an administrator may use it (`403`, `admin-required`). Bluetooth and MQTT accept `disable` but never `enable`. New contract script `tools/verify_robot_enable_contract.mjs`; the typed contract of the SDK describes both commands.

- **The listen port has a variable of its own:** `HYDRA_UMC_SERVER_PORT` wins; the shared `PORT` is only a last resort (it prints a warning) and is ignored whenever the specific variable is valid, so a shared environment file or an `export PORT=...` can no longer move the server onto the port of the broker or the gateway. The port saved by the Config screen and the default 3000 are unchanged.

- **TLS is the default of a new installation:** on its very first start, when the certificates of the installation's own authority exist, the server saves TLS as on (an ordinary saved choice that the Server Admin screen can switch off). An installation that already ran, or one without those certificates, is not changed; `HYDRA_UMC_NEW_INSTALL_TLS=off` forbids the default. Tested in `tests/newInstallTls.test.ts`.

## [0.8.1.3] - Two-step sign-in, a contract test against the SDK, flash progress only for administrators and three more switches in Server Admin

- **Optional second factor for the sign-in (TOTP, RFC 6238):** an account can turn on a six-digit authenticator code (`/api/totp/begin`, `confirm`, `disable`, `status`) and gets ten one-time recovery codes; once on, `POST /api/login` needs `totp` and answers `401` with `totpRequired` without it. Codes are accepted once, five wrong ones in a row make the next tries wait, the secrets are encrypted in `data/totp.json`, and an administrator can reset an account with `DELETE /api/users/:username/totp`. Accounts that did not turn it on sign in exactly as before. The routes and the sign-in `totp` field have named request and response schemas in the OpenAPI document (also in the typed contract of the SDK), and STUDIO and SUITE have the screens to turn the second step on and off.
- **A contract test against the SDK:** `tools/verify_sdk_contract.mjs` (part of `npm test`) reads the route contract the SDK publishes and fails if any operation it promises is not registered here, differs in public or signed-in access, or lists a status code the handler never produces (codes added by a shared middleware are not asked of the handler). The SDK is looked up in `HYDRA_UMC_SDK_DIR` or in a sibling checkout; with none it is skipped, and `HYDRA_UMC_REQUIRE_SDK=1` makes that a failure. 6 tests.
- **Flash progress goes only to administrators:** the `canota_progress` messages of a firmware flash were sent to every connected WebSocket client, including operators and viewers; they now reach only the connections of an administrator, the same rule as the flash itself. The relay contract check keeps an operator connection open during a flash and fails if it receives any progress.
- **README in the universal layout:** the README and its seven translations follow the layout that the four families share (22 sections in a fixed order), with an architecture picture and a repository-structure picture drawn from `docs/architecture.json` and `docs/structure.json`; the CI validator checks both pictures and the file tree.

- **Three more options in Server Admin:** whether a voice reply repeats what was said, the least confidence of the speech recognizer before a request that starts a movement is accepted, and the MAVLink 2 signing key file with the switch for unsigned messages (`voice` and `mavlink` in `PUT /api/admin/server-config`, validated, with the same environment-wins rule). The voice values travel with every turn to HYDRA-UMC-VOICE-UI (a client cannot set them), the MAVLink values are read from `data/server-config.json` by HYDRA-UMC-BRIDGE-UAV. The defaults are the conservative ones the services already had. Tested, including a real round trip through the voice service.
- **The layout of the README is checked in the CI:** the validator runs `tools/universal_readme_check.py` and lists, as a warning, what differs from the universal layout of the README.

## [0.8.1.2] - A read-only role, `viewer` and the edits of one robot are commands, so an operator can make them

### Firmware and protocol

- **The edits of one robot are commands, so an operator can make them.** `points` (replace the recorded points, refused while the robot plays), `loop`, `model`, `role`, `combine`, `joints` (a jog for the arming rule) and `xyTableConfig` go through `POST /api/robot/:id/command` with the claim, `If-Match` and audit rules of every command; each is checked as a whole before anything changes, persisted and broadcast as a delta with the whole field. Until now they travelled inside the whole settings tree, which only an administrator may write. The Bluetooth service and the MQTT bridge do not accept them. 11 tests.
- **The firmware flash relay carries the signature.** `POST /api/hardware/canota/flash` forwards `version_patch`, `downgrade_from` and `signature` (the Ed25519 signature of the image, 128 hexadecimal digits) to the flashing service after checking their shape; the server holds no key.
- **The server presents the Bearer tokens of the services it relays to.** The vision, analysis and data services can ask for a token of their own (some refuse to start without one away from loopback), and no client talks to them directly: `/api/ai/*` now sends `HYDRA_UMC_VISUAL_SERVOING_TOKEN`, `HYDRA_UMC_VLA_ENGINE_TOKEN`, `HYDRA_UMC_COGNITIVE_NODE_TOKEN`, `HYDRA_UMC_DETECTION_HEF_TOKEN`, `HYDRA_UMC_VISION_NODE_TOKEN` or `HYDRA_UMC_ANOMALY_TOKEN` (the name each service reads; `..._FILE` names a file with the token), the camera streams send `HYDRA_UMC_VISION_STREAMER_TOKEN` and the telemetry relay sends `HYDRA_UMC_DATALAKE_READ_TOKEN` else `HYDRA_UMC_DATALAKE_TOKEN`. Clients never see them; a service with no token is reached exactly as before.
- **A camera counts as running only when frames arrive**: the stream supervisor asked a bare TCP connect, so a frozen RTSP session or a stuck capture backend that kept its port open looked healthy and was never respawned. It now asks `GET /health` of the stream process (`src/cameraHealth.ts`): 200 means frames are arriving, 503 with `connecting`, `stalled` or `given_up` means the port answers but sends none, and the existing threshold (10 misses, about 20 s) then kills and respawns it with the reason in the error text. A streamer without that route (404) or that does not answer in time keeps the old meaning. 7 new tests; not run against a real camera.
- **One secret redaction for the log**: `src/redaction.ts` is a port of the shared module of the SDK and passes the same 35 shared vectors (`tests/fixtures/redaction_vectors.json`). Every server log line and the captured output of the camera processes pass through it; `HYDRA_UMC_LOG_REDACTION=off` is for bench debugging only.
- The `command` label of `hydra_robot_commands_total` comes from a closed list of the commands the server knows (anything else is counted as `unknown`), so a signed-in client can no longer create unlimited metric series with made-up command names. Tested with fifty made-up names.
- New `HYDRA_UMC_AI_ACCESS=admin` limits the relay to the local AI services (`/api/ai/*`) to administrators. Unset, any signed-in user can use it, as before. Tested.
- The server log can keep more than one rotated file: `HYDRA_UMC_LOG_KEEP` (`.1` to `.N`, default 1) and `HYDRA_UMC_LOG_MAX_BYTES` (default 10 MB). Tested.
- The AI relay access, the sign-in requirement of the host information and TLS can now be changed by an administrator from the Server Admin screen of the control app (`GET`/`PUT /api/admin/server-config`), not only by environment variable. The environment of the deployment still wins and is reported as locked; the defaults are unchanged (relay open to any signed-in user, host information open, plain HTTP). Turning the sign-in requirement off returns a warning and is written to the log with the name of the administrator. The certificate in use is reported with its SHA-256 fingerprint; a certificate and key that cannot be read or do not belong together are refused before they are saved. Tested.
- The settings are now written by a transactional store: `settings.json` and the points files are committed together through a journal, so a cut in the middle (power loss, kill, full disk) is finished or discarded on the next start and never leaves files from two different moments. A copy of `settings.json` is kept in `data/backups/` (`HYDRA_UMC_SETTINGS_BACKUPS`, default 10, at most one every `HYDRA_UMC_SETTINGS_BACKUP_INTERVAL_S` seconds), and a damaged `settings.json` is kept aside and restored from the newest good copy instead of starting empty. An existing installation is migrated on its first start without converting anything (the files keep their format) after a full copy of the previous files. `HYDRA_UMC_SETTINGS_STORE=plain` goes back to the earlier file-by-file writing. Tested with cuts at every step of the protocol.

### Programs and windows

- **A bridge to the MQTT broker of the cell** (off by default; `HYDRA_UMC_MQTT_BRIDGE`, or `mqtt` in `data/server-config.json`, also editable from the Server Admin screen, effective on the next start). `state` publishes the state of every robot on retained topics (`<prefix>/robot_<id>/state`, `joints`, `tool`, and `<prefix>/status` with a last will), only what changed, at most four times a second, without the recorded points, the camera credentials or the reservation history. `commands` also carries out the control commands published on `<prefix>/robot_<id>/cmd/<command>` through the same route a network client uses, with the token of a dedicated account (`HYDRA_UMC_MQTT_COMMAND_USER`), so its role, the reservations, `If-Match` and the jog limits apply; the answer goes to `.../result`. The passwords come only from the environment. Tested against a real broker. See `docs/MQTT_BRIDGE.md`.
- **A Bluetooth LE service** (off by default; `HYDRA_UMC_BLE_GATT` or `ble.mode` in `data/server-config.json`, also editable from the Server Admin screen): a phone near the CM5 reads the state (notified after it subscribes and after every change, cut for the MTU, one newest state at a time) and, in `commands` mode, sends commands with the access token of its account. A command is handed to `POST /api/robot/:id/command` over the loopback address, so the authentication, role, reservation and safety-limit rules are the ones of a network client, and its acknowledgement (new ACK characteristic) is sent only after that route answered, with its status and code. The encrypted link is required by default (`HYDRA_UMC_BLE_ENCRYPTION=off` or `ble.requireEncryption`), each phone has a pace limit (STOP is never limited) and the options and tunables are documented in `docs/BLE_GATT.md`. The radio side is `scripts/ble_gatt_helper.py` (BlueZ over D-Bus, spoken to by JSON lines); a server without BlueZ goes on without Bluetooth. Tested against a simulated radio, the helper without a radio and the whole server (`tools/verify_ble_gatt_contract.mjs`); not verified on a real adapter or phone.

### Tests, builds and checks

- **A read-only role, `viewer`.** An account with it reads the state, the claims, the limits, the camera lists and pictures and asks for a camera ticket; every call that writes (a command, the global stop, a claim, an upload, a settings write, the user list) answers `403` with `code: "VIEWER_READ_ONLY"`. The rule is applied once, in the sign-in check, by method, so a route added later is read-only for a viewer too, and it uses the role the account has now: demoting an account ends what its open session could do on the next call. It is the account a poller (the OPC UA server) or a wall display should use. Tested in `tests/serverPolicy.test.ts` and with the real server in `tools/verify_viewer_role_contract.mjs`.
- The TypeScript check runs in full strict mode (`"strict": true`; it used to be only the null checks). The code already complied, so nothing else changed.
- **The AI dashboard lives behind this server.** `/dashboard-ai` serves the build of HYDRA-UMC-DASHBOARD-AI (`build-frontend` builds and copies it when it is checked out next to this repo), and the data lake joins the relay `/api/ai/*` as a read-only service: only `GET`/`HEAD` of `/health`, `/query`, `/aggregate`, `/stats`, `/stats/range` and `/series` go through (the read token of the data lake is presented by this server), everything else is a 403 that never reaches it. The dashboard reads with the session of the person signed in to STUDIO, so the roles of this server apply.
- **The ecosystem status completes what a manifest does not say from the service registry**: 13 manifests declare no port, so those services had no live signal. When the SDK is checked out next to the other repositories (or `HYDRA_UMC_PORTS_REGISTRY` names the file), the port, health path and systemd unit come from `contracts/ports.yaml`; what the manifest declares always wins, and `HYDRA_UMC_PORTS_REGISTRY=off` turns the lookup off. 4 new tests.
- The API reference has the new section 2m, `docs/CONTRACT_V2.md` marks the five blocks as implemented, and the route list was regenerated. 56 new tests (269 in all).
- Building no longer changes the version; raising it is the explicit `bump` command (`python tools/hydra_project_tool.py bump`). The build scripts only report the version they built, and CI fails if a build script runs a bump.

### Documentation

- The statements about the optional TLS in the README now carry their status marker.
- The full design of the second contract, by blocks, is in `docs/CONTRACT_V2.md`; the API reference has the new section 2l.
- Both options are in `.env.example`, the API reference and the eight READMEs.
- The README says in the eight languages that this repository has no Dockerfile because the server is packaged by the OS repository.

### Other changes

- **A telemetry producer.** With `HYDRA_UMC_TELEMETRY_COLLECTOR_URL` set, the numbers of every robot delta (position, joints, playback state) are sent to HYDRA-UMC-TELEMETRY-COLLECTOR as one `robot_state` sample per robot, at most one per interval and merged, with the collector's bearer token and a growing sequence; the data lake, the anomaly detector, the reports and the AI dashboard finally have a producer. Off by default, never delays a command, bounded, and pauses for 30 seconds after a failure.
- **`POST /api/voice/confirm`: the voice confirmation chain is closed.** The token a spoken movement request gets is bound to the signed-in user (the session's username is the subject sent to HYDRA-UMC-VOICE-UI on `/api/voice/turn` and on the confirmation, whatever the client sends), and a `confirmed` answer is believed only if it names that user and, with `HYDRA_UMC_VOICE_UI_RESULT_KEY` set, its signature verifies; otherwise it is passed on with `verified: false` (`HYDRA_UMC_VOICE_CONFIRM_REQUIRE_SIGNATURE=1` refuses it). Nothing is executed by the route; who confirmed what is logged by request id and user.
- **Who may use the relay.** `/api/ai/*` refuses any session that is neither an administrator nor an operator (before, any signed-in session passed), whatever `HYDRA_UMC_AI_ACCESS` says; the vision node and the anomaly detector join the relay, and only an administrator may change the baseline of the anomaly detector (a `POST` other than `/detect`), because it is one baseline shared by every client.
- **Camera passwords stay out of the process list**: a camera whose address carries credentials is started with `--device-env` and the address travels in the environment of the child, not in its arguments. `HYDRA_UMC_CAMERA_CREDENTIALS_VIA_ENV=off` keeps the old form for a streamer that predates it. Tested.
- **Contract v2, block 2**: `GET /api/robot/:id` (one robot, its `revision` and `ETag`), and `If-Match` on `command`, `claim` and `release` answered with `412` and the current revision when the robot changed; the answers carry the new revision. A stop is never conditional.
- **Contract v2, block 3**: the `table` command moves the XY table in one request (`x`, `y`, `rz?`, `mode`), checked as a whole against the jog limits, claim and arming, and answered with the applied position.
- **Contract v2, block 4**: an append-only, hash-chained audit record (`data/audit.jsonl`, `GET /api/audit` for administrators, with filters, `verify` and a `jsonl` export) of claims, forced releases, safety limits, jog arming and global stops; rotated by size, copied with the settings backups, redacted, switchable from the safety limits (`audit.enabled`) and lockable with `HYDRA_UMC_AUDIT=off`.
- **Contract v2, block 5**: a `claims` WebSocket message for the clients that opened `/ws` with `?remoteApiVersion=2`, sent when a claim, a release, an arming or a stop changes; `GET /api/claims` also reports `jogArmedUntil`.
- **Safety limits kept in the server** (`GET /api/safety-limits`, `PUT /api/admin/safety-limits`, administrator): the largest relative jog and the range of an absolute jog, per robot model (defaults 100 and 1000, hard ceilings 1000 and 10000); the highest heated-bed target, per model (default 110 degrees, ceiling 300), which is lowered to the limit when settings are saved; `jog.armRequired`, the explicit arming of the jog, **off by default** (`POST /api/robot/:id/jog-arm`; it belongs to the account and the controller, expires, and is cleared by stop, global stop and release); and `claims.requireControllerId`. Saved through the transactional store, logged with the administrator, never served as a static file. Tested.
- **Controller id and claims** (first block of the second contract): `claim`, `release`, `jog-arm` and `command` accept a `controllerId` (body or `X-Controller-Id`). A claim then belongs to an account and a controller: the same account on another controller, or without the id, is refused with `409` and a `code` (`other-controller`, `controller-id-required`, `other-account`); a claim without an id works as before; `stop` and the global stop are never blocked. New `GET /api/claims` lists who controls which robot. Tested.
- `data/backups`, the journal directory, `server-config.json` and `store-meta.json` are never served as static files.

## [0.8.1.1] - A thin startup, a route authorization matrix and the SDK at a release tag

- **Pinned to SDK 0.3.6** (dependency and contract checkout in CI).
- The banner follows the animated style of the ecosystem banners, with the name, the kind and the technologies of the project.
- `src/server.ts` is now a thin startup (about 400 lines instead of about 2600): sign-in, settings, assistant, local AI, info, power, work files and static mounts moved to `src/routes/`; the live connection hub and WebSocket endpoint to `src/ws.ts`; the settings files and their write queue to `src/settingsStore.ts`; the camera process supervisor, the playback engine, the token and rate-limit helpers and the process runtime to their own modules. Behaviour is unchanged.
- The route scan test now reads every file under `src/routes/`, and the production bootstrap check waits longer for a slow machine.
- Added `tools/hydra_project_tool.py`: the same `validate`, `test`, `version`, `status` and `bump` commands in every repository. The checks run with `HYDRA_UMC_CI=1` and fail if the version changes; only `bump` changes it.
- The SDK is now fetched at a release tag instead of the main branch, so a change of the SDK cannot break this repository by itself.
- New `tools/verify_route_auth_matrix.mjs` (run by `npm test`): it reads every route the server registers (56) and, against the real running server, proves that none answers without a credential except the six public ones (login, refresh, logout, discovery and the two kiosk power buttons, which are never probed), that every route behind `requireAdmin` refuses a signed-in operator, and that the camera and information guards deny an anonymous caller when set to required. A route added later without `authenticate` fails the check instead of shipping open. Five unit tests (`tests/routeAuthScan.test.ts`) pin how the scanner reads the registrations.
- The README counters now say 178 unit tests and 25 contract scripts.

## [0.8.1.0]

- Maturity is functional: nothing here has been verified on real hardware yet.
- The READMEs say, in the eight languages, what is planned and what has only been tested against fakes, emulators or fixtures, and carry a short safety and security status note.

## [0.8.0.9]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.8.0.9] - Global stop, tickets required by default and no token in the WebSocket address

- New `POST /api/stop-all`: one call, open to every signed-in account (`admin` or `operator`), stops every robot of every controller and switches every valve and pump off, whatever any reservation says (a foreign reservation is reported as `reservedBy` and left untouched). It needs no confirmation, answers one result per robot (`stopped`, `valvesOff`, `pumpsOff`, `error`), keeps going when one robot fails, reports `persisted: false` when the settings could not be written, and broadcasts one delta per robot.
- The global stop is written to the server log with who asked, their role, the address and the counts, is counted in `hydra_robot_commands_total{command="stop-all"}`, and has its own bounded rate limit (`STOP_ALL_RATE_LIMIT_MAX`, `STOP_ALL_RATE_LIMIT_WINDOW_MS`, default 60 per minute per address) that never touches the login or the per-robot `stop`.
- The camera pictures (live streams, saved photos and recordings) now demand a short-lived ticket or a Bearer token by default. `HYDRA_UMC_CAMERA_AUTH=open` is the documented opt-out for clients that do not ask for tickets yet, and the server warns at every start while it is set.
- `/ws?token=` is now refused by default with a message that names the `hydra.bearer` subprotocol, followed by a close with code `1008`. `HYDRA_UMC_WS_QUERY_TOKEN=allow` is the documented opt-out for clients that have not moved yet, and the server warns at every start while it is set.
- `docs/REMOTE_API.md` (new endpoint, role decision, the 3D view page address as the one remaining token-in-address case), `docs/openapi.json`, `docs/PRODUCTION_BOOTSTRAP.md`, `.env.example` and the 8 READMEs describe the new defaults, the opt-outs and the new route; the unit and contract counts in the READMEs are updated.
- New tests: unit tests for every path of the global stop and for both opt-out switches, a real-server contract for the global stop (sign-in, reservations, valves and pumps, results, broadcast, audit log, metric, rate limit, empty installation) and one for the defaults and the two opt-outs.

## [0.8.0.8] - Command validation, claim checks over combined robots and camera/relay limits

- A command sent to a robot is now refused with `409` when ANY robot it will move (the target and everything combined with it) is claimed by another account; `stop` still passes.
- An unknown `command` is rejected with `400`. A jog with an invalid axis or amount, and a valve or pump with an index that is not an integer from 0 to 7, no longer succeed silently: they are listed in `warnings`. A huge valve index can no longer inflate `settings.json`.
- JSON bodies are capped at 1 MB except on `/api/settings`, `/api/upload-work` and `/api/models/submit`; submitted model meshes are limited to 200 files of 32 MB each with a mesh/texture extension allow-list.
- Camera ids are limited to 1-8 on the stream, snapshot, recording and PTZ routes and in the camera supervisor, so an id can no longer reach another local service port.
- `/api/ai/visual-servoing-api/*` now reaches port 8116, where that service listens.
- `GET /api/models/:category/:slug/download` follows the same optional-auth switch as `GET /api/models`.
- Only failed logins count towards the login rate limit, and `POST /api/refresh` has its own, larger budget (`REFRESH_RATE_LIMIT_MAX`, default 120).
- An account keeps at most its 10 newest refresh tokens.
- Camera credentials in a stream URL are masked in the server log.
- `.env.example`, `CONTRIBUTING.md` (sibling checkouts needed by `npm test`), the manifest technologies and the unit-test count in the 8 READMEs are corrected.

## [0.8.0.7] - Camera credentials, tickets and power routes hardened

- An operator no longer receives the IP-camera credentials (`ipUsername`/`ipPassword`), over REST or over the WebSocket; only an administrator reads them.
- The camera pictures and the read-only host information can demand a ticket or a token (`HYDRA_UMC_CAMERA_AUTH=required`, `HYDRA_UMC_INFO_AUTH=required`); `POST /api/camera/ticket` issues five-minute tickets.
- `GET /api/settings` carries an `ETag`; a save with a stale `If-Match` gets `409` instead of overwriting what another client wrote.
- The WebSocket accepts the token as the `hydra.bearer` subprotocol, which keeps it out of the address.
- `POST /api/system/reboot` and `/shutdown` refuse proxied, cross-origin and cross-site requests.
- A production start refuses example secrets from a deployment template, a `JWT_SECRET` under 32 characters and a bootstrap password under 12.
- New `tools/verify_hardening_contract.mjs` runs in `npm test`; `docs/REMOTE_API.md`, `docs/PRODUCTION_BOOTSTRAP.md` and the READMEs describe the new settings.

## [0.8.0.6] - Users and admin routes in their own file, and the power routes typed

- `server.ts` no longer holds `/api/users` and `/api/admin/*`: they live in `src/routes/adminRoutes.ts`, moved unchanged and registered with one small object of dependencies (the auth middlewares, the open WebSocket connections, the log file, the listen port and the stored server config). `server.ts` is 113 lines shorter; every contract script and the unit tests give the same results.
- `POST /api/system/reboot` and `POST /api/system/shutdown` now have a typed response in `docs/openapi.json`, so every route of the file has one.

## [0.8.0.5] - Remaining API schemas

- docs/openapi.json now types the ecosystem status, watch status, voice reply, settings and supervisor responses, and marks the relayed telemetry, adapter and CAN OTA version routes as passing the upstream body through unchanged.

## [0.8.0.4] - More typed API schemas

- docs/openapi.json now carries typed request and response schemas for discovery info, robot claim/release, camera capture and media, PTZ, admin clients/logs/server config, models, Bluetooth and CAN OTA flashing, in addition to the ones added earlier.

## [0.8.0.3] - Camera, robot and command route modules

- Moved the camera routes, robot claim/release and the robot command route out of server.ts into src/routes/, unchanged; the settings object is handed over as a getter so it is read at the moment of use.
- The OpenAPI generator now ends each handler at its closing line instead of the next route, so a route is no longer credited with the status codes of the code that follows it.

## [0.8.0.2] - System routes module and typed API schemas

- Moved the system metrics, supervisor and ecosystem routes out of server.ts into src/routes/systemRoutes.ts, unchanged.
- docs/openapi.json now carries typed request and response schemas for the login, refresh, logout, users, metrics, upload and service-control routes, and a shared error schema for every 4xx/5xx response.

## [0.8.0.1] - CAN-OTA relay runs on older Node releases

- The CAN-OTA relay module imports `WebSocket` from `ws` itself instead of relying on
  the global one, which older Node releases do not have (found by the CI run on
  Node 20; the same code passed locally on a newer Node).

## [0.8.0.0] - Stable route list across version bumps

- `docs/openapi.json` now carries the API contract version instead of the package
  version, so a routine version increment no longer makes the committed file stale.

## [0.7.9] - Route modules and a richer route list

- **More of `server.ts` split out:** the Bluetooth routes moved to
  `routes/bluetoothRoutes.ts` and the relays to DATALAKE, CONNECTOR-HUB and the
  CAN-OTA spi_bridge plus the connection test to `routes/upstreamRoutes.ts`.
  Code moved unchanged; each module receives what it needs (auth middlewares,
  logger, upstream settings) as arguments. The entry point is now about 3,730
  lines and the full contract suite still passes.
- **`docs/openapi.json` is richer:** every operation now lists the status
  codes its handler can return, the JSON body fields it reads and its query
  parameters, taken from the handler source. The generator also reads
  `src/routes/`.

## [0.7.8] - Smaller entry point and a machine-readable route list

- **`server.ts` split:** the IP-camera probing and PTZ code moved to
  `cameraProbe.ts`, the host metrics and supervisor readouts to
  `systemMetrics.ts`, and the ecosystem discovery and liveness probes to
  `ecosystemStatus.ts`. Code moved unchanged; the entry point drops from
  about 4,970 to about 4,050 lines and the full contract suite still passes.
- **`docs/openapi.json`:** an OpenAPI 3.1 inventory of every registered
  route with the access it demands (public, signed-in, admin). Generated by
  `npm run openapi`; `npm test` fails when it is out of date. Request and
  response bodies stay documented in `docs/REMOTE_API.md`.

## [0.7.7] - Real bug found live on the CM5: a camera's own live stream restarted every couple minutes

Camera 1 kept losing its live view in Vision Center - the raw local
capture process and this server's own proxy both verified fine on
request, but the underlying `mjpeg_server.py` child process itself was
being killed and respawned every 2-5 minutes with no operator-made
config change at all, so the browser's own reconnect kept racing a
process that was never up for long. Root cause: `cameraFingerprint()`
hashed every real ip*/rtsp*/hardwareSource field unconditionally, even
the ones `computeDeviceArg()` never actually reads for the camera's
current `sourceType` - a camera that had ever been reconfigured from ip
to usb (or back) genuinely keeps its now-irrelevant old fields around
(useful if switched back later, not itself a bug), and ANY later round
trip that so much as reformatted one of those irrelevant fields flipped
the fingerprint and triggered a real, unnecessary kill-and-respawn of a
perfectly healthy stream. `cameraFingerprint()` now only hashes the
fields the camera's own active `sourceType` branch of
`computeDeviceArg()` actually reads. 3 new regression tests.

## [0.7.6] - Real recording metadata and permanent delete for camera media

A saved recording was served as raw multipart bytes with no per-frame
timing at all - enough for a browser to display it via a plain `<img>`,
never enough for a real player to build a seek bar or a "current time /
total time" readout. And there was no way to remove a saved snapshot or
recording at all once captured - the library only ever grew.

- `POST /api/camera/:id/recording/stop` now counts the recording's own
  real frames (same `Content-Length`-based parsing `extractFirstJpegFrame`
  already used, just walked across the whole file) and writes a small
  sidecar `<filename>.json` with the real `startedAt`/`stoppedAt`/
  `durationMs`/`frameCount` - nothing estimated or assumed. `GET
  /api/camera/media` folds this into each recording's own entry when
  present; an older recording saved before this shipped simply has no
  `durationMs`/`frameCount` fields, never a fabricated value.
- New `DELETE /api/camera/media/:cameraId/:kind/:filename` - a real,
  authenticated, permanent delete (unlike the GET route, which stays
  open for `<img>`/player elements). Refuses with `409` if the file
  named is the one an active recording is still writing to.
- Contract test extended: `recording_metadata=1 delete=3` - a stopped
  recording's real frameCount/durationMs, an in-progress recording
  refusing deletion, an anonymous delete attempt refused, and a deleted
  file genuinely gone from disk (not just hidden from the list).

## [0.7.5] - Two real camera-media bugs found via live testing on the CM5

- `GET /api/camera/media/:cameraId/:kind/:filename` required authentication,
  but a plain `<img src="...">` element (what STUDIO's own
  CameraMediaView.tsx actually uses to display a photo or play back a
  recording) cannot send an `Authorization` header - every real saved
  photo/recording rendered as a broken image. No longer requires auth,
  matching `GET /api/camera/:id/stream`'s own already-established
  precedent for the exact same reason.
- `POST /api/camera/:id/recording/stop` called `reader.cancel()` and
  answered "stopped" immediately, without waiting for the recording
  loop to actually notice the cancellation and finish. If that loop was
  mid-`await` on the write stream's own "drain" event (backpressure)
  rather than `reader.read()` at that exact moment, `cancel()` had
  nothing pending to reject - the recording kept running underneath
  while the client had already been told it stopped, and a second stop
  attempt got a confusing 404. `/recording/stop` now awaits the loop's
  own real completion (bounded to 5s) before answering, so "stopped"
  only ever means "truly stopped, file closed".

## [0.7.4] - Real camera snapshot and recording capture

- Cameras had no way to actually save a photo or a recording: STUDIO's
  Vision Center only flipped local UI state (a flash animation, a red REC
  dot) with no backend call behind either, so nothing was ever written to
  disk and there was nothing to look back at afterward. New
  `POST /api/camera/:id/snapshot`, `POST /api/camera/:id/recording/start`,
  `POST /api/camera/:id/recording/stop`, `GET /api/camera/media` and
  `GET /api/camera/media/:cameraId/:kind/:filename`, all built on the
  exact same local `mjpeg_server.py` multipart stream
  `GET /api/camera/:id/stream` already proxies - no ffmpeg or other new
  system dependency. A snapshot parses one real JPEG frame out of that
  stream's own `Content-Length`-delimited parts and saves it as a plain
  `.jpg`; a recording tees the exact same raw multipart bytes to a
  `.mjpeg` file while active, so a saved recording is served back with
  the identical `multipart/x-mixed-replace` framing a live camera uses -
  the same `<img>` element renders either one unmodified. Saved under
  `data/camera-media/<camera id>/{snapshots,recordings}/`, filenames
  reused directly (traversal-sanitized via the existing
  `resolveWithinDataDir()`). New `tools/verify_camera_media_contract.mjs`
  (a fake local camera stream, real HTTP calls, no mocking of Server
  itself) covers auth gating, a camera with no running stream (503, not
  a fabricated capture), byte-exact snapshot capture, path-traversal
  filenames (404), the full start/stop recording lifecycle, a rejected
  double-start (409) and double-stop (404), and the media listing.

## [0.7.3] - Bluetooth pairing logic extracted into its own module; combined-robot command concurrency now covered by a real test

Bluetooth pairing (`/api/system/bluetooth/*`) is the first route group split out of `server.ts` into its own module
(`src/bluetooth.ts`) since `kinematics.ts`/`users.ts` - the `bluetoothctl` subprocess calls and output parsing now
live there, imported into `server.ts`'s own route registrations exactly like `calculateJoints()` already is. Purely
a code-organization change: the routes, their auth middleware and their responses are unchanged, confirmed by
`tools/verify_bluetooth_contract.mjs` still passing unmodified.

Added `tools/verify_robot_command_race_contract.mjs`, a new real-server contract test that fires concurrent HTTP
requests at `POST /api/robot/:id/command` and `POST /api/robot/:id/claim` for a combined robot group - proving a
combined sibling never ends up on a different setpoint than the robot that commanded it, an unrelated robot's state
never leaks across a concurrent command on another robot, and a concurrent claim race always resolves to exactly one
winner. No production code change was needed for this: `server.ts`'s own settings mutation already runs fully
synchronously between reading a robot's state and queuing its write, so Node's single-threaded event loop cannot
interleave two of these handlers - this test makes that invariant explicit and regression-proofed instead of only a
comment.

## [0.7.2] - JWT verification now pins its own real signing algorithm explicitly

Both `jwt.verify()` call sites (HTTP `authenticate()` and the WebSocket auth handshake) now pass
`algorithms: ["HS256"]` explicitly, matching `jwt.sign()`'s own real algorithm (a plain string secret
defaults to HS256). `jsonwebtoken` 9.x already refuses `alg: none` unless a caller opts into it, so this
was never the classic unsigned-token bypass, but pinning it closes the real, separate algorithm-confusion
class instead of relying on the library's own current default alone. New regression test in
`tools/verify_auth_negative.mjs` crafts a real hand-built `alg: none` token against the running server and
proves it is refused.

## [0.7.1] - Real, admin-gated Bluetooth pairing (Config > Bluetooth in STUDIO)

New `GET /api/system/bluetooth/status`, `POST /api/system/bluetooth/power`, `POST /api/system/bluetooth/scan`,
`POST /api/system/bluetooth/pair` and `POST /api/system/bluetooth/remove` - every call shells out to the real
`bluetoothctl` CLI against this device's own BlueZ daemon (no polkit rule needed: this device's own stock
`/usr/share/dbus-1/system.d/bluetooth.conf` already lets any local user talk to `org.bluez`). Lets an admin pair
a Bluetooth gamepad directly to this device's own adapter from STUDIO, without SSH. `POST /pair` also names a
real, specific fix (`ClassicBondedOnly=false` in `/etc/bluetooth/input.conf`, now set by HYDRA-UMC-OS's own
`first_boot.sh`) when a device pairs but never bonds - the exact real symptom found pairing a physical Xbox
controller against this ecosystem's own CM5, where BlueZ's own default silently refused the HID connection
forever with no obvious cause otherwise.

## [0.7.0] - The voice assistant's "status" reply is real data, not a canned placeholder

Live report: asking the voice assistant "status" answered "Status
request understood. Live telemetry will be supplied by the authenticated
HYDRA-UMC gateway" - a real, honest, but never-fulfilled promise.
HYDRA-UMC-VOICE-UI's own `gateway.py` is a deliberately pure, stateless
intent classifier (its own docstring: "an authenticated Server ...
integration can replace the response policy without changing the wire
shape") - nothing had ever filled that promise in.

`POST /api/voice/turn` now does, right at this relay step: when the
relayed reply's own recognized intent is `status`, its `text` is replaced
with a real controller/robot count (the same real source
`GET /api/hydra-info` already reads from `lastKnownSettings.controllers`)
and real CPU/memory/uptime (the same `getSystemMetrics()`
`GET /api/watch/system-status` already calls) - never a second, competing
computation of either. "status of robot N" is answered honestly from this
Server's own real registered-robot list (registered or not) - there is no
real per-robot LIVE telemetry available at this relay step yet, so it
never fabricates an online/offline claim for one.

`tools/verify_voice_relay_contract.mjs` (real end-to-end: a real Python
VOICE-UI gateway + a real Server, both on temp ports) extended with real
assertions that the enriched text actually contains real data and no
longer contains the old placeholder's own "will be supplied" wording, and
that an unregistered robot ID is reported honestly. Verified: full
`npm test` (104 unit tests + every real contract script) passes.

## [0.6.9] - Robot command setpoint warnings + claim transition history

- **`POST /api/robot/:id/command`'s `"speed"` case now records a
  rejected setpoint instead of silently discarding it.** A `speed`/
  `acceleration` value outside the allowed 10-500 range was simply
  dropped, with `success: true` returned regardless - the caller had no
  way to tell "your setpoint was applied" from "your setpoint was
  clipped and nothing changed". The response now includes a `warnings`
  array (one entry per affected robot whose value was rejected, with
  `field`/`requested`/a human-readable `message`) whenever this happens;
  omitted entirely on a normal request, so an existing caller that only
  reads `success` sees the exact same response shape as before. 4 new
  assertions in `tools/verify_robot_command_contract.mjs`.

- **A real transition history for robot claims (`reservationHistory`).**
  `robot.reservation` only ever held the current claim, overwritten by
  every claim/release with no trace of who changed it, when, or why. A
  new, bounded (last 20) `reservationHistory` array on the same robot
  object now records every real transition -
  `"claimed"`/`"renewed"`/`"force-claimed"`/`"released"`/
  `"force-released"`/`"expired"` - each with `at`/`byUserId`/
  `byUsername` and an optional caller-supplied `reason` (`claim`/
  `release` both accept one now, trimmed and capped at 200 characters).
  A lapsed claim is recorded as `"expired"` the moment it's superseded
  by a fresh claim or lazily released, instead of silently vanishing.
  Returned directly by `claim`/`release` and broadcast in their own
  delta, so no separate endpoint or polling is needed. 6 new assertions
  in `tools/verify_robot_ownership_contract.mjs`, including the bounded
  cap under 25 real claim/release cycles. `docs/REMOTE_API.md` updated.

## [0.6.8] - Real sustained WebSocket reconnect coverage

- New `tools/verify_ws_sustained_reconnect_contract.mjs`: 50 real
  connect/disconnect cycles against one running server, scraping the
  real `GET /metrics` `hydra_ws_clients_connected` gauge after every
  single cycle to prove it returns to exactly 0 each time - every other
  WS-related check in this repo only ever opens one or two real
  connections. Proves the 4 real `wsClients.delete()` call sites in
  `server.ts` never leak a stale reference across a long session, and
  that the server itself stays healthy after the sustained churn.
  Confirmed to fail against a deliberately disabled `close` handler,
  restored before committing.
- 104 unit tests + 19 end-to-end contract scripts (up from 18) all pass
  via `npm run test`; `tsc --noEmit` clean. Synced across all 7 README
  languages.

## [0.6.7] - Per-interface network traffic on the Supervisor endpoint

- `GET /api/system/supervisor` now reports real cumulative RX/TX byte
  counters per network interface (Wi-Fi, Ethernet), read straight from the
  standard Linux sysfs statistics files - backend for STUDIO/SUITE's own
  Supervisor panel data-flow graphs. Bluetooth has no equivalent sysfs
  byte-counter and stays honestly `null` rather than an approximated
  number. A host without a given interface (no onboard Wi-Fi, a non-Linux
  dev machine) reports `null` for it, never a fabricated zero.
- Add `tools/verify_supervisor_contract.mjs`: this endpoint had no test
  coverage at all before this change.

## [0.6.6] - Static-file bypass, unauthenticated settings read, and points path traversal

- Close a real bypass of the private-file block in front of `express.static(dataPath)`:
  a naive exact-string check against `req.path` did not match how `send`/
  `express.static` themselves resolve a URL to a real file on disk, so a
  percent-encoded character, a doubled leading slash, a case difference, or a
  literal/encoded `.` segment could all still reach `settings.json`/`users.json`/etc.
  Decode and normalize the path the same way `send` does, then compare only the
  real, lowercased basename and top-level segment.
- Require authentication on `GET /api/settings`, which previously had none at
  all and returned the full settings payload (every controller/robot/camera
  configuration) to any anonymous caller.
- Reject a controller/robot id of exactly `.` or `..` in `safeIdSegment()`: `.`
  is a deliberately allowed character in real ids, so that one specific value
  survived the existing allowlist cleaning unchanged and let `getPointsPath()`
  resolve outside its own `points/` subdirectory, choosing which file directly
  under `data/` a points write would land on.
- Add live regression coverage for all three: `tools/verify_auth_negative.mjs`
  now exercises six real static-file bypass variants plus a legitimate file to
  prove the fix is targeted, and an anonymous `GET /api/settings` check; unit
  tests cover the `.`/`..` id case directly.
- Correct two stale doc claims: the admin-ui README's own project/language
  counts, and `docs/REMOTE_API.md`'s description of the optional same-origin
  STUDIO-serving mode this server actually implements.

## [0.6.5]

- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.6.4] - Table model contracts: rack/heated-bed/vacuum-table settings

- Add configurable rack width/depth (1 mm steps), capacity-driven STL guides
  and independent color metadata. Preserve pickup poses and the other rack.
- Verify rack geometry/settings roundtrips with an isolated server; document
  the shared contract without adding physical commands.

- Test and document the heatedBed modelId/size roundtrip for four 5 mm STL
  presets plus a custom footprint, preserving heater state and another robot.

- Verify customSize/modelId/width/length persistence through the existing settings
  API using an isolated server, including isolation from another robot.
- Document the shared STUDIO/SUITE footprint contract; no new endpoint, physical
  command or parametric STL generation is introduced.

## [0.6.3] - Refresh bundled STUDIO frontend (vacuum-table models + C08 refresh-token client)

No server-side code changed - `build-frontend.sh` re-run to pull
HYDRA-UMC-STUDIO's own `public/` copy of its frontend up to date with:
STUDIO 0.6.0 (six real selectable vacuum-table STL models replacing the
primitive parametric box) and STUDIO 0.5.9 (the client half of C08 -
`store.tsx` now tries this server's own `POST /api/refresh` before
forcing a logout on a WebSocket 1008 close, see 0.6.2). admin-ui rebuilt
in the same pass.

## [0.6.2] - Real refresh-token support: silent recovery from a WS 1008 close

Every client (STUDIO, Android, iOS, DSI) forced a full manual re-login the
instant its access token expired (WS closes 1008, no other reason
exists) - even though the account itself was never actually revoked, a
30-day-old dashboard tab left open just lost whatever view/robot
selection it had. `POST /api/login` now also returns a real, opaque,
long-lived `refreshToken` (`src/refresh_tokens.ts`, 90 days by default);
new `POST /api/refresh` exchanges a still-valid one for a fresh access
token with no password involved, rotating it on every use; new
`POST /api/logout` revokes one explicitly server-side instead of only
discarding it client-side. Fails closed exactly where a real re-login is
still the correct behavior: a refresh token records the account's
`tokenVersion`/`id` at issuance, so a password/role change or an account
delete-and-recreate revokes it immediately, the same real-time guarantee
an already-issued access token already gets. STUDIO's own WS-reconnect
effect now tries a silent refresh before falling back to its existing
forced logout on any 1008 close. 102 unit tests (13 new) +
`tools/verify_refresh_token_contract.mjs` (new, real login->refresh->
logout lifecycle against an actual running server) in SERVER; 154 tests
in STUDIO.

## [0.6.1] - Real error-path coverage for POST /api/voice/turn

`verify_voice_relay_contract.mjs` already proved the real happy path
(200 for status/motion intents against the real Python Voice UI gateway,
401 anonymous, per-client remote-access gating) but none of this route's
own real error branches - what a flaky/misconfigured/rejecting upstream
actually hits in production. New `tools/verify_voice_turn_error_paths_
contract.mjs` proves all of them against a small controllable local HTTP
stub standing in for Voice UI: `validateVoiceTurnPayload`'s 5 real
rejection branches (400), Voice UI unconfigured (503), a rejecting
upstream (502), a 200 reply that fails `isAssistantReplyForRequest`'s
own contract (502, never relayed as-is), a real timeout at the
configured bound (503), and a real connection refusal (503) - the two
distinct halves of the route's own `timedOut ? ... : "unavailable"`
catch-block split, both exercised for real rather than assumed.

## [0.6.0] - Real bug: jogging a combined robot's real XY table also moved its table-less sibling

Reported live on STUDIO/CM5: a robot with a real XY table (`hasXYTable:
true`), combined with a sibling that has none, would visually relocate
that WHOLE sibling robot whenever the table-having robot's table was
jogged, reset, or played through a Work with recorded `tx`/`ty`.

Root cause: the server's `target: "xytable"` jog/reset branches, and the
playback tick's own table handling, all checked "does a `xyTable` config
object exist" (`robot.xyTable`) instead of "does THIS robot actually
have a real table" (`robot.hasXYTable`). Turning a table off in the UI
only ever flips that boolean - the config object is never cleared - so
a table-less combined sibling still had a truthy `robot.xyTable` and
absorbed the other robot's table jog. Compounding it: `pos.tx`/`pos.ty`
doubles as a table-less combined robot's own general world-placement in
the 3D scene (`VirtualKinematics.tsx`), so stomping it directly moved
that robot's entire rendered model, not just some inert config field.

Fixed: every place that applies `tx`/`ty`/table config now also requires
the specific robot's own `hasXYTable` - the jog `"xytable"` target, the
reset `"xytable"` target, and the playback tick's own per-point table
handling. New regression coverage in
`tools/verify_robot_command_contract.mjs` (`xytable-ownership`): a
table-less combined sibling with a deliberately stale `xyTable` config
and a distinctive `pos.tx`/`ty` - confirmed to reproduce the real bug
before the fix (temporarily reverted the guard to prove it), confirmed
fixed after.

## [0.5.9] - Real command ownership for POST /api/robot/:id/command

`POST /api/robot/:id/command` only ever checked "is this token valid" -
any authenticated admin/operator account could command any robot at any
time, with no reservation, no generation, no exclusivity of any kind
between two different real accounts both trying to drive the same robot.

Added:

- `robot.reservation: { ownerId, ownerUsername, claimedAt, expiresAt } | null` -
  a real, TTL-bounded claim embedded directly on the robot object, so it
  round-trips through the exact same persistence
  (`queueSettingsWrite`)/broadcast (`broadcastRobotDelta`) machinery
  every other robot field already uses.
- `POST /api/robot/:id/claim` (`ttlMs` default 5 min, capped at 30;
  `force: true`, admin-only, to override someone else's active claim) and
  `POST /api/robot/:id/release` (idempotent - releasing an
  unclaimed/expired robot succeeds, never errors; only the holder or an
  admin may release someone else's).
- `POST /api/robot/:id/command` now rejects `409` when a *different*
  account holds an active claim, for every command except `"stop"` -
  deliberately never blockable, the one real safety exception. A claim
  that simply expires is never treated as still-locked.
- New `tools/verify_robot_ownership_contract.mjs` - the real, two-
  distinct-account regression this whole feature exists to close (an
  admin account created live via `POST /api/users`, not a second token
  for the same account): unclaimed access, claim, a blocked cross-
  account command, the `stop` exception, the claim holder's own commands
  still working, a contested claim, a non-holder's refused release, an
  admin's forced override, release, idempotent release, and a real,
  waited-out TTL expiry. `docs/REMOTE_API.md` documents the new contract.

## [0.5.8] - First real persisted Work exercising the XY table

Every Work ever actually saved under `data/WORKS/<robot>/` used only
`{x,y,z,a,b,c}` - the XY table's own `tx`/`ty` axes were exercised
exclusively by STUDIO's in-memory Examples, never by anything a real
user could load, save and replay.

- `data/WORKS/RobotA1/inspeccion_con_mesa_xy.json` - a new, real Work
  moving the arm and the XY table together through 3 distinct table
  positions (inspection pattern), ending back at the table's own rest
  position. Added to `index.json` so it appears in the real file picker.
- `tools/verify_persisted_work_xy_table.mjs` - loads this exact file (not
  a hand-typed copy of it) into a real, isolated server instance and
  proves `play` drives `xyTable.pos` through every one of its real
  `tx`/`ty` values in order, ending at the file's own last position - the
  same server-authoritative playback engine `verify_server_playback_
  contract.mjs` already proves for a synthetic fixture, now proven
  against a file a real user can actually load and run.

## [0.5.7] - Refreshed bundled STUDIO frontend (public/)

`build-frontend.sh` re-run to pull in HYDRA-UMC-STUDIO's own LumenPnP/
JuanenPnP fix (nozzle no longer rotates its own Z-carriage housing - see
that repo's own CHANGELOG) into this server's bundled `public/` copy of
its frontend, plus a routine admin-ui rebuild. No server-side (`src/`)
code changed.

## [0.5.6] - Real consumer of HYDRA-UMC-CONNECTOR-HUB's own adapter catalog

- **`GET /api/adapters`, `GET /api/adapters/:adapterId`** (new) - a real,
  authenticated read-only proxy to HYDRA-UMC-CONNECTOR-HUB's own
  `serve-catalog` (Python, GET-only `http.server`). This is Server's first
  real consumer of the adapter catalog - previously only that project's own
  CLI/fixtures existed, and its own README said so plainly ("No real client
  integration yet. Server/Studio/Suite/Updater do not yet poll
  `serve-catalog` or call `gate` themselves."). `/api/adapters` returns the
  real catalog summary (`adapterId`/`protocol`/`targetKinds`/
  `ownerProject`/`sdkCompatibility`/`idempotency`/`capabilities`/
  `sourcePath` per adapter, plus `invalidFiles`); `/api/adapters/:adapterId`
  returns that one adapter's real full manifest, or CONNECTOR-HUB's own
  real `404` passed straight through for an unknown id. A malformed
  `adapterId` is rejected with Server's own `400` before it ever becomes a
  path segment of the outbound request, mirroring the charset
  CONNECTOR-HUB's own `schema.py` already requires. `503` with
  `available: false` when `HYDRA_UMC_CONNECTOR_HUB_URL` is unset - same
  optional-microservice-proxy shape as the Voice UI/Datalake/SPI-bridge
  proxies already in this file. New `tools/verify_connector_hub_relay_contract.mjs`
  proves it end-to-end against CONNECTOR-HUB's own real `serve-catalog`
  process and its own real `fixtures/` manifests (never a mock): the
  unconfigured 503, the anonymous 401, a real 10-adapter catalog fetch, a
  real single-adapter full-manifest fetch, the real upstream 404
  passthrough, and the pre-upstream 400 on a malformed id. CI now checks
  out HYDRA-UMC-CONNECTOR-HUB alongside HYDRA-UMC-SDK/HYDRA-UMC-VOICE-UI to
  run this contract for real. `npm test`: 89 unit tests + 13 real contract
  scripts, all passing.

## [0.5.5] - Real proxy to this cell's own local AI services

- **`GET/POST/etc /api/ai/:service/*`** (new) - a real, authenticated
  passthrough proxy to `hydra-umc-cognitive-node`/`hydra-umc-detection-hef`/
  `hydra-umc-visual-servoing-api`/`hydra-umc-vla-engine`, each already a
  real systemd service bound to `127.0.0.1` only (same loopback-only
  posture DATALAKE/ANOMALY-DETECTOR already use), and each one's own real
  HTTP/JSON API was already unreachable from anywhere off this host - even
  from a legitimate development machine on the same LAN, or over this
  server's own existing remote-access path. Real passthrough, not a
  reimplementation: method, path, query string, JSON body and status code
  all forward unchanged, so this route can never drift from what each
  service's own `api.py` actually does. Every one of these still honestly
  reports "not ready" for real inference until a Hailo module and a loaded
  model exist - this only carries that answer through the network, it
  doesn't change it. New `tools/verify_local_ai_proxy_contract.mjs`
  proves: an unknown service name is a clean 404, a real running local
  service's own request/response round-trips unchanged in both directions
  (GET and POST), a real known service that simply isn't running is a
  clean 503 (never a crash/hang), and the whole route is authenticated
  like every other real proxy route here, never reachable anonymously.
  `npm test`: 89 unit tests + 12 real contract scripts, all passing.

## [0.5.4] - Real regressions found in a second review pass

A second review pass reproduced 2 real issues in the same
account/authentication surface v0.5.3 above already hardened once (each
against the real file store or a real in-process race, no mocked
filesystem). Both fixed here, each with new regression tests:

- `createUser()`/`updateUser()`/`deleteUser()` each do
  a real read-modify-write cycle (`loadUsers()` -> mutate -> `saveUsers()`)
  with a real `await` (`hashPassword()`) in the middle - two concurrent
  calls (two admins creating accounts at once, or a create racing an
  unrelated update) each read the SAME pre-mutation file, so whichever
  call's `saveUsers()` landed last silently discarded the other's real
  account or change. Reproduced against the real file store: two
  concurrent `createUser()` calls, only one account survives. Fixed with
  a single, in-process promise-chained mutex (`withUsersLock()`)
  serializing every real mutation - this process is the only writer of
  `data/users.json`, so this alone is sufficient.
- Deleting an account and recreating the same username
  reset `tokenVersion` back to its starting value on the brand-new
  account - v0.5.3's own session-revocation fix compares `tokenVersion` per
  USERNAME, so an old, not-yet-expired JWT for the DELETED account could
  still authenticate as the unrelated NEW one (possibly with a different
  role). Fixed with a real, random, never-reused account `id`
  (`crypto.randomUUID()`, `StoredUser.id`/`effectiveId()`) embedded in
  every freshly issued token and re-checked everywhere `tokenVersion`
  already was (`authenticate()`, WS connect, WS heartbeat) - an old
  token's `id` claim can never match a same-named account created after
  it. **Deploying this fix invalidates every already-issued token**
  (none of them carry a real `id` claim yet) - every client must log in
  again once, the same one-time cost the tokenVersion
  introduction above already had.
- 8 new regression tests, plus every existing real end-to-end contract
  script (`tools/verify_*.mjs`) re-run and still passing unchanged.

## [0.5.3] - Real session revocation, users.json corruption handling, and non-blocking login

Found on code review (three separate
findings against `src/users.ts`/`src/server.ts`, all fixed together since
they touch the same account/authentication surface):

- **Session revocation.** A JWT's `{username, role}` claims used
  to be trusted for the token's entire signed lifetime, with no way to
  revoke one early: deleting a user, demoting an admin to operator, or
  changing a password never invalidated tokens/WebSocket sessions already
  issued for that account, and a WebSocket connection only checked identity
  once, at connect time. `StoredUser` now carries a `tokenVersion`, bumped
  on every real account mutation and embedded in every freshly issued JWT;
  the HTTP `authenticate()` middleware, the WebSocket connect handler, and
  the WebSocket heartbeat tick now all re-look-up the account and compare
  its *current* `tokenVersion` against the token's claimed one on every
  request/tick, not just at login - a mismatch (or a deleted account) is
  now rejected as `SESSION_REVOKED` regardless of the JWT's own signature
  or expiry. **This deploy invalidates every session issued before it**,
  since pre-fix tokens carry no `tokenVersion` claim at all and can never
  match a real current value - a one-time, intentional consequence of
  shipping real revocation where none existed before, not a bug. Everyone
  simply logs in again.
- **`users.json` corruption/atomicity.** A corrupted or
  truncated `users.json` (e.g. from a crash mid-write) used to be
  indistinguishable from "no users file yet", so a caller could silently
  reseed a brand-new admin account over real, still-recoverable accounts.
  Loading now throws a distinct `UsersFileError` for anything other than a
  genuinely missing file (bad JSON, or JSON that isn't an array), and
  saving is now atomic (write to a temp file in the same directory, then
  rename) so a crash mid-write can never leave a half-written file behind
  in the first place.
- **Non-blocking password hashing.** Login used Node's
  synchronous `crypto.scryptSync`, which blocks the entire single-threaded
  event loop for its full ~100ms cost on every attempt - stalling every
  other concurrent HTTP/WebSocket connection this server holds, including
  real-time robot command/telemetry traffic, for that same window. Password
  hashing/verification now use the async `crypto.scrypt` (Node's own
  threadpool-offloaded form), with the relevant routes and account
  functions converted to `async`/awaited accordingly.
- Async scrypt alone still let an unbounded number of concurrent password
  operations (a login burst, or an admin bulk-creating users) pile up more
  CPU/memory-heavy scrypt work than the host can actually sustain at once,
  which the finding's own closure criterion explicitly called out.
  Password hashing/verification are now bounded to 4 concurrent operations
  (Node's own default threadpool size) plus a 20-deep wait queue; once
  both are full, the call fails closed with a new `ScryptOverloadError`
  instead of queueing indefinitely - `asyncHandler()` recognizes it and
  responds `503` (a real, bounded overload signal) rather than a generic
  `500`, on every async route, login included.
- 32 new direct unit tests (`tests/users.test.ts`, node's own `node:test`
  runner) cover all four: tokenVersion bumping on password/role/rename
  changes, `UsersFileError` on corrupt/non-array `users.json`, atomic saves
  leaving no orphaned temp file, async login still succeeding/failing
  correctly for both current- and legacy-cost accounts, and a 30-call burst
  deterministically overflowing the 24 real concurrency+queue slots with
  exactly 6 `ScryptOverloadError` rejections.

## [0.5.2] - Extracted pure helpers into src/serverPolicy.ts, with real direct unit tests

- Found on code review: this repository
  had zero direct unit tests - only the real, valuable but end-to-end
  `tools/verify_*_contract.mjs` scripts, each spinning up a whole real
  server process. `server.ts` itself has several genuinely pure functions
  (no `req`/`res`, no outer mutable state, no I/O); some already sat at
  module scope (`remoteAccessAllowed`, `realSettings`, `computeDeviceArg`,
  `hi3510Action`), others were declared INSIDE `startServer()`'s own
  closure despite never touching anything from it (`cameraFingerprint`,
  `safeIdSegment`, `slugify`, `cameraStreamPort`) - a real example of the
  exact "pure function trapped in a closure" pattern flagged on code review.
- **`src/serverPolicy.ts`** (new) - all 8 functions above moved here
  unchanged (same logic, same comments, same behavior), each `export`ed
  and independently importable. `server.ts` now imports them back and
  calls them exactly as before - net effect on `server.ts` itself: -127
  lines, same runtime behavior, verified against all 11 existing real
  `verify_*_contract.mjs` end-to-end scripts (all still pass unmodified).
- **`tests/serverPolicy.test.ts`** (new, 40 tests) and
  **`tests/kinematics.test.ts`** (new, 6 tests, covering the already-
  extracted-but-never-tested `calculateJoints()`) - real, direct unit
  tests using Node's own built-in `node:test` + `node:assert`, run via
  `tsx --test` (`tsx` was already a devDependency for `npm run dev` -
  zero new dependency added). Covers real, previously-undocumented-by-
  test edge cases: the `dsi` remote-access gap this file's own history
  already fixed once, `watch` being gated independently of `android` even
  though one physical phone carries both, the real hardware-verified
  `rtsp://user:pass@host:port/path` camera URL recipe, the legacy
  `USB_DEV_N` seed-placeholder format, a real path-traversal attempt
  through `safeIdSegment`, and `calculateJoints`' own degenerate-distance
  guards (verified against a hand-checkable 3-4-5 right triangle for its
  `j1` output).
- **`package.json`** - new `test:unit` script (`tsx --test
  tests/serverPolicy.test.ts tests/kinematics.test.ts`), prepended to the
  existing `test` script so `npm test` now runs both the new direct unit
  tests and every existing real integration contract check.
- Still out of scope, on purpose: `getPointsPath`/`resolveWithinDataDir`
  are also pure aside from a closure-captured `dataPath` constant, but
  extracting them would mean changing their call signature at every call
  site for a smaller marginal benefit - left for a later pass. The
  broader "add real test coverage everywhere" effort (STUDIO, EDITOR-URDF)
  is separate, larger work tracked elsewhere.

## [0.5.1]

- **Fixed a real remote-access gate gap, found on code review: HYDRA-UMC-DSI's own client already sent
  `X-Hydra-Client: dsi`, but `remoteAccessAllowed()` never recognized
  "dsi" as one of the gated client types.** A DSI request fell into the
  same bucket as an ungated plain browser tab (any unrecognized header
  value passes unconditionally, by design, since that's also how this
  same server's own browser UI reaches these routes) and always passed
  regardless of the Remote Access toggle state - the toggle itself
  didn't even exist yet (added to STUDIO's Config.tsx/store.tsx in the
  same pass, see that repo's own changelog). `remoteAccessAllowed()` now
  recognizes 5 client types (`suite`/`android`/`ios`/`watch`/`dsi`)
  instead of 4. `npm run typecheck`: clean. `npm test`: 11/11 contract
  suites pass.
- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.5.0]

- **Fixed a real PTZ auth/protocol bug, found live against this
  ecosystem's own real PTZ-capable cameras (.210/.211).** `POST
  /api/camera/:id/ptz` always spoke the PSIA XML API (HTTP Digest) -
  live testing against the real hardware showed that never actually
  worked: those cameras answer with `Server: Hipcam` and a genuine
  Hi3510 chipset web UI, and their own `WWW-Authenticate: Basic` on the
  PSIA path turned out to be their generic login wall guarding an
  unimplemented route, not a real PSIA challenge - every PTZ command
  against real hardware surfaced as a permanent 401/auth-failure to
  STUDIO/SUITE regardless of how correct the configured password was.
  `sendPtzCommand()` now tries the real, live-verified Hi3510 CGI
  convention first (`/cgi-bin/hi3510/ptzctrl.cgi`, HTTP Basic, confirmed
  live with a real `[Succeed]set ok.` response and real camera movement),
  falling back to the original PSIA attempt for a camera that genuinely
  doesn't answer the Hi3510 path.
- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.4.9]

- **Fixed a real wrong-error-message bug in the admin UI's login screen,
  found on code review.** `admin-ui/src/api.ts`'s own
  `apiFetch()` intercepted every real `401` response globally and
  rewrote it to `"Session expired - please log in again."` - correct for
  an already-authenticated call whose token stopped being valid, but
  `LoginScreen.tsx`'s own `POST /api/login` goes through that exact same
  helper, so a genuinely wrong username/password (the server's real,
  honest `401 {"error": "Invalid credentials"}`) showed the nonsensical
  "session expired" message instead on someone's very first sign-in
  attempt, before any session ever existed to expire. `apiFetch()` now
  only applies the forced-logout rewrite to every endpoint EXCEPT
  `/api/login` itself, letting the login screen's own request fall
  through to the generic error handling that already correctly surfaces
  the server's real message.

## [0.4.8]

- **Real self-heal for a hung camera process, not just a status label.**
  Found via a detailed live user report on camera 4 (2 real streams,
  main/sub): switching between them worked for a while, then silently
  stopped, needing a manual OS process kill to recover. Root cause: the
  health check in `startCameraProcess()` already detected an
  unresponsive `stream serve` child (10 consecutive missed TCP probes)
  and flipped its own status to `"error"`, but never actually DID
  anything about it - the process object was left alive and tracked, so
  `reconcileCameraProcesses()`'s own "already has a proc, skip"
  short-circuit treated it as fine forever after, until an unrelated
  settings save happened to come through. Now a confirmed-unresponsive
  process is killed (SIGTERM, SIGKILL fallback) and a real respawn of
  the exact same config is scheduled automatically, with an escalating
  backoff (5s/10s/20s, capped at 30s) so a genuinely broken camera
  (wrong credentials, unreachable host) doesn't hammer the OS or the
  real camera hardware. The same respawn-with-backoff now also covers a
  `stream serve` process that exits on its own (a real crash) - that
  path used to have the identical "stuck in error forever" gap.
  `CameraProcessState` gained `restartAttempts`, reset to 0 the moment a
  process actually reports healthy again.
- **New real PTZ (pan/tilt/zoom) control - IP cameras only.** New
  `POST /api/camera/:id/ptz`, taking the camera's own real
  ipHost/ipUsername/ipPassword directly from the request body (same
  convention as `discover-rtsp-path`) plus pan/tilt/zoom (-100..100,
  0/0/0 = stop). Relays a real PSIA `continuous` move command over the
  camera's own HTTP API (port 80 by default), using a new generic HTTP
  Digest-auth client (`psiaRequest()`) - verified end to end against the
  real `.203` camera: the digest handshake itself was confirmed working
  by testing it against the already-known-good
  `GET /PSIA/Security/AAA/users` endpoint, and the real PTZ command
  itself came back with an honest `404` (this ecosystem's own real
  cameras are fixed dual-lens units, no motorized PTZ hardware) - never
  pretended to move a camera that can't.
- Build version synchronized with `hydra-umc.project.json` and the repository-native version source.

## [0.4.7]

- **Removed a real false-positive from `RTSP_PATH_CANDIDATES`.** Caught
  live via real user feedback on the multi-stream picker this list
  feeds: a bare `/` was answering a real 200 OK on a real Hipcam unit
  here ALONGSIDE the genuine `/11`/`/12` pair - not a third real
  distinct stream, just a generic default/catch-all most RTSP servers
  answer on the root path, aliasing whatever `/11` already serves. A
  camera with 2 real streams was showing 3 selectable options in
  STUDIO/SUITE's own picker, two of which displayed the identical
  feed. Verified live against the same real camera: discovery now
  correctly returns exactly `["/11", "/12"]`, not
  `["/11", "/12", "/"]`.

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
  rate-limit repeated authenticated attempts),
  starting with `/11`/`/12`
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

- `npm run typecheck` clean; full `npm test` - 8/8 contract scripts
  passing, including both new ones above.

## [0.2.3] - Real per-service liveness probing on GET /api/ecosystem/status

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
(most of the other points raised for this project turned out to already
be fixed - CORS, JWT_SECRET default, path traversal, the WebSocket
listener leak, and the kinematics NaN singularity were all already
handled; the public code and tests record the resulting behavior).

- **Real log rotation.** `industrialLog()` used to append to `server.log`
  forever with nothing that ever trimmed it - a real gap:
  an industrial cell logs a line on every robot command, so an
  unattended CM5 would eventually fill its own eMMC. Single-file
  rotation at 10MB (current -> `server.log.1`, current truncated).
  Verified live: grew a real 10MB log file, started the server, confirmed
  it rotated to 347 bytes + a `server.log.1` with the old content.
- **Bounded `jog`/`speed` atomic command values.** Both only checked
  `typeof === "number"` before this fix - which NaN/Infinity/an absurd
  value like `1e9` all pass. `jog`'s `amount` is now also
  required to be finite and `|amount| <= 1000` (10x headroom over
  STUDIO's own largest `JOG_STEP_OPTIONS` entry); `speed`/`acceleration`
  are bounded to STUDIO's own slider range (10-500).
- **scrypt cost raised to the OWASP Password Storage Cheat Sheet
  baseline** (N=2^17/r=8/p=1, up from Node's un-configured default of
  N=2^14) - login is infrequent (never on a jog/telemetry hot path), so
  the extra ~350ms/~128MB per attempt is a reasonable one-time-per-session
  cost. Existing accounts hashed under the old cost still log
  in via an automatic fallback check - no forced password reset.
- **Graceful shutdown on SIGTERM/SIGINT.** Nothing handled either signal
  before this fix - a normal `systemctl stop`/Ctrl-C just killed the
  process mid-flight, leaving the mDNS record to expire only via its own
  TTL instead of unpublishing immediately. Verified in-process
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

A later review pass, still within this same version (done via `npm run dev`,
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

## Earlier history

### Documentation - Real HTTP API reference gaps closed

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
