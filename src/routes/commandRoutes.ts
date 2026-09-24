// =============================================================================
// HYDRA-UMC-SERVER - src/routes/commandRoutes.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// POST /api/robot/:id/command, moved out of server.ts unchanged. The settings
// object is reassigned inside startServer(), so it is passed as a getter that
// is read at the moment of use, exactly as the inline version read the
// variable.
import express from "express";
import { calculateJoints } from "../kinematics";
import { robotCommandsTotal } from "../metrics";

type Middleware = (req: any, res: any, next: any) => unknown;

export interface CommandRouteDeps {
  authenticate: Middleware;
  getSettings: () => any;
  industrialLog: (msg: string) => void;
  isReservationActive: (reservation: any) => boolean;
  queueSettingsWrite: (payload: any) => Promise<void>;
  broadcastRobotDelta: (
    deltas: { controllerId: string; robotId: number; patch: Record<string, unknown>; cameraId?: number; cameraPatch?: Record<string, unknown> }[],
    fullPayload: any,
  ) => void;
  startServerPlayback: (robotId: number) => void;
  stopServerPlayback: (robotId: number) => void;
}

export function registerCommandRoutes(app: express.Express, deps: CommandRouteDeps): void {
  const {
    authenticate,
    getSettings,
    industrialLog,
    isReservationActive,
    queueSettingsWrite,
    broadcastRobotDelta,
    startServerPlayback,
    stopServerPlayback,
  } = deps;

  // Direct Atomic API for Industrial Control
  app.post("/api/robot/:id/command", authenticate, async (req, res) => {
    const robotId = parseInt(req.params.id);
    const { command, params } = req.body;

    if (!getSettings().controllers) {
      return res.status(400).json({ error: "No settings loaded" });
    }

    let targetRobot: any = null;
    getSettings().controllers.forEach((c: any) => {
      const r = c.robots?.find((r: any) => r.id === robotId);
      if (r) targetRobot = r;
    });

    if (!targetRobot) {
      return res.status(404).json({ error: "Robot not found" });
    }

    // P06 (this project's own documented gap): command ownership. Any
    // authenticated admin/operator could command any robot - no
    // reservation, no generation, no exclusivity of any kind. "stop" is
    // deliberately exempt: a real emergency stop must never be blockable
    // by someone else's stale/forgotten claim. Every other command is
    // rejected with 409 when a different, still-active claim exists.
    const activeClaim = isReservationActive(targetRobot.reservation)
      ? targetRobot.reservation
      : null;
    if (activeClaim && activeClaim.ownerId !== (req as any).user.id && command !== "stop") {
      return res.status(409).json({
        error: `robot is claimed by ${activeClaim.ownerUsername}`,
        reservation: activeClaim,
      });
    }

    // A trajectory belongs to one robot. Unlike play/pause/stop, loading it
    // must not overwrite a combined sibling's independently selected Work.
    const affectedIds = command === "trajectory"
      ? [robotId]
      : [robotId, ...(targetRobot.combinedWith || [])];

    // Work loading used to be a browser-only change followed by the normal
    // 500 ms full-settings debounce. A Play click could therefore arrive at
    // Server first and replay the previous trajectory. Validate and prepare
    // the complete point list before touching state so "trajectory" is one
    // durable, broadcast atomic command like every other robot operation.
    let validatedTrajectory: Record<string, number | string>[] | undefined;
    let validatedWorkFile: string | undefined;
    let validatedExample: string | undefined;
    if (command === "trajectory") {
      const rawPoints = params?.points;
      const numericFields = ["j1", "j2", "j3", "j4", "j5", "j6", "x", "y", "z", "a", "b", "c", "tx", "ty", "trz"];
      if (!Array.isArray(rawPoints) || rawPoints.length === 0 || rawPoints.length > 10000) {
        return res.status(400).json({ error: "trajectory requires between 1 and 10000 points" });
      }
      try {
        validatedTrajectory = rawPoints.map((rawPoint: unknown) => {
          if (!rawPoint || typeof rawPoint !== "object" || Array.isArray(rawPoint)) {
            throw new Error("each trajectory point must be an object");
          }
          const point = rawPoint as Record<string, unknown>;
          const clean: Record<string, number | string> = {};
          for (const field of numericFields) {
            if (point[field] === undefined) continue;
            if (typeof point[field] !== "number" || !Number.isFinite(point[field])) {
              throw new Error(`trajectory ${field} must be finite`);
            }
            clean[field] = point[field];
          }
          if (point.motionType !== undefined) {
            if (point.motionType !== "model-joints") throw new Error("unsupported trajectory motionType");
            clean.motionType = "model-joints";
          }
          const hasNativeJoints = ["j1", "j2", "j3", "j4", "j5", "j6"].every((field) => typeof clean[field] === "number");
          const hasCartesianPose = ["x", "y", "z"].every((field) => typeof clean[field] === "number");
          if (!hasNativeJoints && !hasCartesianPose) {
            throw new Error("trajectory point requires native joints or x/y/z");
          }
          return clean;
        });
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : "invalid trajectory" });
      }
      // tx/ty belong to an XY table, never to the arm's own Cartesian target.
      // Refuse a table path for a robot without a configured table instead of
      // silently replaying only its arm points and corrupting the example.
      const hasTableAxes = validatedTrajectory.some((point) =>
        ["tx", "ty", "trz"].some((field) => typeof point[field] === "number"),
      );
      if (hasTableAxes && (!targetRobot.hasXYTable || !targetRobot.xyTable?.pos)) {
        return res.status(400).json({ error: "trajectory table axes require a configured XY table" });
      }
      if (params?.selectedWorkFile !== undefined) {
        if (typeof params.selectedWorkFile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(params.selectedWorkFile)) {
          return res.status(400).json({ error: "selectedWorkFile must be a safe .json file name" });
        }
        validatedWorkFile = params.selectedWorkFile;
      }
      if (params?.selectedExample !== undefined) {
        if (typeof params.selectedExample !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(params.selectedExample)) {
          return res.status(400).json({ error: "selectedExample must be a safe example id" });
        }
        validatedExample = params.selectedExample;
      }
    }
    // Resolve pause once from the command target. Applying `!isPaused` to
    // each member separately lets a stale combined pair (for example A1/A2)
    // end in opposite states; every client must receive one desired group
    // state instead. Older clients that send no parameter retain toggle UX.
    const requestedPause = typeof params?.paused === "boolean"
      ? params.paused
      : !Boolean(targetRobot.playbackState?.isPaused ?? targetRobot.playbackState?.paused);

    // One entry per affected robot this command actually mutated - built
    // FROM the same validated switch/case below as it runs, never from a
    // before/after diff of the tree.
    // Feeds broadcastRobotDelta() below so a schema-2 client gets this
    // small targeted patch instead of the full tree.
    const deltas: { controllerId: string; robotId: number; patch: Record<string, unknown>; cameraId?: number; cameraPatch?: Record<string, unknown> }[] = [];

    // Real, per-robot record of a setpoint this command tried to
    // apply but couldn't because it fell outside a documented limit - see
    // the "speed" case below. Never affects `success`/affectedCount (this
    // is about a still-valid request where one field's value was
    // rejected, not about the request itself failing); a caller that
    // never reads this new field sees the exact same response shape as
    // before.
    const warnings: { robotId: number; field: string; requested: unknown; message: string }[] = [];

    getSettings().controllers.forEach((controller: any) => {
      controller.robots?.forEach((robot: any) => {
        if (affectedIds.includes(robot.id)) {
          let patch: Record<string, unknown> | null = null;
          let cameraId: number | undefined;
          let cameraPatch: Record<string, unknown> | undefined;
          switch (command) {
            case "stop":
              // isFinished/finished reset here too, not just isPlaying/
              // activeStep/isPaused - every one of the 6 clients' own LOCAL
              // optimistic "stop" mutation already does this (STUDIO's own
              // RobotDetail.tsx handleStop, Android's HydraState.kt stop(),
              // iOS/DSI's RobotView.stop()), on the assumption that a
              // manual stop always clears a stale "job finished
              // successfully" flag from a previous run - this case just
              // never actually matched that assumption itself. Harmless
              // while every client trusted only its own optimistic
              // mutation and never round-tripped this value back from here,
              // but a real bug once a client starts treating this
              // endpoint's own patch as authoritative: without this, a
              // robot that finished a job once, then gets manually stopped
              // after being replayed, could show a stale "completed
              // successfully" notification/badge again once this patch's
              // own isFinished (silently still true) lands.
              robot.playbackState = { ...robot.playbackState, isPlaying: false, playing: false, activeStep: -1, isPaused: false, paused: false, requestPause: false, requestStop: true, isFinished: false, finished: false };
              patch = { playbackState: robot.playbackState };
              // Stops this robot's own V0 server-side playback timer (see
              // startServerPlayback's own header comment) immediately
              // rather than waiting for its next tick to notice
              // requestStop - a manual stop should feel instant.
              stopServerPlayback(robot.id);
              break;
            case "play":
              // See "stop" case's own comment just above - same gap, same fix.
              robot.playbackState = { ...robot.playbackState, isPlaying: true, playing: true, activeStep: 0, isPaused: false, paused: false, requestPause: false, requestStop: false, isFinished: false, finished: false };
              patch = { playbackState: robot.playbackState };
              // Starts this robot's own V0 server-side playback timer -
              // see startServerPlayback's own header comment for why this
              // exists and what it deliberately doesn't attempt yet.
              startServerPlayback(robot.id);
              break;
            case "pause":
              robot.playbackState = { ...robot.playbackState, isPlaying: true, playing: true, isPaused: requestedPause, paused: requestedPause, requestPause: requestedPause, requestStop: false, isFinished: false, finished: false };
              patch = { playbackState: robot.playbackState };
              break;
            case "jog": {
              // Axis allowlisted against the real Position shape
              // (kinematics.ts's own {x,y,z,a,b,c}) - params.axis is
              // caller-controlled and used directly as an object key on
              // robot.pos. Investigated as a possible prototype-pollution
              // vector (found in an external review): NOT exploitable as
              // written even before this fix (JS's own `__proto__` setter
              // silently ignores a non-object assignment, and `+=` here
              // always produces a number/string, never an object) - but an
              // unvalidated axis string could still write an arbitrary new
              // property onto robot.pos (e.g. from a buggy/malformed
              // client) that then gets persisted to settings.json and
              // broadcast to every other client. Allowlisting is a cheap,
              // real correctness fix independent of the pollution
              // question, and matches the typeof-checked style every
              // other case below (valve/pump/speed) already uses.
              const ROBOT_AXES = new Set(["x", "y", "z", "a", "b", "c"]);
              const JOINT_KEYS = ["j1", "j2", "j3", "j4", "j5", "j6"];
              // Finite + bounded, not just typeof "number": a caller could send
              // NaN/Infinity - both pass `typeof === "number"` - or an
              // absurd single-command delta like 1e9). STUDIO's own largest
              // JOG_STEP_OPTIONS entry is 100 (RobotDetail.tsx), so a single
              // real jog command from any real client never needs an
              // |amount| anywhere near this cap - 1000 is 10x headroom for
              // legitimate use while still refusing to yank a real,
              // physical robot toward an extreme position from one
              // malformed/malicious atomic command.
              const MAX_JOG_AMOUNT = 1000;
              const validAmount = typeof params?.amount === "number" && Number.isFinite(params.amount) && Math.abs(params.amount) <= MAX_JOG_AMOUNT;
              // STUDIO's own XY-table position sliders (RobotDetail.tsx,
              // handleXYAxisChange) drag to an exact target position, not a
              // relative nudge like the joystick/D-pad callers of this same
              // case - `absolute: true` sets the axis to `amount` instead of
              // adding it, reusing this case's existing validation/patch/
              // broadcast plumbing instead of a bespoke command. Those
              // sliders used to call updateRobot() directly (the
              // optimistic-local + 500ms-debounced-full-tree-save path,
              // which never broadcasts to any OTHER connected client) -
              // real feedback from live testing: dragging the XY table from
              // one client never appeared on another.
              const isAbsolute = params?.absolute === true;
              if (typeof params?.axis === "string" && ROBOT_AXES.has(params.axis) && validAmount) {
                const target = params.target || "robot";
                if (target === "robot") {
                  robot.pos[params.axis] = isAbsolute ? params.amount : robot.pos[params.axis] + params.amount;
                  // An optional, client-supplied joints override -
                  // HYDRA-UMC-STUDIO's own browser UI resolves jog targets
                  // through resolveTargetJoints(), a PER-MODEL inverse-
                  // kinematics solver (Parol6/Faze4/AR3/AR4/UR3e/... each
                  // have real, different kinematic chains) - calculateJoints()
                  // right below is a single generic IK formula that doesn't
                  // know about any of that, so blindly recomputing joints
                  // server-side for a STUDIO-originated jog would silently
                  // diverge from what that same client already shows in its
                  // own 3D viewport for most models. This is the
                  // SAME trust level STUDIO's joints already had under the
                  // full-tree POST /api/settings path it used before this
                  // atomic command existed - not a new attack surface, just
                  // the same client-authoritative value taking a smaller
                  // door in. Validated as 6 finite numbers, one per real
                  // joint name, before being trusted; anything else (a
                  // client that doesn't send it - Android/iOS/DSI/SUITE
                  // never do - or sends something malformed) falls through
                  // to calculateJoints() exactly like before this existed.
                  const j = params?.joints;
                  const hasValidJoints = j && typeof j === "object" && JOINT_KEYS.every((k) => typeof j[k] === "number" && Number.isFinite(j[k]));
                  robot.joints = hasValidJoints ? { j1: j.j1, j2: j.j2, j3: j.j3, j4: j.j4, j5: j.j5, j6: j.j6 } : calculateJoints(robot.pos);
                  patch = { pos: robot.pos, joints: robot.joints };
                } else if (target === "xytable" && robot.hasXYTable && robot.xyTable) {
                  const axis = params.axis === "x" ? "x" : (params.axis === "y" ? "y" : null);
                  if (axis) {
                    robot.xyTable.pos[axis] = isAbsolute ? params.amount : robot.xyTable.pos[axis] + params.amount;
                    // STUDIO's clients also keep a second, older
                    // representation of this same position on robot.pos.tx/
                    // ty (see handleXYAxisChange/XYTableOverlay) - only the
                    // absolute (slider) callers ever touch it, matching
                    // what those client call sites already did before this
                    // fix; the joystick/D-pad's relative jog never has.
                    if (isAbsolute) {
                      robot.pos[axis === "x" ? "tx" : "ty"] = params.amount;
                    }
                    // The FULL xyTable object, not just { pos: ... } - every
                    // client's own delta-merge (STUDIO's applyRobotDelta in
                    // store.tsx, Android's RobotViewModel.onDelta, iOS/DSI's
                    // equivalents) applies a patch as a SHALLOW top-level-key
                    // replace ({ ...robot, ...patch }, or the JSONObject
                    // equivalent) - a patch of just { xyTable: { pos } }
                    // replaced the receiving client's ENTIRE xyTable object
                    // with just that pos, silently deleting tableSize/
                    // worldPos/renderScale/worldRot. STUDIO's own
                    // VirtualKinematics.tsx then dereferenced
                    // xyTable.tableSize.width with no null-guard - a real,
                    // reproducible crash-to-blank-page on every OTHER
                    // connected client the instant anyone jogged an XY
                    // table, not a hypothetical: this is the confirmed root
                    // cause of the "moved the XY table from the Android app
                    // while STUDIO was open - STUDIO went blank and the app
                    // crashed" report. Sending the complete object here
                    // means a shallow merge on the receiving end reconstructs
                    // the exact same xyTable instead of an amputated one.
                    // pos also included, but only for the absolute case -
                    // that's the only branch that touches robot.pos.tx/ty
                    // above, same reasoning as that comment.
                    patch = isAbsolute ? { xyTable: robot.xyTable, pos: robot.pos } : { xyTable: robot.xyTable };
                  }
                }
              }
              break;
            }
            // Absolute pose reset ("HOME"/"RESET"/"HOME XY" on every
            // client) - was each client's own updateRobot()/settings-save
            // call, which never broadcasts to any OTHER connected client
            // (a second STUDIO window, or the Android app's own embedded
            // WebView copy of the same page). Real feedback from live
            // testing: a reset on one client silently never appeared on
            // another, in either direction. target === "robot" (default)
            // resets pos+joints to home; target === "xytable" resets only
            // xyTable.pos + pos.tx/ty, leaving the arm's own pose alone -
            // same target convention the "jog" case above already uses.
            case "reset": {
              const target = params?.target === "xytable" ? "xytable" : "robot";
              if (target === "robot") {
                robot.pos = { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, tx: robot.pos?.tx, ty: robot.pos?.ty, trz: robot.pos?.trz };
                // Same client-supplied-joints trust level as "jog" above
                // (see that case's own comment) - the server has no
                // per-model IK of its own, so a caller-supplied home pose
                // (STUDIO's homePoseFor(robot.model)) is validated and
                // trusted the same way; calculateJoints() is the fallback
                // for any caller that doesn't send one.
                const JOINT_KEYS_RESET = ["j1", "j2", "j3", "j4", "j5", "j6"];
                const j = params?.joints;
                const hasValidJoints = j && typeof j === "object" && JOINT_KEYS_RESET.every((k) => typeof j[k] === "number" && Number.isFinite(j[k]));
                robot.joints = hasValidJoints ? { j1: j.j1, j2: j.j2, j3: j.j3, j4: j.j4, j5: j.j5, j6: j.j6 } : calculateJoints(robot.pos);
                patch = { pos: robot.pos, joints: robot.joints };
              } else if (robot.hasXYTable && robot.xyTable) {
                robot.pos = { ...robot.pos, tx: 0, ty: 0 };
                robot.xyTable.pos = { x: 0, y: 0 };
                patch = { pos: robot.pos, xyTable: robot.xyTable };
              }
              break;
            }
            // Real, server-synced jog step (STUDIO's RobotDetail.tsx
            // jogStep, Android's own FilterChip rows) - was
            // component-local on every client, so the step shown/used on
            // one never matched another. Bounded the same way "speed"
            // below is: a real jog step never needs to be 0/negative/huge,
            // and this value feeds directly into the next jog's amount
            // calculation on whichever client sends it.
            case "jogStep":
              if (typeof params?.value === "number" && Number.isFinite(params.value) && params.value > 0 && params.value <= 1000) {
                robot.jogStep = params.value;
                patch = { jogStep: robot.jogStep };
              }
              break;
            // "RESET 3D" only ever remounts the PRESSING client's own 3D
            // camera view (no real robot motion/state involved) - bumping
            // this timestamp and broadcasting it is only a signal for
            // every other connected client's own effect to remount their
            // own local camera view the same way, matching this robot's
            // own centerCameraTrigger precedent just above it.
            case "reset3D":
              robot.reset3DTrigger = Date.now();
              patch = { reset3DTrigger: robot.reset3DTrigger };
              break;
            case "tool":
              if (params?.tool) {
                robot.tool = params.tool;
                patch = { tool: robot.tool };
              }
              break;
            case "valve":
              if (typeof params?.index === "number" && typeof params?.state === "boolean") {
                if (!robot.valves) robot.valves = [false, false];
                robot.valves[params.index] = params.state;
                patch = { valves: robot.valves };
              }
              break;
            case "pump":
              if (typeof params?.index === "number" && typeof params?.state === "boolean") {
                if (!robot.pumps) robot.pumps = [false, false];
                robot.pumps[params.index] = params.state;
                patch = { pumps: robot.pumps };
              }
              break;
            case "speed": {
              // Bounded to STUDIO's own RotaryKnob/FuturisticSlider range
              // for both fields (RobotDetail.tsx: min={10} max={500}) -
              // `typeof === "number"` alone (the only check here before
              // this fix) let a caller push NaN/Infinity/a negative value
              // straight into playbackState.speed, from where it feeds the
              // real motion-profile math on every subsequent jog/playback
              // step.
              const validSpeedField = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 10 && v <= 500;
              let touched = false;
              // A rejected setpoint used to be indistinguishable from
              // one that was simply never sent - the response's own
              // `success: true` never said WHY playbackState.speed/
              // acceleration didn't change, so an out-of-range value from
              // a buggy client (or a future STUDIO range that drifts out of
              // sync with this endpoint's own 10-500) looked identical to a
              // real success. `warnings` records the real clip reason per
              // robot instead of discarding it.
              if (params?.speed !== undefined) {
                if (validSpeedField(params.speed)) {
                  if (!robot.playbackState) robot.playbackState = { isPlaying: false, activeStep: 0, speed: 100 };
                  robot.playbackState.speed = params.speed;
                  touched = true;
                } else {
                  warnings.push({
                    robotId: robot.id,
                    field: "speed",
                    requested: params.speed,
                    message: `speed ${JSON.stringify(params.speed)} is outside the allowed range (10-500) - setpoint was not applied`,
                  });
                }
              }
              if (params?.acceleration !== undefined) {
                if (validSpeedField(params.acceleration)) {
                  if (!robot.playbackState) robot.playbackState = { isPlaying: false, activeStep: 0, speed: 100 };
                  robot.playbackState.acceleration = params.acceleration;
                  touched = true;
                } else {
                  warnings.push({
                    robotId: robot.id,
                    field: "acceleration",
                    requested: params.acceleration,
                    message: `acceleration ${JSON.stringify(params.acceleration)} is outside the allowed range (10-500) - setpoint was not applied`,
                  });
                }
              }
              if (touched) patch = { playbackState: robot.playbackState };
              break;
            }
            case "trajectory":
              // validatedTrajectory exists because the endpoint validates it
              // before iterating controllers. Reset the playback cursor so a
              // subsequent Play always starts this newly selected Work.
              robot.recordedPoints = validatedTrajectory;
              if (validatedWorkFile !== undefined) robot.selectedWorkFile = validatedWorkFile;
              if (validatedExample !== undefined) robot.selectedExample = validatedExample;
              robot.playbackState = {
                ...robot.playbackState,
                isPlaying: false,
                playing: false,
                isPaused: false,
                paused: false,
                requestPause: false,
                requestStop: false,
                activeStep: -1,
                isFinished: false,
                finished: false,
              };
              patch = {
                recordedPoints: robot.recordedPoints,
                ...(validatedWorkFile !== undefined ? { selectedWorkFile: robot.selectedWorkFile } : {}),
                ...(validatedExample !== undefined ? { selectedExample: robot.selectedExample } : {}),
                playbackState: robot.playbackState,
              };
              break;
            // Lets a remote client (the Android app's own Camera
            // screen) toggle a robot's vision system without a full
            // POST /api/settings overwrite - mirrors the same 2 fields
            // src/Dashboard.tsx's OverviewPanel already writes locally
            // (visionEnabled on the robot, connected on its paired camera entry).
            case "vision":
              if (typeof params?.enabled === "boolean") {
                robot.visionEnabled = params.enabled;
                if (robot.camera && typeof robot.camera === "object") {
                  robot.camera.connected = params.enabled;
                }
                patch = robot.camera && typeof robot.camera === "object"
                  ? { visionEnabled: robot.visionEnabled, camera: robot.camera }
                  : { visionEnabled: robot.visionEnabled };
                const cam = (controller.cameras || []).find((c: any) => c.assignedRobotId === robot.id || c.id === robot.id);
                if (cam) {
                  cam.connected = params.enabled;
                  cameraId = cam.id;
                  cameraPatch = { connected: cam.connected };
                }
              }
              break;
          }
          if (patch) deltas.push({ controllerId: controller.id, robotId: robot.id, patch, cameraId, cameraPatch });
        }
      });
    });

    industrialLog(`Command: ${command} on Robot ${robotId}`);

    // Counted once per REQUEST (this endpoint may fan a single command out
    // to several combined robots via affectedIds above, but that's still
    // one command received) - "unknown" for anything the switch above
    // doesn't recognize, same as an unhandled case there falls through
    // with no effect. src/metrics.ts's own hydra_robot_commands_total,
    // exposed on GET /metrics.
    robotCommandsTotal.inc({ command: typeof command === "string" ? command : "unknown" });

    await queueSettingsWrite(getSettings());
    broadcastRobotDelta(deltas, getSettings());
    res.json({
      success: true,
      affectedCount: affectedIds.length,
      ...(warnings.length ? { warnings } : {}),
    });
  });
}
