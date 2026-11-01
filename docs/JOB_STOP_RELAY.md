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

An administrator edits the switch (`jobDispatcher.stopRelay.enabled`, applied on the next start of the server) and the robot map (read again at every pass, so it applies at once) in **Server Admin** of STUDIO and SUITE, or with `PUT /api/admin/server-config`. The map is validated (an id of 1 to 64 letters, digits and `. _ : -`; a whole number of 0 or more; at most 1000 entries) and every change is logged and recorded in the audit record as `job-dispatcher-options`. The same screen edits the two options of the replanning of the dispatcher (`allowUnconfirmed`, `stopAckTimeoutSeconds`); the server writes them into the dispatcher configuration file named by `HYDRA_UMC_JOB_DISPATCHER_CONFIG`, and the dispatcher reads them on its next start.

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
