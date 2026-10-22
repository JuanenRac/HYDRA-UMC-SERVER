// =============================================================================
// HYDRA-UMC-SERVER - src/routes/staticRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The static file mounts (data folder with its blocked files, the STUDIO frontend and the
// admin panel), moved out of server.ts unchanged.
import express from "express";
import path from "path";
import fs from "fs";

/** Bare filenames of the sensitive files in data/ that no static mount and no upload may touch. */
export const RESERVED_DATA_FILENAMES = new Set(["settings.json", "users.json", "model_submissions.json", "refresh_tokens.json", "server-config.json", "store-meta.json"]);

export function registerStaticRoutes(app: express.Express, deps: { dataPath: string }): void {
  const { dataPath } = deps;
  // Serve static data files (like WORKS/, and any custom worksPaths a
  // robot is configured to use, which can point anywhere under data/, not
  // just WORKS/) at the root level - but never
  // any file that holds credentials or otherwise-gated data. Block every
  // such file, not just settings.json/users.json (the original 2-entry
  // list left 2 more sensitive things in data/ silently reachable):
  //   - settings.json: controller IPs, CAN-OTA config, full per-robot state
  //   - users.json: password hashes
  //   - model_submissions.json: reading this directly bypasses the
  //     submissions.enabled gate that GET /api/models/:category/:slug/
  //     download itself enforces (see the route below)
  //   - logs/**: industrialLog() output - operational detail, not
  //     credentials, but not meant to be publicly readable either
  //   - points/**: each robot's own recordedPoints array, split out of
  //     settings.json into data/points/<controllerId>/<robotId>.json (see
  //     queueSettingsWrite's own header comment) - equally "full per-robot
  //     state" as settings.json itself, just filed separately now, so it
  //     needs the exact same blanket block settings.json always had rather
  //     than accidentally becoming newly, publicly static-servable just
  //     because it moved to its own directory.
  // Client code only ever fetches WORKS/*, never these directly.
  // Bare filenames (no leading slash) of the same 3 sensitive files, reused
  // below by POST /api/upload-work and POST /api/models/submit - both write
  // caller-controlled filenames to disk and need to refuse landing on one of
  // these regardless of which folder they resolve into.
  app.use((req, res, next) => {
    // An exact-string check against `req.path` (Express's own
    // decoded/routing-normalized path) is NOT the same string
    // `express.static`/`send` below ultimately resolve to a real file
    // with - confirmed live against this exact block, all four of these
    // served the real settings.json despite failing the naive
    // string-equality check that used to run here: a single character
    // percent-encoded (`/%73ettings.json`), a doubled leading slash
    // (`//settings.json`), a case difference (`/Settings.json` - this
    // filesystem resolves it to the same file case-insensitively even
    // though the string comparison did not), and a literal or encoded
    // `.` segment (`/./settings.json`, `/%2e/settings.json`). Decode and
    // normalize the path the same way `send` itself does, then compare
    // only the real, lowercased basename and top-level segment - what
    // matters is which REAL file/directory this request resolves to,
    // not which of countless equivalent spellings of its URL asked for
    // it. A malformed percent-encoding is refused outright rather than
    // guessed at.
    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      res.status(400).end();
      return;
    }
    const normalized = path.posix.normalize(decoded).toLowerCase();
    const segments = normalized.split("/").filter(Boolean);
    const baseName = segments[segments.length - 1] ?? "";
    if (
      RESERVED_DATA_FILENAMES.has(baseName) ||
      segments[0] === "logs" ||
      segments[0] === "points" ||
      segments[0] === "backups" ||
      segments[0] === ".txn"
    ) {
      res.status(404).end();
      return;
    }
    next();
  });
  app.use(express.static(dataPath));

  // HYDRA-UMC STUDIO's own built frontend (see this file's own header
  // comment) - populated by build-frontend.sh/.bat, gitignored, absent by
  // default on a fresh checkout. express.static() on a missing directory
  // is a harmless no-op (falls through to the next handler, never throws),
  // so this line is always safe to leave in place even on a deployment
  // that deliberately never runs build-frontend and stays headless. Placed
  // AFTER dataPath's own mount above so a WORKS/ file always wins a name
  // collision (extremely unlikely in practice - STUDIO's build output is
  // index.html + hashed asset filenames, nothing a user would ever name a
  // saved trajectory), and mounted at "/" like dataPath - express.static's
  // own default `index: 'index.html'` behavior means a plain
  // `GET /` (or `GET /?hideUI=true&robotId=1&token=...` - query strings
  // never affect path matching) resolves straight to STUDIO's index.html,
  // exactly what HYDRA-UMC-ANDROID-CONTROL/.../ThreeDScreen.kt (and the
  // iOS/DSI equivalents) already assume when they embed this same URL in
  // their own in-app 3D viewer WebView.
  const studioPublicPath = path.join(process.cwd(), "public");
  if (fs.existsSync(studioPublicPath)) {
    app.use(express.static(studioPublicPath));
    console.log(`[STARTUP] Serving HYDRA-UMC STUDIO frontend from ${studioPublicPath}`);
  } else {
    console.log("[STARTUP] No public/ directory - running headless (no frontend served at \"/\"). Run build-frontend.sh/.bat to enable it.");
  }

  // This server's OWN small admin panel (admin-ui/ - device list, log
  // viewer, server config, user management) - a deliberate, narrow
  // exception to "headless, no UI of its own" (see this file's own header
  // comment): unlike STUDIO's build above, admin-ui/ is source IN this
  // repo, not copied in from a sibling one. Served at /admin, gitignored
  // build output like STUDIO's - run build-frontend.sh/.bat (it builds
  // both) to populate public/admin/. Mounted at the /admin PREFIX (not
  // root, unlike the STUDIO mount above) so its own assets never collide
  // with STUDIO's identically-named ones (both are Vite builds, both
  // produce an index.html/assets/ at their own root) - admin-ui/vite.config.ts's
  // own `base: '/admin/'` is what makes its emitted asset URLs match this.
  const adminPublicPath = path.join(process.cwd(), "public", "admin");
  if (fs.existsSync(adminPublicPath)) {
    // admin-ui uses no client-side router (a handful of in-page tabs, same
    // as STUDIO), so there's no SPA-fallback route to add here -
    // express.static's own defaults already cover both cases that matter:
    // GET /admin/ serves index.html directly (its default `index:
    // 'index.html'` behavior), and GET /admin (no trailing slash) 301s to
    // /admin/ on its own (confirmed with a real request, not assumed).
    app.use("/admin", express.static(adminPublicPath));
    console.log(`[STARTUP] Serving HYDRA-UMC SERVER admin UI from ${adminPublicPath} (at /admin)`);
  } else {
    console.log("[STARTUP] No public/admin/ directory - admin UI not served. Run build-frontend.sh/.bat to enable it.");
  }
}
