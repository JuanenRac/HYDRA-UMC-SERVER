# HYDRA-UMC SERVER - Remote Access via VPN (instead of NAT port-forward)

This server assumes a "trusted LAN" threat model throughout its own code
and docs (see [`REMOTE_API.md`](REMOTE_API.md)): plain HTTP/WS by
default, a permissive CORS policy, and a 30-day JWT expiry. That model
stops being true the moment the server's port is reachable from the
open internet - a direct NAT port-forward on the router does exactly
that, and it's found by mass internet scanners in hours to days, not
"only if someone specifically looks for it".

This server controls real physical hardware (robot arms, a 10W
engraving laser, heater stages). **A VPN tunnel back into the real LAN
is the recommended way to reach it remotely** - it keeps the "trusted
LAN" model actually true instead of just assumed, with zero code
changes anywhere in the ecosystem. Port-forwarding the raw API port
directly to the internet is not recommended; if you need to do it
anyway for a specific test, use the documented hardening options (JWT secret, CORS
allowlist, rate-limiting, optional TLS - all added to this server, see
[`REMOTE_API.md`](REMOTE_API.md) and the root `.env.example`) and use
them together, not instead of a VPN.

## Option A - Tailscale (easiest to set up)

Managed WireGuard-based mesh VPN, free tier is enough for a home/small
lab setup. No router configuration or port-forwarding needed at all -
it punches through NAT on its own.

1. Create a free account at [tailscale.com](https://tailscale.com).
2. Install the Tailscale client on the machine running HYDRA-UMC SERVER
   (the CM5, or whatever host it's on) and sign in - this machine now
   has a stable Tailscale IP (`100.x.x.x`) reachable from any other
   device on the same Tailscale account, from anywhere.
3. Install the Tailscale client on whatever device you're testing from
   outside the LAN (phone, laptop) and sign in with the same account.
4. Reach the server at `http://<tailscale-ip>:3000` exactly as if you
   were on the LAN - `X-Hydra-Client` gating, JWT auth, mDNS discovery
   (mDNS itself doesn't cross the tunnel, but a manually-entered host/IP
   in any client's login screen works the same as on the real LAN).
5. Close the router's port-forward entry for this server's port - it's
   no longer needed.
6. Optional but recommended: in the Tailscale admin console, restrict
   which devices/users can reach this specific machine (ACLs), instead
   of leaving every device on the tailnet with access.

## Option B - WireGuard (self-hosted, more control)

More setup work, no third-party account needed, runs entirely on your
own router/hardware.

1. Most consumer routers (recent OpenWrt, Asus, some Netgear/Ubiquiti
   firmware) have a built-in WireGuard server - check your router's
   admin panel under VPN settings first before installing anything
   separate.
2. If your router doesn't support it: run a small always-on WireGuard
   server on the same host as HYDRA-UMC SERVER itself (`wg-quick`,
   available for Linux/the CM5's own OS) or on any other always-on
   machine on the LAN, and forward **only the WireGuard UDP port**
   (typically 51820) through the router - not the API port.
3. Generate a key pair for the server and one per remote device
   (`wg genkey | tee privatekey | wg pubkey > publickey`), configure
   each side's `wg0.conf` with the other's public key and allowed IPs.
4. Once the tunnel is up, the remote device gets an IP inside the
   WireGuard subnet and reaches the server at its LAN IP directly
   (`http://192.168.x.x:3000`), same as being physically on the LAN.
5. Only the WireGuard UDP port is ever exposed to the internet - the
   API port itself never is.

## Why this instead of exposing the API port directly

| | NAT port-forward (API port direct) | VPN tunnel |
|---|---|---|
| What's exposed to the internet | The full REST/WS API, plain HTTP | Only the VPN handshake port |
| Threat model the code assumes | Broken (LAN-trusted code now internet-facing) | Still true (you're on the LAN once connected) |
| Code changes needed | Real hardening required (see below) | None |
| Discoverable by mass scanners (Shodan etc.) | Yes, within hours-days | No - VPN handshake alone reveals nothing usable without a valid key/account |

If you still want to keep the raw port-forward for a specific test
scenario, use it *together with*, not instead of, the hardening already
added to this server: real `JWT_SECRET` (never the dev fallback),
`CORS_ALLOWED_ORIGINS` set to an explicit allowlist (never left open),
the login rate-limiter left enabled, and ideally `TLS_CERT_PATH`/
`TLS_KEY_PATH` configured so credentials never travel in clear text.
See the root `.env.example` and [`REMOTE_API.md`](REMOTE_API.md) for
how to set each of those.

## Telling the house from outside: trusted networks (optional, off by default)

A VPN keeps the server inside the house network, but it cannot stop a port that was opened by mistake. The server can
also tell, request by request, where an address comes from. The option is **off by default**: turn it on from Server Admin
(Security, "trusted networks"), with `HYDRA_UMC_TRUSTED_NETWORKS=1`, or with `"trustedNetworks": { "enabled": true }` in
`data/server-config.json`. The rest is read from that file:

```json
"trustedNetworks": {
  "enabled": true,
  "local": ["192.168.0.0/24"],
  "vpn": ["10.66.0.0/24"],
  "outside": "operate",
  "outsideRequiresSecondFactor": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `local` | the private ranges and the loopback | Ranges (CIDR) that count as the house. A list replaces the default. |
| `vpn` | none | Ranges of the VPN (the address of the WireGuard or Tailscale subnet); they count as the house. |
| `outside` | `operate` | What a request from any other address may do: `operate` (everything but administering) or `view` (only looking, stopping and its own sign-in). |
| `outsideRequiresSecondFactor` | `true` | From outside, only an account that has the second factor on can sign in or renew its session. |

While the option is on:

* From outside, `/api/admin`, `/api/users`, `/api/system`, the service control, the integrations, work uploads, model
  submissions, saving the settings and the commands to the machine bridges answer `403` with `code: "remote-policy"`
  and `needs: "vpn"`, and the refusal is written in the audit log. A stop is never refused.
* With `outside: "view"` the robot commands other than stop and disable are refused too.
* A sign-in from outside by an account without the second factor answers `403` (`second-factor-required`) after the
  password was checked; turn the factor on from the house or the VPN first.
* A range that is not an address range is ignored (the trusted area only ever gets smaller) and counted in the
  Server Admin snapshot (`invalidEntries`).
* The address is the one of the connection. Behind a reverse proxy every request looks like the proxy's own, which is in the
  house: use the VPN, not a proxy, to reach the server from outside, and check the setting from a phone on mobile data.

