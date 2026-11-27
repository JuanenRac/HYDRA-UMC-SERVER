# Push notifications to the phones

The server can tell the phones that registered themselves when a job finished, when a global stop was issued and when the
heartbeat of an operator was lost: through **Firebase Cloud Messaging** (Android phones, and iPhones whose app was built with
a Firebase configuration) or through the **Apple Push Notification service** (APNs) for an iPhone that registered its Apple
token. It is **off by default** and does nothing until it is switched on **and** the credentials of a service are present.

A notification **only informs**. It carries a title, a sentence, the kind of event and no action: nothing can be stopped,
moved, released or confirmed from it. The sentence may name a robot, and it passes through the servers of Google or Apple.

## Firebase: where the key goes and how to switch the sending on

The key is the service account file of the Firebase project of the installation (Firebase console, Project settings, Service
accounts, *Generate new private key*). It is a secret: never put it in a repository, a release, a log or a chat.

1. Copy it to the machine that runs the server, **outside** the directory the server runs from (a file inside it is refused
   as `key-in-repo`). With the packaged service, `/etc/hydra-umc/firebase-service-account.json`.
2. Let only the service user read it: `sudo chown root:hydra-umc-server /etc/hydra-umc/firebase-service-account.json` and
   `sudo chmod 640 /etc/hydra-umc/firebase-service-account.json`. For a server started by hand, `chmod 600` and the user that
   runs it as the owner.
3. Name it: `HYDRA_UMC_FCM_SERVICE_ACCOUNT=/etc/hydra-umc/firebase-service-account.json` in `/etc/hydra-umc/server.env`, or
   `push.fcmServiceAccountFile` in `data/server-config.json` (the environment wins).
4. Restart the service, then switch push on: Server Admin (Security), `push.enabled`, or `HYDRA_UMC_PUSH=1`.
5. `GET /api/admin/push` (administrator) must answer `"configured": true`. Sign in from the app and switch its notifications
   on; `devices` then counts the phone.

The server needs to reach `oauth2.googleapis.com` and `fcm.googleapis.com` over HTTPS.

## The switch and the parameters

| Where | What |
| --- | --- |
| `push.enabled` in `data/server-config.json`, or the switch in Server Admin (Security), or `HYDRA_UMC_PUSH=1` | Turns the service on. A value fixed by `HYDRA_UMC_PUSH` locks the switch of the screen. Only the exact word `1` turns it on from the environment. |
| `push.sandbox` | `true` uses the sandbox host of Apple (builds run from Xcode); default `false`. |
| `push.notifyJobFinished`, `push.notifyGlobalStop` | Each event can be muted; both are sent by default once the service is on. |
| `push.maxDevices` | How many device tokens the server keeps (1 to 10000, 500 by default). |

These parameters are not secrets and live in the configuration file. The credentials never do.

## The Apple credentials (environment only)

| Variable | Meaning |
| --- | --- |
| `HYDRA_UMC_APNS_KEY_FILE` | Path of the `.p8` authentication key from the Apple developer account. It must be **outside** the directory the server runs from; a key inside it is refused (`key-in-repo`). |
| `HYDRA_UMC_APNS_KEY_ID` | The 10-character id of that key. |
| `HYDRA_UMC_APNS_TEAM_ID` | The 10-character team id of the Apple developer account. |
| `HYDRA_UMC_APNS_TOPIC` | The bundle id of the iPhone app. |
| `HYDRA_UMC_APNS_URL` | Optional: another HTTP/2 address instead of the Apple hosts (a relay, or a simulated service in the tests). |

Nothing of either key is ever written to the log, the audit record, `GET /api/admin/push` or the configuration file; the answer of
that route says only whether the credentials are usable and, when not, why: `missing`, `invalid`, `key-in-repo` or
`key-unreadable`. A device token is not logged either.

## What the Apple account needs

This applies to both ways of reaching an iPhone: for Firebase, the `.p8` key is uploaded to the Firebase project (Project
settings, Cloud Messaging) instead of being given to this server. Without a paid membership no iPhone receives a push.

1. An Apple Developer Program membership (the push service is not available to a free account).
2. An **App ID** with the bundle id of the app and the **Push Notifications** capability.
3. An **APNs authentication key** (Certificates, Identifiers & Profiles, Keys): download the `.p8` file once, note its Key ID and
   the Team ID of the account. One key serves every app of the team, sandbox and production.
4. In the Xcode project of the app: the Push Notifications capability (the `aps-environment` entitlement) and a provisioning
   profile that includes it. The app asks the person for permission the first time.
5. Copy the `.p8` file to the machine that runs the server, outside the project directory, readable only by the service user,
   and set the four variables in the environment of the service. Restart the service.

## The routes

* `POST /api/push/devices` `{ token, platform: "ios" | "android", locale? }` - registers the device token of the phone for the
  account (any signed-in account); `DELETE /api/push/devices/{token}` removes it (an account removes only its own, an administrator any).
  Both answer `404` while the switch is off.
* `GET /api/admin/push` (administrator) - `{ enabled, configured, problem, devices, sandbox, events }`.

A token that Apple or Firebase reports as dead (`410`, `BadDeviceToken`, `Unregistered`) is forgotten, and so are the tokens of
an account that is deleted, renamed or given a new password. The notifications are written in the eight languages; the phone
sends its language when it registers.

## What is tested, and what is not

The signing of the Apple provider token (ES256) and its request are tested against a simulated HTTP/2 service that verifies the
signature; the Firebase access token (RS256), the message and the answers are tested against a simulated Firebase; the registry, the switch, the routes and the language of each notification are covered by the unit tests. Nothing
has been sent to the real Apple or Firebase services, and no phone has shown one of these notifications.
