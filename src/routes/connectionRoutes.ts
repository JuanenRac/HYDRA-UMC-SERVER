// =============================================================================
// HYDRA-UMC-SERVER - src/routes/connectionRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// The list of clients that connect to the server and the history of their sign-ins, in the closed shape of the ConnectionClient
// and ConnectionEvent contracts of the SDK. An administrator sees every client and, when the option connections.recordAddress is on,
// the address and user agent; any other account sees only its own entries and never an address. See src/connections.ts.
import express from "express";
import { authenticate } from "../auth";
import { CLIENT_KINDS, CONNECTION_ACTIONS, connectionTracker, type ClientKind, type ConnectionAction } from "../connections";
import { openSessionsByClient } from "../refresh_tokens";

export function registerConnectionRoutes(app: express.Express): void {
  app.get("/api/connections/clients", authenticate, (req: any, res) => {
    const admin = req.user?.role === "admin";
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    if (kind !== undefined && !(CLIENT_KINDS as readonly string[]).includes(kind)) return res.status(400).json({ error: `kind must be one of ${CLIENT_KINDS.join(", ")}` });
    const wantedUser = typeof req.query.user === "string" && req.query.user ? req.query.user : undefined;
    const sessions = openSessionsByClient();
    const clients = connectionTracker().clients(id => sessions.get(id) ?? 0, admin, {
      kind: kind as ClientKind | undefined,
      user: admin ? wantedUser : req.user.username,
      active: req.query.active === "1" || req.query.active === "true",
    });
    res.json({ clients });
  });

  app.get("/api/connections/events", authenticate, (req: any, res) => {
    const admin = req.user?.role === "admin";
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    if (kind !== undefined && !(CLIENT_KINDS as readonly string[]).includes(kind)) return res.status(400).json({ error: `kind must be one of ${CLIENT_KINDS.join(", ")}` });
    const action = typeof req.query.action === "string" ? req.query.action : undefined;
    if (action !== undefined && !(CONNECTION_ACTIONS as readonly string[]).includes(action)) return res.status(400).json({ error: `action must be one of ${CONNECTION_ACTIONS.join(", ")}` });
    const number = (value: unknown): number | undefined => (typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : undefined);
    if (req.query.limit !== undefined && number(req.query.limit) === undefined) return res.status(400).json({ error: "limit must be a whole number" });
    if (req.query.before !== undefined && number(req.query.before) === undefined) return res.status(400).json({ error: "before must be a whole number" });
    const wantedUser = typeof req.query.user === "string" && req.query.user ? req.query.user : undefined;
    const events = connectionTracker().events(admin, {
      kind: kind as ClientKind | undefined,
      action: action as ConnectionAction | undefined,
      user: admin ? wantedUser : req.user.username,
      before: number(req.query.before),
      limit: number(req.query.limit),
    });
    res.json({ events });
  });
}
