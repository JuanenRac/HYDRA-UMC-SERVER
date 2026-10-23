# Contract v2 of the server: design by blocks

This is the whole design of the second version of the server contract. All five blocks and the
safety limits are implemented; the clients can be adapted one block at a time. Nothing here changes the first version: every v2 field is optional
and a client that ignores it keeps working.

## Principles

- Additive: new fields and routes, never a changed meaning. A client that does not send a v2
  field gets the v1 behaviour.
- The server decides: limits, claims and arming are checked in the server for every client.
- Every safety option is configurable by an administrator, with a conservative default, and the
  environment of the deployment may lock it.
- Every refusal has a stable `code` next to `error`, so a client can tell the cases apart.

## Block 1 - controller id and claims (implemented)

- `controllerId`: chosen by one control client for its session, 1 to 64 characters of letters,
  digits and `. _ : -`; sent in the body of `claim`, `release`, `jog-arm` and `command`, or as the
  `X-Controller-Id` header.
- A claim belongs to an account and, when a controller id is sent, to that controller. The same
  account on another controller is refused (`other-controller`); no controller id while the
  claim has one is refused (`controller-id-required`); another account is refused
  (`other-account`). `stop` and the global stop are never blocked.
- `GET /api/claims` lists who controls which robot.
- `claims.requireControllerId` (default off) makes the id mandatory for `claim`.
- Safety limits (`GET /api/safety-limits`, `PUT /api/admin/safety-limits`): the size of a jog and
  the range of an absolute jog per model, the highest heated-bed target per model, the optional
  explicit arming of the jog (`POST /api/robot/:id/jog-arm`, off by default). See
  `REMOTE_API.md`, section 2l.

## Block 2 - conditional writes (implemented)

- `If-Match` on `POST /api/robot/:id/command` and on the claim routes, with the revision of the
  robot (`ETag` of `GET /api/robot/:id`), answering `412` with the current revision when the
  robot changed. The full settings tree already has this.
- `GET /api/robot/:id`: one robot with its revision, so a client does not have to read the whole tree.

## Block 3 - atomic table command (implemented)

- `"table"` command: a move of the XY table of a robot in one request (`{ x, y, rz?, mode:
  "absolute"|"relative" }`), bounded by the limits of block 1 and returned with the applied
  position, instead of one `jog` per axis.

## Block 4 - audit record (implemented)

- `GET /api/audit` (admin): a bounded, append-only log of the changes that matter (claims,
  limits, global stops, jog arming, forced releases), each with the account, the controller id,
  the address and the outcome; exportable, and covered by the settings backups.
- The same record is the source of the history that `reservationHistory` keeps today.

## Block 5 - events (implemented)

- A `claims` message on the WebSocket (for the clients that opened it with `?remoteApiVersion=2`) when a claim,
  a release, an arming or a stop changes, so a client need not poll `GET /api/claims`.

The bodies of blocks 2 to 5 are in `REMOTE_API.md`, section 2m.

## Versioning

The contract is described by `openapi.json` (the routes), `REMOTE_API.md` (the bodies) and the
copy kept in the SDK. Each block that ships raises the minor number of the server and is
announced in its changelog.
