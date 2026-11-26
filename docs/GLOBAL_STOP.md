# The global stop, end to end

One call stops every robot of the installation. This page says what the server does, what it announces to the rest of the ecosystem and
what each other part has to do to honour it. The server cannot make a machine safe by itself: the controller and the actuator keep the
last word, and a part that has not adopted this contract is exactly as safe as it was before.

## Layers

| Layer | What happens | State |
|---|---|---|
| Clients | One touch on the stop button calls `POST /api/stop-all` (retried with a short timeout; a stop that was not confirmed is shown as such). | Done in the control apps. |
| Server | `POST /api/stop-all` stops every robot of every controller, whoever reserved it, and switches every valve and pump off. In memory first, then the stop is written to disk, then the settings, then the WebSocket deltas. It is never rate limited. | Done. |
| Server, after a restart | The written stop is read back at start-up: the server comes back stopped (and tells the apps so) until an administrator releases it. | Done. |
| Server, commands | With the option `safety.latchGlobalStop` on, every command that is not `stop` or `disable` is refused with `423` while the stop is on. | Done, off by default. |
| Announcement | When the option `safety.publishGlobalStop` is on, the server also publishes a retained `SAFE_STOP` on the MQTT bridge. | Done, off by default. |
| Bridges and services | Subscribe to the announcement and refuse any motion command while the state is `SAFE_STOP`. | Contract defined here; each bridge adopts it on its own. |
| Controller firmware | A hardware stop on the bus of the controller. | Not part of the server; needs the real bench. |

## The announcement

- Topic: `<mqtt prefix>/safety/estop` (the default prefix is `hydra/swarm`, so `hydra/swarm/safety/estop`). QoS 1, **retained**.
- Payload: the `SafetyState` contract of the SDK, `{ "schema_version": "1.0", "state": "SAFE_STOP", "source": "hydra-umc-server", "timestamp_utc": "...", "reason": "global stop by <account>" }`.
- It is published after the stop was applied in memory, never before, and a broker that is down or an error in the publication never delays or breaks the stop. The answer of `POST /api/stop-all` then carries `announced: true` or `false`. Without the option the field is absent and nothing is published.
- The state is **latched**. Being retained, it stays on the broker, survives a restart of the server and is delivered to a part that connects late. It does not clear by itself.
- Only an administrator ends it: `POST /api/stop-all/release` removes the written stop and publishes `{ "state": "READY", ... }` on the same topic and records it in the audit record. The release moves no robot: each robot is brought back by its own commands.
- If the broker keeps no retained messages after its own restart, the latch is lost with it; a bridge that must not forget a stop should also ask the server (`GET /api/claims` and the robot state show the stopped playback).

## The stop survives a restart of the server

- Before `POST /api/stop-all` answers, the server writes `data/global-stop.json` (who, since when). A crash, an update or a power cut therefore does not undo the stop: at start-up the file is read back and the server is `STOPPED` again, with `restoredAfterRestart: true` in the stop state the apps receive, until an administrator calls `POST /api/stop-all/release`.
- A file that is there but can not be read counts as a stop. If the stop can not be written, it is still applied in memory, the audit record says `statePersisted: false` and it is tried again on the next call. If the file can not be removed, the release is refused (`500`) and the server stays stopped.
- The job executor keeps the attempts it started in `data/job-executor-attempts.json` (written before the robot moves): after a restart it never starts the same attempt again, so a restart does not play a trajectory a second time on its own. With the watch of the physical stop on, an unknown state of the stop holds the executor back as a stop does.
- The stop is never rate limited: `POST /api/stop-all` does not answer `429`. Only its secondary work is bounded (one audit record and one log line per second for repeated calls of one account).

## Commands while the stop is on

By default the global stop stops the robots and announces it, and nothing more: a later `play` or `jog` from a person is accepted by the server (the bridges that adopt the MQTT contract below refuse motion on their own). With `safety.latchGlobalStop` on (Server Admin, or `HYDRA_UMC_SAFETY_LATCH_STOP=1`; the environment wins) the server itself refuses every command of `POST /api/robot/{id}/command` except `stop` and `disable` with `423` (`global-stop-latched`) while the stop is on, until an administrator releases it.

## One stop state for the apps

The apps show one state for both stops. The server reads the physical emergency stop (the frame on identifier `0x001` of the stack bus, as the kinematic brain holds it) from the SPI bridge of the CM5 (`GET /estop`), joins it with the global stop above and pushes a `stop-state` message on the WebSocket (see `docs/REMOTE_API.md`) at every change and right after a client connects. The watch is off unless `HYDRA_UMC_ESTOP_WATCH_MS` is set or an administrator sets `safety.estopWatchMs` in Server Admin (a change applies on restart; the environment wins and locks it); without it the physical part is `unknown` and the state follows the global stop alone. It is read only: it can not cause a stop and it can not release one, and a silent bridge is `unknown`, never `READY`.

## What a bridge or service does to adopt it

1. Subscribe to `<prefix>/safety/estop` with QoS 1 when it connects, and after every reconnection.
2. While the last message it received says `SAFE_STOP`, refuse every command that moves something (answer a refusal, never ignore it) and keep letting stops and read-only requests through.
3. Resume only on a message that says `READY`.
4. Not receiving the topic at all (no broker, no subscription) leaves the part as it was: this contract adds a stop, it never removes one.

## Options

| Option | Meaning | Default |
|---|---|---|
| `safety.publishGlobalStop` (Server Admin, or `HYDRA_UMC_SAFETY_PUBLISH_STOP=1`; the environment wins) | Announce a global stop and its release on the MQTT bridge. | Off. The bridge itself must also be on (`mqtt.mode` not `off`). |
| `safety.globalStopKeyFile` of the security file (or `HYDRA_UMC_GLOBAL_STOP_KEY_FILE`; the environment wins; no route sets this path) | Sign the announcement (`issued_at_ms`, `signature`) with the key of the file (at least 32 characters, mode 600), the same one the bridges get in `HYDRA_UMC_<NAME>_GLOBAL_STOP_KEY_FILE`: they obey every `SAFE_STOP` and believe only a signed `READY`. If the file cannot be used, a stop is announced unsigned and a release is not announced. | Not set: unsigned. |
| `safety.signGlobalStop` and `safety.globalStopKey` (Server Admin, or `PUT /api/admin/server-config`, administrator only) | The same signature with a key an administrator stores in this server. `globalStopKey` (32 to 256 printable characters) is write only: it is saved to `data/global-stop.key` (mode 600) and is never answered, logged or audited; it is accepted only over HTTPS or from the machine itself. `null` removes it, with the switch off. Give the bridges the same key. A key file named in the row above wins and locks both (409). | Off, no key. |
| `safety.latchGlobalStop` (Server Admin, or `HYDRA_UMC_SAFETY_LATCH_STOP=1`; the environment wins) | Refuse every command except `stop` and `disable` with `423` while the global stop is on. | Off. |

## Related

- `docs/REMOTE_API.md`, the routes `POST /api/stop-all` and `POST /api/stop-all/release`.
- `docs/MQTT_BRIDGE.md`, the topics of the bridge.
