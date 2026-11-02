# Presence of the operator (dead-man)

The server can watch that the person who drives the robots is still there, and act on those robots when they are not. It is off by default.

## How it works

1. A client (the watch, through the phone) sends `POST /api/operator/presence` every few seconds with a numbered heartbeat (`sequence`, `intervalSeconds`, `state` `PRESENT` or `LEFT`). The route is authenticated and idempotent by `sequence`.
2. The heartbeats of an account are followed on their own. When `presence.timeoutSeconds` pass without one (never less than twice the interval of the sender plus one second), or a heartbeat says `LEFT` on purpose, the account is `lost`.
3. The server then acts on the robots that account holds a claim on, with the action an administrator chose: `slow` (default), `pause`, `notify` or `stop`. It writes the log and an audit record and warns the registered phones.
4. When the heartbeats come back, `presence.recoverBeats` in a row bring the account back. A lowered speed returns along `presence.rampSeconds` without a jump; a paused or stopped robot stays as it is until the operator resumes it.

| Action | What happens to the robots of that operator |
|---|---|
| `slow` (default) | The speed is kept at `slowFactor` of what it was (never under 10) and brought back to that cap if somebody raises it. |
| `pause` | The ones that are running are paused. |
| `notify` | Nothing is touched; only the log, the audit record and the push. |
| `stop` | They are stopped, as with the stop command. |

## Where it is configured

* Server Admin (`PUT /api/admin/server-config`): `presence.enabled` and `presence.action`. The environment locks them: `HYDRA_UMC_PRESENCE=1` and `HYDRA_UMC_PRESENCE_ACTION`.
* `data/server-config.json`, block `presence`: `timeoutSeconds` (3 to 600, 15), `slowFactor` (0.05 to 0.9, 0.3), `recoverBeats` (1 to 20, 3), `rampSeconds` (0 to 120, 5), `leftImmediate` (true). `push.notifyPresenceLost` (true) tells the phones.

## Safety notes

* The global stop always wins: this function only changes numbers in memory, never starts, resumes or un-stops a robot, and never delays `POST /api/stop-all`.
* Only the robots with an active claim by that account are touched; a robot that changes hands while held back keeps the speed it has.
* The held state is kept in memory: after a restart of the server a lowered speed stays lowered until somebody sets it.
* Checked with simulated robots only; nothing here was tried with a real robot or a real watch.
