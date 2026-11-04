// =============================================================================
// HYDRA-UMC-SERVER - src/commandLifecycle.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// What the server says about one robot command after it accepted it, in the closed shapes of the
// `CommandLifecycleEvent` and `Operation` contracts of the SDK.
//
// The server owns a command from the moment it validated and applied it: that is the state ACCEPTED, and it is
// the only state the server can vouch for by itself. RUNNING, COMPLETED, FAILED and CANCELLED need a controller
// that reports it (a COMPLETED without evidence that the controller carried the command out would be a lie), so
// they are built here too, for the day a controller reports, but nothing in this server emits them yet.
import { randomUUID } from "node:crypto";

export type CommandState = "ACCEPTED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface CommandLifecycleEvent {
  schema_version: "1.0";
  operation_id: string;
  robot_id: string;
  command: string;
  state: CommandState;
  at_utc: string;
  sequence: number;
  reason?: string;
}

export interface CommandOperation {
  schema_version: "1.0";
  operation_id: string;
  correlation_id: string;
  kind: "robot.command";
  target: { kind: "robot"; id: string };
  status: "authorized";
  requested_at_utc: string;
  updated_at_utc: string;
  params: { command: string };
}

const ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** A new operation id: unique, and inside the pattern of the contract. */
export function newOperationId(): string {
  return `cmd-${randomUUID()}`;
}

/** The correlation id the caller chose (header X-Correlation-Id) when it fits the contract pattern, else the operation id itself. */
export function correlationFor(header: unknown, operationId: string): string {
  return typeof header === "string" && ID.test(header) ? header : operationId;
}

/** The first event of a command: the server accepted it and owns it. */
export function acceptedEvent(operationId: string, robotId: number | string, command: string, now: Date = new Date()): CommandLifecycleEvent {
  return {
    schema_version: "1.0",
    operation_id: operationId,
    robot_id: String(robotId),
    command,
    state: "ACCEPTED",
    at_utc: now.toISOString(),
    sequence: 1,
  };
}

/** The event after `previous`: the sequence grows by one; FAILED and CANCELLED must say why. */
export function nextEvent(previous: CommandLifecycleEvent, state: Exclude<CommandState, "ACCEPTED">, reason?: string, now: Date = new Date()): CommandLifecycleEvent {
  if ((state === "FAILED" || state === "CANCELLED") && !(typeof reason === "string" && reason.length >= 1)) {
    throw new Error(`the state ${state} needs a reason`);
  }
  const event: CommandLifecycleEvent = { ...previous, state, at_utc: now.toISOString(), sequence: previous.sequence + 1 };
  delete event.reason;
  if (reason !== undefined) event.reason = reason.slice(0, 200);
  return event;
}

/** The Operation that carries the command. Its status is `authorized`: the account may command the robot and the server applied the command. */
export function commandOperation(operationId: string, correlationId: string, robotId: number | string, command: string, now: Date = new Date()): CommandOperation {
  const at = now.toISOString();
  return {
    schema_version: "1.0",
    operation_id: operationId,
    correlation_id: correlationId,
    kind: "robot.command",
    target: { kind: "robot", id: String(robotId) },
    status: "authorized",
    requested_at_utc: at,
    updated_at_utc: at,
    params: { command },
  };
}
