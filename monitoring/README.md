# 📊 HYDRA-UMC SERVER - Monitoring Stack (Prometheus + Grafana)

Optional. HYDRA-UMC SERVER runs exactly the same with or without this - it
just scrapes the `GET /metrics` endpoint the server already exposes (see the
main [`README.md`](../README.md), "🔌 API & WebSocket Surface") and puts a
Grafana dashboard on top of it. Nothing in this folder is required for the
server itself to work.

## What's here

```
monitoring/
├── docker-compose.yml     # Prometheus + Grafana, `docker compose up -d` and both are running
├── prometheus.yml          # Scrape config - what Prometheus polls, and how often
├── grafana/
│   ├── dashboards/
│   │   └── hydra-umc-overview.json   # The starter dashboard, auto-imported on Grafana startup
│   └── provisioning/
│       ├── datasources/    # Wires Grafana's Prometheus datasource automatically
│       └── dashboards/     # Tells Grafana to load every .json in dashboards/ above
```

## Prerequisites

- [Docker](https://www.docker.com/) with the `docker compose` plugin (Docker
  Desktop on Windows/Mac already includes it).
- HYDRA-UMC SERVER itself running separately, the normal way (`npm run dev`
  or `npm start` from the repository root - **not** part of this
  `docker-compose.yml`, which only runs Prometheus and Grafana).

## Bringing it up

From this folder (`monitoring/`):

```bash
docker compose up -d
```

That starts two containers:

- **Prometheus** on `http://localhost:9090` (bound to `127.0.0.1` only by
  default - see the comment in `docker-compose.yml` if you want it reachable
  from other machines on the LAN too; it has no login of its own).
- **Grafana** on `http://localhost:3001`.

Give it a few seconds on first run (pulling the `prom/prometheus` and
`grafana/grafana` images), then open `http://localhost:3001`.

## Logging into Grafana

Default credentials from the official `grafana/grafana` image, unchanged by
this compose file: **`admin` / `admin`**. Grafana forces a password change
on that very first login - just follow the prompt.

### Changing the default credentials up front

If you'd rather not even type the default password once, set it before the
first `docker compose up`: uncomment the two `GF_SECURITY_ADMIN_*` lines in
`docker-compose.yml`'s `grafana` service and fill in your own values, e.g.:

```yaml
environment:
  - GF_SECURITY_ADMIN_USER=youradmin
  - GF_SECURITY_ADMIN_PASSWORD=a-real-password
  - GF_AUTH_ANONYMOUS_ENABLED=false
```

These env vars only take effect on Grafana's very first startup (they seed
its internal SQLite DB, stored in the `grafana-data` Docker volume) - if
Grafana already started once with the defaults, change the password from
its own UI instead (Administration > Users), or wipe the volume
(`docker compose down -v`, which also deletes any dashboard edits you made
through the UI) to reseed it from these env vars again.

## The dashboard

`grafana/dashboards/hydra-umc-overview.json` is auto-imported into a
"HYDRA-UMC" folder the moment Grafana starts - no manual import step needed
for the setup this `docker-compose.yml` gives you. It has panels for every
metric `GET /metrics` exposes today:

- Process uptime, WebSocket clients connected
- `settings.json` write latency (count, p50/p95/p99, from the Prometheus
  histogram `hydra_settings_write_duration_seconds`)
- Atomic robot commands by type (`jog`/`play`/`pause`/`stop`/`tool`/`valve`/
  `pump`/`speed`/`vision`, from `POST /api/robot/:id/command`)
- Authentication failures by reason
- CPU load / memory usage / SoC temperature (re-exposed from the same read
  `GET /api/system/metrics` already does for the browser UI's own Overview
  footer, plus whether the temperature reading is real `vcgencmd` output or
  a dev-machine mock)

### Importing it into a different/existing Grafana instance

If you're pointing an already-running Grafana at this server instead of
using this `docker-compose.yml` (e.g. a Grafana you already run for other
things), import the dashboard by hand:

1. Add a Prometheus datasource pointing at wherever you're scraping
   `GET /metrics` from (Connections > Data sources > Add data source).
2. Dashboards > New > Import.
3. Upload `grafana/dashboards/hydra-umc-overview.json`, or paste its
   contents.
4. When prompted, select your own Prometheus datasource for the dashboard's
   panels (the JSON references the fixed datasource uid `hydraumcprom` used
   by this folder's own provisioning - Grafana's import screen lets you
   remap that to whichever datasource you actually have).

## Scrape target: dev machine vs. real deployment

`prometheus.yml` points at `host.docker.internal:3000` - see the comment in
that file for the full explanation. Short version: that hostname only makes
sense because Prometheus runs *inside Docker* while HYDRA-UMC SERVER runs
directly on the host (`npm run dev`/`npm start`), which is the normal setup
on a Windows/Mac dev machine. On the real target hardware (a Raspberry Pi
CM5, both this stack and HYDRA-UMC SERVER running as the same host's own
processes - see the main README.md's own "Production Build" section), that
Docker Desktop indirection doesn't exist, so the scrape target should be
plain `localhost:3000` instead.

## Stopping it

```bash
docker compose down
```

Add `-v` to also delete Prometheus' stored metrics history and any Grafana
UI changes (dashboard edits, new users, etc.) you made beyond what's
provisioned automatically from this folder:

```bash
docker compose down -v
```

## Security note

Both containers are meant for a trusted LAN, matching this whole project's
own posture (see the main README.md's security notes on `JWT_SECRET`,
CORS, etc.) - Prometheus' own UI has no authentication at all (which is why
it's bound to `127.0.0.1` only by default above), and Grafana's is a single
shared admin login, not a real multi-user access-control system. Don't
expose either port directly to the public internet without putting a real
reverse proxy / VPN / auth layer in front, the same way you wouldn't expose
HYDRA-UMC SERVER's own API directly either.
