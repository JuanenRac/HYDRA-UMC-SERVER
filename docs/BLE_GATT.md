# Bluetooth LE service (GATT)

The server can be reached from a phone over Bluetooth LE without a Wi-Fi session: the phone sees the robot
state and, when the administrator allows it, sends commands that the server acknowledges. The service is
**off by default**.

## Switching it on

| Option | Values | Default | Where |
| --- | --- | --- | --- |
| Mode | `off`, `state` (the phones read the state), `commands` (and send commands) | `off` | Server Admin screen of the control app, `ble.mode` in `data/server-config.json`, or `HYDRA_UMC_BLE_GATT` (the environment wins) |
| Encrypted link | `true`, `false` | `true` | Server Admin screen, `ble.requireEncryption`, or `HYDRA_UMC_BLE_ENCRYPTION` (`off` to switch it off) |

A change applies on the next start. `commands` without an encrypted link is allowed but answered with the
warning `ble_commands_unencrypted`: the access token of the account travels in every command, so anyone near
the CM5 could read it.

Tunables, all in the `ble` object of `data/server-config.json` (the values below are the defaults):

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | `HYDRA-UMC` | the name the device advertises |
| `minStateIntervalMs` | `500` | the least time between two state notifications (50 to 60000) |
| `frameDelayMs` | `8` | the pause between two frames of a message (0 to 1000) |
| `commandsPerSecond` | `10` | the commands one phone may send per second; STOP is never limited (1 to 100) |
| `adapter` | first adapter that can advertise | the D-Bus path of the adapter, for example `/org/bluez/hci0` |
| `helperCommand` | `python3` | the program that runs `scripts/ble_gatt_helper.py` |

`HYDRA_UMC_BLE_HELPER` replaces the path of the helper script.

## The radio

The server does not link against the Bluetooth stack. `scripts/ble_gatt_helper.py` registers the GATT
application and the advertisement with BlueZ over D-Bus and exchanges JSON lines with the server. It needs
BlueZ and, on Debian, `python3-dbus` and `python3-gi`. When the helper cannot start (no adapter, no packages)
the server logs why and goes on without Bluetooth. A helper that dies is started again after five seconds.

## Service and characteristics

| Item | UUID | Properties | Content |
| --- | --- | --- | --- |
| HYDRA service | `48594452-0001-4000-8000-554d43000001` | primary, advertised | groups the characteristics |
| STATE | `48594452-0002-4000-8000-554d43000001` | read, **notify** | the state, UTF-8 JSON |
| COMMAND | `48594452-0003-4000-8000-554d43000001` | **write** (with response) | one command per message, UTF-8 JSON |
| ACK | `48594452-0004-4000-8000-554d43000001` | **notify** | one acknowledgement per command, UTF-8 JSON |

With the encrypted link required, COMMAND is written only over an encrypted link and STATE and ACK are
subscribed to only over one (the phone pairs the first time, with no PIN).

## Frames

A message can be larger than one ATT payload, so it is cut into frames. The payload of a frame is
`MTU - 3` bytes, header included. Every frame starts with one header byte:

| Bits | Meaning |
| --- | --- |
| 0 | `1` = first frame of the message |
| 1 | `1` = last frame of the message (a one-frame message has bits 0 and 1 set) |
| 2-3 | reserved, `0` |
| 4-7 | sequence number: `0` on the first frame, `+1` per frame, modulo 16 (the first frame is the one with bit 0, not the one whose sequence is 0) |

The receiver appends the rest of each frame until it sees the last one. A frame out of sequence, a
continuation with no start, a frame with reserved bits and a message past 64 KiB are dropped, and the receiver
waits for the next first frame. A new first frame always discards a partial message. The server sends one
message at a time (the frames of two messages are never mixed), an acknowledgement before a waiting state.

The MTU of the notifications is the smallest one among the phones that are connected, taken from the
`mtu` option BlueZ gives with every read and write. Until a phone has read STATE or written COMMAND once the
server uses the default MTU of 23 (19 bytes per frame): a phone that wants the state quickly reads STATE once
after it subscribes.

## STATE

The same tree the WebSocket sends to an operator (the credentials of the IP cameras are removed). The server
notifies the whole state right after a phone subscribes and, at most once per `minStateIntervalMs`, after
every change; only the newest state is ever waiting. A state that does not fit in 64 KiB is sent in a slim
form with `"truncated": true`: per robot only `id`, `name`, `model`, `joints`, `pos`, `position`,
`playbackState`, `valves`, `pumps`, `reservation`, `heatedBed` and `speed`. A read of STATE returns the
first frame of the last state.

## COMMAND

```json
{ "id": "c-17", "robotId": 1, "command": "pause", "params": { "paused": true }, "controllerId": "phone-1", "token": "<access token>" }
```

| Field | Rule |
| --- | --- |
| `id` | 1 to 64 characters, chosen by the phone; the acknowledgement carries it back |
| `robotId` | a whole number, 0 or more |
| `command` | one of the commands of `POST /api/robot/:id/command` |
| `params` | an object of at most 4 KiB (optional) |
| `controllerId` | 1 to 64 characters, as for the route (optional; claims need it) |
| `token` | the access token of the account (`POST /api/login`), at most 4096 characters |

**A command from a phone has no privilege of its own.** The server presents it to
`POST /api/robot/:id/command` over its own loopback address with the token as a Bearer credential, so the
same authentication, role, reservation (`409` when someone else holds the robot, except for STOP) and
safety-limit rules apply as for a client on the network.

## ACK

```json
{ "id": "c-17", "ok": true, "status": 200, "code": "ok" }
```

| Field | Meaning |
| --- | --- |
| `id` | the `id` of the command (`null` when it could not be read) |
| `ok` | `true` only when the route answered with a 2xx status |
| `status` | the HTTP status of the route; `0` when the command never reached it |
| `code` | a stable word, see below |
| `error` | the text of the refusal of the route (at most 200 characters), when it gave one |

An acknowledgement is sent **only after the route has answered**, never before: a STOP that nobody
confirmed must not look confirmed. A phone that gets no acknowledgement within a few seconds must treat the
command as not delivered. The BLE write response only proves that the radio delivered a frame.

Codes of the server itself: `malformed`, `id-required`, `unknown-command`, `token-required`,
`commands-disabled` (the mode is `state`), `rate-limited`, `damaged-message` (a frame was lost; `id` is
`null`), `unreachable` (the route did not answer). Codes of the route: its own `code` when it gave one
(for example `other-account`, `other-controller`, `controller-id-required`, `jog-not-armed`), otherwise
`rejected` (400), `session-expired` (401), `forbidden` (403), `not-found` (404), `claimed` (409),
`revision-changed` (412), `rate-limited` (429), `server-error` (5xx).

The acknowledgements are notified to every phone that subscribed to ACK and carry no state; a phone ignores
the ones whose `id` it did not send.

## What was verified

- Unit checks of the framing (every size and MTU, the sequence wrap, damaged and lost frames, the limit), of the
  gateway against a simulated radio (modes, acknowledgements and codes, malformed commands, the pace limit with
  STOP exempt, ordering, the slim state), of the helper transport against the helper without a radio, and of the
  options.
- `tools/verify_ble_gatt_contract.mjs` runs the real server with a stand-in for the helper: the state after a
  subscription, a command applied, a bad token refused, a reservation of someone else refusing a command while STOP
  goes through, and the `state` mode refusing commands.
- **Not verified on any phone, radio or BlueZ:** `scripts/ble_gatt_helper.py` against a real adapter (the
  registration with BlueZ, the flags that require encryption, the MTU option, notifications to a real phone).
