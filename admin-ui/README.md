# HYDRA-UMC SERVER - Admin UI

A small Vite/React admin panel for **this server itself** - connected
devices, its own log file, its own port/name config, and its own user
accounts. This is deliberately **not** robot control (that stays
[HYDRA-UMC STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)-only,
served separately from this same server at `/`) - see `src/server.ts`'s
own header comment in the parent repo for why this exists at all as a
narrow, explicit exception to an otherwise headless design.

## Theme

Styled to match the "HYDRA-UMC Studio Fasion" look STUDIO's own
`src/index.css` defines as one of its selectable UI themes (a brushed-metal,
embossed industrial panel style - dark neutral grays, inset/outset shadows
on buttons and inputs, a subtle diagonal micro-pattern behind a radial
gradient) rather than STUDIO's own default neon-cyberpunk theme. `src/index.css`
here redefines the exact same Tailwind color tokens (`--color-slate-*`,
`--color-sky-*`, `--color-emerald-*`, `--color-rose-*`, `--color-amber-*`)
and the same button/input/`.bg-slate-900`/`.bg-slate-950` rules that
theme's own CSS block uses in STUDIO, applied here unconditionally
(no theme switcher, no `[data-theme]` gate) since this is the one look
this panel needs - every `bg-slate-900`, `text-sky-400`, `bg-emerald-500`
class already used in `App.tsx`/`tabs/*.tsx` picks up the palette with no
per-component changes.

Tooling note: keep this file's own header comment free of backticks,
`@`-prefixed words, and bracket+quote combinations - one of those (not
fully isolated) made Tailwind v4's CSS parser here throw a `Missing
opening (` error on an otherwise valid file; a comment using none of
them builds cleanly.

Not part of the main 44-project ecosystem checklist (own README×5,
CHANGELOG.md, license files, etc.) - this is an internal sub-project of
HYDRA-UMC-SERVER, the same relationship STUDIO's own `src/components/`
files have to STUDIO itself, just split into its own directory/build
because it's served from a different URL prefix (`/admin`) than STUDIO
(`/`). Tracked in the parent repo's own `CHANGELOG.md`.

## Scope note: English only

Unlike every other UI in this ecosystem (which ships English + Spanish +
French + Italian + German), this admin panel is English-only for now.
This is a real gap, not an oversight silently left undocumented - it's a
low-traffic internal tool (server administration, not day-to-day robot
operation), so it was scoped down deliberately to ship the actual
functionality first. Tracked as a known follow-up, not forgotten.

## Build

Not built standalone in normal use - `build-frontend.sh`/`.bat` in the
parent repo root builds this ALONGSIDE HYDRA-UMC STUDIO and copies both
into the parent server's own `public/` (this one under `public/admin/`).
Run that script from the parent repo, not this directory, for a real
deployment.

For local development on this UI specifically:

```bash
npm install
npm run dev      # Vite dev server on :5174, proxies /api to localhost:3000
npm run build    # Production build -> dist/
npm run typecheck
```

`vite.config.ts`'s own `base: '/admin/'` is what makes a production build
place its assets under the right URL prefix once copied into the parent
server's `public/admin/` - if you ever copy `dist/` somewhere else by
hand instead of through `build-frontend.sh/.bat`, keep it under an
`/admin/` path or every asset URL will 404.

## What's here

- `src/App.tsx` - shell: login gate, tab navigation, JWT decode for the
  header (display only, never a trust boundary - every real
  authorization decision happens server-side).
- `src/LoginScreen.tsx` - calls the same `POST /api/login` every other
  client in this ecosystem uses.
- `src/tabs/DevicesTab.tsx` - polls `GET /api/admin/clients` (every
  currently-open WebSocket connection to the parent server).
- `src/tabs/LogsTab.tsx` - polls `GET /api/admin/logs` (tail of the
  parent server's own on-disk log file).
- `src/tabs/ConfigTab.tsx` - server name (round-trips the same
  `GET`/`POST /api/settings` STUDIO's own Config screen uses) and listen
  port (`GET`/`PUT /api/admin/server-config` - takes effect on next
  restart, not instantly; see that route's own comment in `server.ts`
  for why a running Node HTTP server can't safely rebind its own
  listening socket without dropping every open connection).
- `src/tabs/UsersTab.tsx` - full CRUD over `GET`/`POST`/`PUT`/`DELETE
  /api/users`, a route that already existed in the parent server before
  this admin UI did - this is the first real UI for it.
- `src/tabs/AboutTab.tsx` - same pattern as STUDIO's own `About.tsx`:
  fetches the parent server's real running version from `GET
  /api/hydra-info` rather than hardcoding a number that would drift.
