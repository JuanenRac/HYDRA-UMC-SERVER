# The global stop, end to end

One call stops every robot of the installation. This page says what the server does, what it announces to the rest of the ecosystem and
what each other part has to do to honour it. The server cannot make a machine safe by itself: the controller and the actuator keep the
last word, and a part that has not adopted this contract is exactly as safe as it was before.

## Layers

| Layer | What happens | State |
|---|---|---|
| Clients | One touch on the stop button calls `POST /api/stop-all` (retried with a short timeout; a stop that was not confirmed is shown as such). | Done in the control apps. |
| Server | `POST /api/stop-all` stops every robot of every controller, whoever reserved it, and switches every valve and pump off. In memory first, then the settings, then the WebSocket deltas. | Done. |
| Announcement | When the option `safety.publishGlobalStop` is on, the server also publishes a retained `SAFE_STOP` on the MQTT bridge. | Done, off by default. |
| Bridges and services | Subscribe to the announcement and refuse any motion command while the state is `SAFE_STOP`. | Contract defined here; each bridge adopts it on its own. |
| Controller firmware | A hardware stop on the bus of the controller. | Not part of the server; needs the real bench. |

## The announcement

- Topic: `<mqtt prefix>/safety/estop` (the default prefix is `hydra/swarm`, so `hydra/swarm/safety/estop`). QoS 1, **retained**.
- Payload: the `SafetyState` contract of the SDK, `{ "schema_version": "1.0", "state": "SAFE_STOP", "source": "hydra-umc-server", "timestamp_utc": "...", "reason": "global stop by <account>" }`.
- It is published after the stop was applied in memory, never before, and a broker that is down or an error in the publication never delays or breaks the stop. The answer of `POST /api/stop-all` then carries `announced: true` or `false`. Without the option the field is absent and nothing is published.
- The state is **latched**. Being retained, it stays on the broker, survives a restart of the server and is delivered to a part that connects late. It does not clear by itself.
- Only an administrator ends it: `POST /api/stop-all/release` publishes `{ "state": "READY", ... }` on the same topic and records it in the audit record. The release moves no robot: each robot is brought back by its own commands.
- If the broker keeps no retained messages after its own restart, the latch is lost with it; a bridge that must not forget a stop should also ask the server (`GET /api/claims` and the robot state show the stopped playback).

## What a bridge or service does to adopt it

1. Subscribe to `<prefix>/safety/estop` with QoS 1 when it connects, and after every reconnection.
2. While the last message it received says `SAFE_STOP`, refuse every command that moves something (answer a refusal, never ignore it) and keep letting stops and read-only requests through.
3. Resume only on a message that says `READY`.
4. Not receiving the topic at all (no broker, no subscription) leaves the part as it was: this contract adds a stop, it never removes one.

## Options

| Option | Meaning | Default |
|---|---|---|
| `safety.publishGlobalStop` (Server Admin, or `HYDRA_UMC_SAFETY_PUBLISH_STOP=1`; the environment wins) | Announce a global stop and its release on the MQTT bridge. | Off. The bridge itself must also be on (`mqtt.mode` not `off`). |

## Related

- `docs/REMOTE_API.md`, the routes `POST /api/stop-all` and `POST /api/stop-all/release`.
- `docs/MQTT_BRIDGE.md`, the topics of the bridge.
