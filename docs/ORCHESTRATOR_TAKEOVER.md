<!-- =============================================================================
HYDRA-UMC-SERVER - Handing the missions over to a standby orchestrator
Copyright (C) JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
============================================================================= -->

# Handing the missions over to a standby orchestrator, with the proof that the robots stopped

A second orchestrator, started with `--takeover`, can take the replicated registry of the first over with `POST /replica/takeover`. A mission that was in
flight goes back to `Pending` there only when a proof names its holder, the mission and the attempt it was on; without a proof it stays `Unknown` and is
not dispatched twice. The proof is the acknowledgement that a robot gave to the stop request of the job dispatcher, which this server delivers (see
[the delivery of the stop requests](JOB_STOP_RELAY.md)). So this server holds the proofs and, when the primary orchestrator goes silent, hands them over.

## How it works

1. While the primary answers `GET /health`, the server keeps its last replica (`GET /replica`, with the token of the primary).
2. Every stop that the relay applied and the dispatcher took as acknowledged is kept as a proof: the job (the mission has the same id), the robot that
   acknowledged it and when. At most `maxProofs` are kept; the oldest go first. They live in memory only: a restart of this server forgets them, and the
   missions then stay `Unknown` (safe, not lost).
3. When the primary has been silent for `failuresBeforeTakeover` checks in a row, the server sends the standby (`POST /replica/takeover`, with its token)
   the last replica and the proofs that still apply, **once per outage**. A proof applies when it is younger than `proofMaxAgeSeconds` and the mission is in
   flight in the replica, held by the robot that acknowledged the stop; the attempt in the proof is the one of the replica.
4. A primary that answers again ends the outage and arms the hand-over again.

## Fail closed

- **Off by default:** `jobDispatcher.takeover.enabled` in `data/server-config.json`, or `HYDRA_UMC_ORCH_TAKEOVER=1` (the environment wins).
- A wrong setting stops it from starting and says why; it never falls back to a default.
- **Nothing is delivered** when no replica was ever read, when the last one was older than `maxSnapshotAgeSeconds` at the moment the primary went silent,
  or when more than 5000 missions are still open (the limit of the orchestrator; what is finished is left out, never what is open).
- A standby that refuses (`404` takeover off, `401`/`403` wrong token, `400`) is not tried again until the primary has come back. One that does not answer
  is tried every `retrySeconds`, at most `maxDeliveryAttempts` times.
- Every outcome is audited (`orchestrator-takeover`).

## Settings

The addresses and tokens come from the environment (a token is never kept in the settings file): `HYDRA_UMC_ORCHESTRATOR_URL`,
`HYDRA_UMC_ORCHESTRATOR_STANDBY_URL`, `HYDRA_UMC_ORCHESTRATOR_TOKEN` and `HYDRA_UMC_ORCHESTRATOR_STANDBY_TOKEN` (the standby falls back to the first token).

```json
{
  "jobDispatcher": {
    "takeover": {
      "enabled": false,
      "pollSeconds": 5,
      "requestTimeoutMs": 3000,
      "failuresBeforeTakeover": 3,
      "maxSnapshotAgeSeconds": 60,
      "proofMaxAgeSeconds": 3600,
      "maxProofs": 1000,
      "maxDeliveryAttempts": 5,
      "retrySeconds": 10
    }
  }
}
```

## Limits

- The replica is the last one read: what the primary did after it is not in it. The standby takes what it is given.
- A proof says that the robot stopped when it acknowledged; a mission reassigned to the same robot afterwards is a new attempt and does not match.
- Not tried with real orchestrators and robots; the tests use a simulated clock and simulated orchestrators.
