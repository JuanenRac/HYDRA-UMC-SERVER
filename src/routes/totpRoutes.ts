// =============================================================================
// HYDRA-UMC-SERVER - src/routes/totpRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The second factor of the sign-in: an account turns it on, confirms it with a first code, and turns it off with its password and
// a code. An administrator can reset it for an account that lost both the phone and the recovery codes. See src/totp.ts.
import express from "express";
import { asyncHandler, authenticate, requireAdmin } from "../auth";
import { effectiveId, findUser, verifyPassword } from "../users";
import { totpStore } from "../totp";
import { authFailuresTotal } from "../metrics";

export function registerTotpRoutes(app: express.Express): void {
  app.get("/api/totp/status", authenticate, (req: any, res) => {
    const id = effectiveId(req.user);
    res.json({ enabled: totpStore().enabled(id), recoveryLeft: totpStore().recoveryLeft(id) });
  });

  // Starts the enrolment: a new secret that is not in force until /api/totp/confirm accepts a code made from it. It asks for the
  // password again, so a session left open on a screen cannot be used to put the attacker's authenticator on the account.
  app.post("/api/totp/begin", authenticate, asyncHandler(async (req: any, res) => {
    const { password } = req.body || {};
    const user = findUser(req.user.username);
    if (typeof password !== "string" || !user || !(await verifyPassword(password, user.passwordHash))) {
      authFailuresTotal.inc({ reason: "totp_begin_bad_password" });
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const id = effectiveId(user);
    if (totpStore().enabled(id)) return res.status(409).json({ error: "The second factor is already on; turn it off first" });
    res.json({ success: true, ...totpStore().begin(id, user.username) });
  }));

  app.post("/api/totp/confirm", authenticate, asyncHandler(async (req: any, res) => {
    const { code } = req.body || {};
    if (typeof code !== "string") return res.status(400).json({ error: "code required" });
    const codes = totpStore().confirm(effectiveId(req.user), code.trim());
    if (!codes) {
      authFailuresTotal.inc({ reason: "totp_confirm_bad_code" });
      return res.status(400).json({ error: "That code is not right (or no enrolment was started)" });
    }
    res.json({ success: true, recoveryCodes: codes });
  }));

  app.post("/api/totp/disable", authenticate, asyncHandler(async (req: any, res) => {
    const { password, code } = req.body || {};
    const user = findUser(req.user.username);
    if (typeof password !== "string" || !user || !(await verifyPassword(password, user.passwordHash))) {
      authFailuresTotal.inc({ reason: "totp_disable_bad_password" });
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const id = effectiveId(user);
    const store = totpStore();
    if (!store.enabled(id)) return res.json({ success: true });
    const wait = store.waitFor(id);
    if (wait > 0) return res.status(429).set("Retry-After", String(wait)).json({ error: "Too many wrong codes; wait before trying again" });
    if (!store.verify(id, code)) {
      authFailuresTotal.inc({ reason: "totp_disable_bad_code" });
      return res.status(401).json({ error: "A current code or an unused recovery code is required" });
    }
    store.disable(id);
    res.json({ success: true });
  }));

  // For an account that lost the phone and the recovery codes: the administrator removes its second factor (it can enrol again).
  app.delete("/api/users/:username/totp", authenticate, requireAdmin, (req, res) => {
    const user = findUser(String(req.params.username));
    if (!user) return res.status(404).json({ error: "No such user" });
    totpStore().disable(effectiveId(user));
    res.json({ success: true });
  });
}
