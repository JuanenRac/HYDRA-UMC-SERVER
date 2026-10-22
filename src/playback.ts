// =============================================================================
// HYDRA-UMC-SERVER - src/playback.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// The server-authoritative playback engine and the robot reservation helpers, moved out
// of server.ts unchanged.
export interface PlaybackDeps {
  getSettings: () => any;
  queueSettingsWrite: (payload: any) => Promise<void>;
  broadcastRobotDelta: (deltas: { controllerId: string; robotId: number; patch: Record<string, unknown>; cameraId?: number; cameraPatch?: Record<string, unknown> }[], fullPayload: any) => void;
}

export function createPlayback(deps: PlaybackDeps) {
  const { getSettings, queueSettingsWrite, broadcastRobotDelta } = deps;
  // V0 server-authoritative playback engine: linear point-to-point replay
  // of a robot's own recordedPoints, straight from each point's OWN
  // stored j1..j6/pos (real values captured live at record time, not
  // re-derived) - deliberately NOT the full velocity/acceleration
  // interpolation curve HYDRA-UMC-STUDIO's own RobotDetail.tsx used to
  // render playback with (that client-side loop is now removed - it
  // rendered whatever this engine broadcasts instead, like every other
  // client already did), and deliberately not running any inverse
  // kinematics itself. Exists so play/pause/stop physically move a robot
  // from ANY client (Android, iOS, DSI, SUITE) without depending on some
  // STUDIO browser tab being open with that exact robot's panel mounted.
  //
  // The server is now the SINGLE source of truth for playback motion:
  // every client (STUDIO included, see RobotDetail.tsx's own
  // playRobotTrajectory comment) only ever renders robot.pos/joints as
  // they arrive over the WebSocket, never drives them locally - avoiding
  // two writers (this engine and a browser tab's own loop) racing to set
  // the same robot's position, which would be a real problem on physical
  // hardware, not just a UI glitch.
  const playbackTimers = new Map<number, NodeJS.Timeout>();
  const PLAYBACK_BASE_INTERVAL_MS = 600;

  function findRobotById(robotId: number): any {
    let found: any = null;
    getSettings().controllers?.forEach((c: any) => {
      const r = c.robots?.find((r: any) => r.id === robotId);
      if (r) found = r;
    });
    return found;
  }

  function findControllerIdForRobot(robotId: number): string | null {
    let found: string | null = null;
    getSettings().controllers?.forEach((c: any) => {
      if (c.robots?.some((r: any) => r.id === robotId)) found = c.id;
    });
    return found;
  }

  // P06: command ownership. A real, TTL-bounded claim is embedded
  // directly on the robot object (`robot.reservation`) rather than a
  // separate Map, so it round-trips through the SAME persistence
  // (queueSettingsWrite) and broadcast (broadcastRobotDelta/
  // broadcastSettings) machinery every other robot field already uses,
  // instead of needing its own parallel wiring. Identity is per-ACCOUNT
  // (req.user.id), the only identity this server has - two tabs/devices
  // logged in as the same account share one claim, by design, since
  // there is no per-session/per-tab id anywhere else in this codebase to
  // key a finer-grained lock on.
  const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
  const MAX_RESERVATION_TTL_MS = 30 * 60 * 1000;

  function isReservationActive(reservation: any): boolean {
    return !!reservation && typeof reservation.expiresAt === "number" && reservation.expiresAt > Date.now();
  }

  // `robot.reservation` itself only ever held the CURRENT state -
  // overwritten by every claim/release with no trace of who changed it,
  // when, or why. reservationHistory is a real, bounded (last
  // RESERVATION_HISTORY_MAX_ENTRIES) append-only log living on the same
  // robot object, so it round-trips through the exact same persistence/
  // broadcast machinery `reservation` already does - no separate
  // endpoint or storage needed to read it back.
  const RESERVATION_HISTORY_MAX_ENTRIES = 20;

  function appendReservationHistory(
    robot: any,
    action: "claimed" | "renewed" | "force-claimed" | "released" | "force-released" | "expired",
    byUserId: unknown,
    byUsername: unknown,
    reason?: string,
  ) {
    if (!Array.isArray(robot.reservationHistory)) robot.reservationHistory = [];
    robot.reservationHistory.push({
      at: Date.now(),
      action,
      byUserId,
      byUsername,
      ...(reason ? { reason } : {}),
    });
    if (robot.reservationHistory.length > RESERVATION_HISTORY_MAX_ENTRIES) {
      robot.reservationHistory.splice(0, robot.reservationHistory.length - RESERVATION_HISTORY_MAX_ENTRIES);
    }
  }

  function stopServerPlayback(robotId: number) {
    const timer = playbackTimers.get(robotId);
    if (timer) {
      clearInterval(timer);
      playbackTimers.delete(robotId);
    }
  }

  // Called right after the 'play' case above sets robot.playbackState -
  // NOT from inside that forEach's own patch (this needs its own tick
  // loop, not a one-shot patch), but for the SAME robot.id each iteration
  // already covers - so calling this per-robot inside that same forEach
  // (self + every combinedWith sibling) is exactly the right fan-out,
  // reusing affectedIds's own existing combined-group handling rather
  // than duplicating it here.
  function startServerPlayback(robotId: number) {
    stopServerPlayback(robotId); // clean restart if a play was already running

    const robot = findRobotById(robotId);
    const controllerId = findControllerIdForRobot(robotId);
    if (!robot || !controllerId) return;

    if (!Array.isArray(robot.recordedPoints) || robot.recordedPoints.length === 0) {
      // Nothing to play - reflect that immediately instead of leaving
      // every client's UI on a "playing" state forever. Mutates the
      // EXISTING playbackState object's own fields rather than replacing
      // it with a new one (like every other case here does): the 'play'
      // case just above already captured `patch = { playbackState:
      // robot.playbackState }` as a reference to this same object before
      // calling this function, and the caller's own broadcastRobotDelta
      // still fires once, synchronously after this returns - a second,
      // separate broadcast from here (with a replaced object `patch`
      // would no longer even point at) would race it and could arrive in
      // either order.
      robot.playbackState.isPlaying = false;
      robot.playbackState.playing = false;
      robot.playbackState.activeStep = -1;
      return;
    }

    // Scales the same direction as STUDIO's own baseVelocity (higher
    // speed% = shorter interval = faster playback) without attempting
    // its real acceleration curve - a fixed per-point interval only.
    const speed = Number(robot.playbackState?.speed) || 100;
    const intervalMs = Math.max(50, PLAYBACK_BASE_INTERVAL_MS * (100 / speed));

    const timer = setInterval(() => {
      const r = findRobotById(robotId);
      const cId = findControllerIdForRobot(robotId);
      if (!r || !cId) {
        stopServerPlayback(robotId);
        return;
      }

      const pb = r.playbackState || {};
      if (!pb.isPlaying || pb.requestStop) {
        stopServerPlayback(robotId);
        return;
      }
      if (pb.isPaused || pb.requestPause) return; // keep the timer alive, just don't advance this tick

      const step = typeof pb.activeStep === "number" && pb.activeStep >= 0 ? pb.activeStep : 0;
      const points = r.recordedPoints;
      if (!Array.isArray(points) || step >= points.length) {
        if (pb.isLooping && Array.isArray(points) && points.length > 0) {
          // Repeat is on: go around again instead of stopping. Only
          // activeStep resets - isPlaying stays true so the SAME timer
          // keeps ticking and drives the next lap without a fresh 'play'
          // command (which would also re-resolve intervalMs from a
          // possibly-stale speed% for no reason).
          r.playbackState = { ...pb, activeStep: 0 };
          queueSettingsWrite(getSettings());
          broadcastRobotDelta([{ controllerId: cId, robotId, patch: { playbackState: r.playbackState } }], getSettings());
          return;
        }
        // Natural completion - isFinished used to be set ONLY by a
        // browser client's own playback loop reaching the end (see
        // RobotDetail.tsx's own isFinished comment); this engine is now
        // an equally real source of that same natural-completion signal.
        r.playbackState = { ...pb, isPlaying: false, playing: false, isFinished: true, finished: true, activeStep: -1 };
        queueSettingsWrite(getSettings());
        broadcastRobotDelta([{ controllerId: cId, robotId, patch: { playbackState: r.playbackState } }], getSettings());
        stopServerPlayback(robotId);
        return;
      }

      const rawPoint = points[step];
      // Compact model-specific WORKS may store [j1, j2, j3] triplets. They
      // retain the robot's current wrist values and bypass generic IK.
      const pt = Array.isArray(rawPoint)
        ? { motionType: "model-joints", j1: rawPoint[0], j2: rawPoint[1], j3: rawPoint[2] }
        : rawPoint;
      const patch: Record<string, unknown> = {};
      if (typeof pt.j1 === "number") {
        r.joints = { ...r.joints, j1: pt.j1, j2: pt.j2, j3: pt.j3, j4: pt.j4 ?? r.joints?.j4, j5: pt.j5 ?? r.joints?.j5, j6: pt.j6 ?? r.joints?.j6 };
        patch.joints = r.joints;
      }
      if (typeof pt.x === "number") {
        r.pos = {
          ...r.pos,
          x: pt.x, y: pt.y, z: pt.z,
          a: pt.a ?? r.pos?.a, b: pt.b ?? r.pos?.b, c: pt.c ?? r.pos?.c,
        };
        patch.pos = r.pos;
      }
      // Keep table axes separate from the arm target. The table's full object
      // is sent in the delta because clients shallow-merge it; `{ pos }`
      // alone would erase tableSize and other configuration remotely.
      //
      // Real bug found live on STUDIO/CM5: a combined robot with NO real
      // table (hasXYTable: false) still keeps its own stale `xyTable`
      // config object around (turning the table off in the UI only ever
      // flips the boolean, never clears the object - see
      // XYTableConfig.tsx) - `r.xyTable?.pos` alone was truthy for it
      // too. `pos.tx`/`pos.ty` also does double duty on a table-less
      // combined robot as its own general world-placement in the 3D
      // scene (VirtualKinematics.tsx) - so a stale recorded tx/ty from
      // before the table was disabled silently relocated that robot's
      // WHOLE 3D model, exactly reproducing "moving the table-having
      // robot also visually moves the combined one". Gated on the
      // robot's own real `hasXYTable` now, matching the same real fix
      // already applied to the jog/reset "xytable" target cases below.
      if (r.hasXYTable && (typeof pt.tx === "number" || typeof pt.ty === "number" || typeof pt.trz === "number")) {
        if (r.xyTable?.pos) {
          r.xyTable = {
            ...r.xyTable,
            pos: {
              ...r.xyTable.pos,
              ...(typeof pt.tx === "number" ? { x: pt.tx } : {}),
              ...(typeof pt.ty === "number" ? { y: pt.ty } : {}),
            },
          };
          patch.xyTable = r.xyTable;
        }
        r.pos = {
          ...r.pos,
          ...(typeof pt.tx === "number" ? { tx: pt.tx } : {}),
          ...(typeof pt.ty === "number" ? { ty: pt.ty } : {}),
          ...(typeof pt.trz === "number" ? { trz: pt.trz } : {}),
        };
        patch.pos = r.pos;
      }
      r.playbackState = {
        ...pb,
        activeStep: step + 1,
        trajectoryMode: pt.motionType === "model-joints" ? "model-joints" : (typeof pt.x === "number" ? "cartesian" : "legacy-generic"),
      };
      patch.playbackState = r.playbackState;

      queueSettingsWrite(getSettings());
      broadcastRobotDelta([{ controllerId: cId, robotId, patch }], getSettings());
    }, intervalMs);

    playbackTimers.set(robotId, timer);
  }


  return {
    findRobotById, findControllerIdForRobot, isReservationActive, appendReservationHistory,
    stopServerPlayback, startServerPlayback, DEFAULT_RESERVATION_TTL_MS, MAX_RESERVATION_TTL_MS,
  };
}
