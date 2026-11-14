<!-- =============================================================================
HYDRA-UMC-SERVER - Delivery of the stop requested by the job dispatcher
Copyright (C) JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

# Delivering the stop that the job dispatcher asks for

When a robot goes silent, the job dispatcher cannot know whether it is still executing its job. A robot that declared it can confirm a stop (`"stopCapable": true` in its heartbeat) is therefore asked to stop before its job goes to another robot: the dispatcher records a stop request and waits for an acknowledgement. This page says who carries the request and the answer.

## Who does it

This server. It owns the robots and their stop, and the stop of a single robot is already a command that no reservation can hold back. The relay reads the open requests, applies that same stop and acknowledges it. The orchestrator is not part of the delivery: it has no way to reach a robot and it grants itself no physical authority.

```
JOB-DISPATCHER  --GET /jobs/stop-requests-->  SERVER  --stop the robot-->  robot of the roster
JOB-DISPATCHER  <--POST /jobs/stop-ack------  SERVER  (only after the stop was applied)
```

## Rules

- **Off by default.** `jobDispatcher.stopRelay.enabled` in `data/server-config.json`, or `HYDRA_UMC_JOB_STOP_RELAY=1` (the environment wins). Nothing is read from the dispatcher while it is off.
- **Fail closed.** A stop that could not be applied is never acknowledged: the dispatcher then keeps the job `unknown`, or, only if its own `replan.allow_unconfirmed` switch is on, reassigns it on its own responsibility. A robot that is not in `robotMap` is neither stopped nor acknowledged. A request that the dispatcher marks `expired`, or that is older than `maxRequestAgeSeconds`, is not delivered.
- **A wrong setting stops the relay from starting** and says why in the log; it never falls back to a default.
- **No secret in the file.** The address is `HYDRA_UMC_JOB_DISPATCHER_URL` (or `jobDispatcher.stopRelay.url`) and the token is only `HYDRA_UMC_JOB_DISPATCHER_TOKEN`.
- **Every outcome is audited** (`job-stop-relay`: stopped and acknowledged, refused, or failed).

## Editing it

An administrator edits the switch (`jobDispatcher.stopRelay.enabled`, applied on the next start of the server) and the robot map (read again at every pass, so it applies at once) in **Server Admin** of STUDIO and SUITE, or with `PUT /api/admin/server-config`. The map is validated (an id of 1 to 64 letters, digits and `. _ : -`; a whole number of 0 or more; at most 1000 entries) and every change is logged and recorded in the audit record as `job-dispatcher-options`. The same screen edits the two options of the replanning of the dispatcher (`allowUnconfirmed`, `stopAckTimeoutSeconds`); the server writes them into the dispatcher configuration file named by `HYDRA_UMC_JOB_DISPATCHER_CONFIG` and then asks the dispatcher to read the file again (`POST /admin/reload-config`, answered only to a caller on the dispatcher's own machine). The dispatcher checks the file before it installs anything: a file that is not valid changes nothing there and its previous values stay in force. The answer of the server says whether the dispatcher took it (`replan.reload`: `applied`, `failed`, `pending`, or `not_configured` when no address of the dispatcher is set); only while it is not `applied` does the change wait for the next start of the dispatcher. The address is `HYDRA_UMC_JOB_DISPATCHER_URL` (or `jobDispatcher.stopRelay.url`), the token `HYDRA_UMC_JOB_DISPATCHER_TOKEN` (or `JOB_DISPATCHER_TOKEN`), and the time to wait is `jobDispatcher.reload.timeoutMs` (100 to 60000, default 3000).

## The section of the file

```json
{
  "jobDispatcher": {
    "stopRelay": {
      "enabled": false,
      "pollSeconds": 2,
      "requestTimeoutMs": 3000,
      "maxRequestAgeSeconds": 120,
      "maxFailureBackoffSeconds": 60,
      "robotMap": { "arm-1": 1, "arm-2": 2 }
    }
  }
}
```

| Key | Meaning | Default |
|---|---|---|
| `pollSeconds` | Seconds between two reads of the requests (0.5 to 3600). | 2 |
| `requestTimeoutMs` | The longest wait for one answer of the dispatcher. | 3000 |
| `maxRequestAgeSeconds` | A request older than this is not delivered (the dispatcher has decided by then). | 120 |
| `maxFailureBackoffSeconds` | After a failed read the pause doubles up to this limit. | 60 |
| `robotMap` | The robot id of the dispatcher mapped to the numeric id of the robot in this server. | none (nothing is delivered) |

## Limits

- The stop is the stop of the server (the playback of the robot and its arming). It is as real as the stop button of the control apps; the controller and the actuator keep the last word.
- The ids of the dispatcher and of this server are different spaces, hence the explicit map.
- If the acknowledgement is lost after the stop, the next pass stops the robot again (harmless) and retries it.

## Registering the robots in the dispatcher

The dispatcher only assigns jobs to robots it knows (`POST /robots`). This server owns the roster (`controllers[].robots`) and the authentication, so it can register the robots there (`src/dispatcherRegistrar.ts`):

- **Off by default.** `jobDispatcher.registrar.enabled` in `data/server-config.json`, or `HYDRA_UMC_JOB_ROBOT_REGISTRAR=1` (the environment wins). The address and the token are those of the stop relay (`HYDRA_UMC_JOB_DISPATCHER_URL`, `HYDRA_UMC_JOB_DISPATCHER_TOKEN`, or `jobDispatcher.registrar.url` / `jobDispatcher.stopRelay.url`).
- **Which robots.** Those of the roster that have an entry in the robot map (dispatcher id -> robot id of this server, the same map as the stop relay). With `jobDispatcher.registrar.registerUnmapped: true` the others are registered too, with their id here (as text) as their id there. A robot id used by more than one robot is never registered.
- **What it does.** Every `pollSeconds` (30 by default) it reads `GET /robots` and registers, with `{"id": ..., "available": true}`, only the robots the dispatcher does not know. A robot the dispatcher already knows is never touched: its tool, location, availability and load are the dispatcher's own, so a registration cannot overwrite a robot that is working on a job.
- **Limits** (all in the file): `pollSeconds` 1 to 86400, `requestTimeoutMs` 100 to 60000, `maxFailureBackoffSeconds` 1 to 86400 (the pause doubles after each failure up to it). A wrong value stops the registrar from starting and says why in the log; every registration is written to the audit chain (`job-robot-registrar`).
- The dispatcher lists a robot with the names of its own structure (`ID`, `Tool`) and, with its camelCase aliases on, also `id`, `tool`; the reader accepts both.
