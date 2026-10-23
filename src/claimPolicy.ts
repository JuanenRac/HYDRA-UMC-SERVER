// =============================================================================
// HYDRA-UMC-SERVER - src/claimPolicy.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Who controls which robot. A claim belongs to an account and, when the client says so, to one
// controller: the identifier a single control client (a window of the desktop app, a browser tab,
// a phone) picks for itself and sends as `controllerId` when it claims and as the `X-Controller-Id`
// header (or a `controllerId` field) on its commands. Two clients of the same account therefore no
// longer share one claim. A claim made without a controller id behaves exactly as before.
// Note: the `controllerId` of the robot deltas and of the settings tree names a cell (a group of
// robots); it is a different thing, and the claim listing calls that one `cellId`.

const CONTROLLER_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** The controller id a request presents: undefined when absent, null when present but malformed. */
export function readControllerId(headerValue: unknown, bodyValue: unknown): string | undefined | null {
  const raw = typeof headerValue === "string" && headerValue.trim() !== "" ? headerValue.trim() : bodyValue;
  if (raw === undefined || raw === null || raw === "") return undefined;
  return typeof raw === "string" && CONTROLLER_ID.test(raw) ? raw : null;
}

export type ClaimConflict =
  | { reason: "other-account"; message: string }
  | { reason: "other-controller"; message: string }
  | { reason: "controller-id-required"; message: string };

/** Why `reservation` stops this caller from commanding the robot (null when it does not). */
export function claimConflict(
  reservation: any,
  user: { id: unknown },
  presentedControllerId: string | undefined,
  isActive: (reservation: any) => boolean,
): ClaimConflict | null {
  if (!isActive(reservation)) return null;
  if (reservation.ownerId !== user.id) {
    return { reason: "other-account", message: `robot is already claimed by ${reservation.ownerUsername}` };
  }
  const held = typeof reservation.controllerId === "string" ? reservation.controllerId : undefined;
  if (held === undefined) return null;
  if (presentedControllerId === undefined) {
    return { reason: "controller-id-required", message: `robot is claimed by ${reservation.ownerUsername} on controller ${held}; send that controllerId` };
  }
  if (presentedControllerId !== held) {
    return { reason: "other-controller", message: `robot is claimed by ${reservation.ownerUsername} on another controller (${held})` };
  }
  return null;
}

export interface ClaimView {
  robotId: unknown;
  robotName: string | null;
  cellId: unknown;
  ownerId: unknown;
  ownerUsername: unknown;
  controllerId: string | null;
  claimedAt: unknown;
  expiresAt: unknown;
  jogArmedUntil: number | null;
}

/** Who controls which robot, for every robot that has an active claim (GET /api/claims and the `claims` message of the WebSocket). */
export function listClaims(
  settings: any,
  isActive: (reservation: any) => boolean,
  jogArmedUntil: (robotId: number) => number | null = () => null,
): ClaimView[] {
  const claims: ClaimView[] = [];
  for (const cell of settings?.controllers ?? []) {
    for (const robot of cell.robots ?? []) {
      if (!isActive(robot.reservation)) continue;
      claims.push({
        robotId: robot.id,
        robotName: robot.name ?? null,
        cellId: cell.id,
        ownerId: robot.reservation.ownerId,
        ownerUsername: robot.reservation.ownerUsername,
        controllerId: robot.reservation.controllerId ?? null,
        claimedAt: robot.reservation.claimedAt,
        expiresAt: robot.reservation.expiresAt,
        jogArmedUntil: jogArmedUntil(robot.id),
      });
    }
  }
  return claims;
}
