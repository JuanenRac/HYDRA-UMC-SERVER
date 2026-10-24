# MQTT bridge

The server can publish the state of its robots to the MQTT broker of the cell
(HYDRA-UMC-MQTT-BROKER) and, only when an administrator asks for it, carry out the
commands published there. It is **off by default**.

## Turning it on

| Mode | What it does |
|---|---|
| `off` | Nothing (default). |
| `state` | Connects to the broker and publishes the state of every robot. Subscribes to nothing. |
| `commands` | The same, and also carries out the commands published on `<prefix>/robot_<id>/cmd/<command>`. Needs an account (below). |

Set it with `HYDRA_UMC_MQTT_BRIDGE` in the environment, or in the control app
(Server Admin), or by hand in `data/server-config.json`:

```json
{ "mqtt": { "mode": "state", "url": "mqtt://127.0.0.1:1883", "prefix": "hydra/swarm", "username": "hydra-server" } }
```

The environment wins over the file, and the file over the defaults (`mqtt://127.0.0.1:1883`,
prefix `hydra/swarm`). The mode changes on the next start. An address must be `mqtt://`,
`mqtts://`, `ws://` or `wss://`; a prefix is topic levels of letters, digits, `.`, `_` and `-` (no wildcards).
The passwords are never written to the file: `HYDRA_UMC_MQTT_PASSWORD` (or `_FILE` with a path) for the
connection, `HYDRA_UMC_MQTT_COMMAND_PASSWORD` (or `_FILE`) for the commands account.

The broker's own access rules still apply: give the connection a user the broker allows to publish
under the prefix (and, for `commands`, to subscribe to `<prefix>/+/cmd/+`).

## Topics

| Topic | Direction | Content |
|---|---|---|
| `<prefix>/status` | out, retained | `online`; `offline` is the last will of the connection and is also sent on a clean stop |
| `<prefix>/robot_<id>/state` | out, retained | JSON summary: id, controllerId, name, online, model, role, tool, pos, joints, valves, pumps, endstops, playbackState, visionEnabled, combinedWith, hasXYTable, xyTablePos, selectedWorkFile, pointsCount, reservation (`ownerUsername`, `expiresAt`) |
| `<prefix>/robot_<id>/joints` | out, retained | `{ "j1": .., .. "j6": .. }` |
| `<prefix>/robot_<id>/tool` | out, retained | the tool, as a JSON string |
| `<prefix>/robot_<id>/cmd/<command>` | in (`commands`) | the JSON parameters of the command (an empty message is `{}`) |
| `<prefix>/robot_<id>/cmd/<command>/result` | out | `{ "success", "status", "code", "error"?, "revision"? }` |

Only what changed is published again, at most four times a second. The summary never holds the
recorded points (only how many), nor the credentials of the cameras, nor the history of the
reservations. After a reconnection everything is published again.

## Commands

A command published here gets no privilege of its own. It is presented to
`POST /api/robot/:id/command` of this same server, over the loopback address, with the access token of the
account named by `HYDRA_UMC_MQTT_COMMAND_USER` (and its password), so the role of that account, the
reservations of the robots, the `If-Match` rule and the limits of the jog apply exactly as they do to a
client of the network. Give the account the role you want the bridge to have: an `operator` to drive, a
`viewer` to make the bridge read-only whatever the mode says. The reservation rule sees the client as
`mqtt`. If the commands account is not complete the bridge starts with the state only and says so in the
log.

Accepted commands: `stop`, `play`, `pause`, `jog`, `reset`, `jogStep`, `reset3D`, `tool`, `valve`, `pump`,
`speed`, `trajectory`, `vision`, `table`. The edits of a robot's data (`points`, `loop`, `model`, `role`,
`combine`, `joints`, `xyTableConfig`) and any other word are refused with `unknown-command` before the
route. A payload that is not a JSON object is `invalid-payload`; more than 10 commands a second (configurable
in the file, 1 to 100) is `rate-limited`, except `stop`, which is never held back. A `401` from the route
makes the bridge sign in again once.
