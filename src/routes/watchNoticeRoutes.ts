// =============================================================================
// HYDRA-UMC-SERVER - src/routes/watchNoticeRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// A phone says whether it tells its watch about a newer release; an administrator reads what the phones said (src/watchReleaseNotice.ts).
import express from "express";
import { parseWatchNotice, type WatchReleaseNotices } from "../watchReleaseNotice";

type Middleware = (req: any, res: any, next: any) => unknown;

export function registerWatchNoticeRoutes(app: express.Express, deps: { authenticate: Middleware; requireAdmin: Middleware; notices: WatchReleaseNotices }): void {
  const { authenticate, requireAdmin, notices } = deps;

  app.post("/api/watch/release-notice", authenticate, (req: any, res) => {
    const parsed = parseWatchNotice(req.body);
    if (parsed.ok === false) return res.status(400).json({ error: parsed.error });
    notices.record(String(req.user?.username ?? ""), parsed.value);
    res.json({ saved: true });
  });

  app.get("/api/admin/watch/release-notice", authenticate, requireAdmin, (req, res) => {
    res.set("Cache-Control", "no-store").json({ devices: notices.list() });
  });
}
