// =============================================================================
// HYDRA-UMC-SERVER - P06 real command-ownership contract checks
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
// Real gap this closes: POST /api/robot/:id/command only ever checked
// "is this token valid", never "who else might already be commanding
// this exact robot" - any authenticated admin/operator could command
// any robot at any time, with no concept of exclusivity. Proves the new
// claim/release/command-rejection contract against two genuinely
// distinct authenticated accounts (not two tokens for the same one),
// the same real-server, no-browser-client pattern every other
// tools/verify_*_contract.mjs in this repo already uses.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_SOURCE = path.join(ROOT, "src", "server.ts");
const ADMIN = { username: "ownership-contract-admin", password: "ownership-contract-admin-password" };
const OPERATOR = { username: "ownership-contract-operator", password: "ownership-contract-operator-password" };

async function waitUntil(fn, { timeoutMs = 15000, intervalMs = 100, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(port) {
  await waitUntil(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/hydra-info`);
        return response.ok;
      } catch {
        return false;
      }
    },
    { message: "server to accept connections" },
  );
}

async function request(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function login(port, credentials) {
  const { response, body } = await request(port, "/api/login", { method: "POST", body: JSON.stringify(credentials) });
  assert.equal(response.status, 200, `login for ${credentials.username} failed: ${JSON.stringify(body)}`);
  return body.token;
}

function findRobot(settings, id) {
  for (const controller of settings.controllers ?? []) {
    const robot = controller.robots?.find((candidate) => candidate.id === id);
    if (robot) return robot;
  }
  throw new Error(`robot ${id} not found in returned settings`);
}

async function writeFixture(directory) {
  const settings = {
    settings: { serverName: "HYDRA-UMC ownership contract" },
    controllers: [{
      id: "ownership-controller",
      name: "Ownership Controller",
      robots: [{
        id: 1,
        name: "Robot A1",
        playbackState: { isPlaying: false, playing: false, isPaused: false, paused: false },
        recordedPoints: [],
      }],
    }],
  };
  await writeFile(path.join(directory, "data", "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

async function main() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "hydra-umc-server-ownership-"));
  const port = await reservePort();
  let child;
  let logs = "";
  try {
    await mkdir(path.join(temporaryDirectory, "data"), { recursive: true });
    await writeFixture(temporaryDirectory);
    child = spawn(process.execPath, [TSX_CLI, SERVER_SOURCE], {
      cwd: temporaryDirectory,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        JWT_SECRET: "local-ownership-contract-verification-only-not-for-deployment",
        HYDRA_UMC_BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        HYDRA_UMC_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    try {
      await waitForServer(port);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nServer startup output:\n${logs || "<no output>"}`);
    }

    const adminToken = await login(port, ADMIN);
    const adminAuth = { authorization: `Bearer ${adminToken}` };
    const createOperator = await request(port, "/api/users", {
      method: "POST", headers: adminAuth, body: JSON.stringify({ ...OPERATOR, role: "operator" }),
    });
    assert.equal(createOperator.response.status, 200, `operator creation failed: ${JSON.stringify(createOperator.body)}`);
    const operatorToken = await login(port, OPERATOR);
    const operatorAuth = { authorization: `Bearer ${operatorToken}` };

    // Before any claim, both real, distinct accounts can command freely.
    const preClaimCommand = await request(port, "/api/robot/1/command", {
      method: "POST", headers: operatorAuth, body: JSON.stringify({ command: "play" }),
    });
    assert.equal(preClaimCommand.response.status, 200, "an unclaimed robot must accept a command from anyone authenticated");

    // The operator claims the robot for real.
    const claim = await request(port, "/api/robot/1/claim", {
      method: "POST", headers: operatorAuth, body: JSON.stringify({ ttlMs: 60000 }),
    });
    assert.equal(claim.response.status, 200);
    assert.equal(claim.body.reservation.ownerUsername, OPERATOR.username);

    // A DIFFERENT real, authenticated account (the admin) is now refused
    // a normal command on that same robot - this is the real regression
    // this whole contract exists to close.
    const blockedCommand = await request(port, "/api/robot/1/command", {
      method: "POST", headers: adminAuth, body: JSON.stringify({ command: "pause" }),
    });
    assert.equal(blockedCommand.response.status, 409, "a robot claimed by someone else must reject a normal command");
    assert.match(blockedCommand.body.error, new RegExp(OPERATOR.username));

    // 'stop' is the one deliberate safety exception - never blockable by
    // someone else's claim, real or stale.
    const stopBypassesClaim = await request(port, "/api/robot/1/command", {
      method: "POST", headers: adminAuth, body: JSON.stringify({ command: "stop" }),
    });
    assert.equal(stopBypassesClaim.response.status, 200, "'stop' must never be blocked by another account's active claim");

    // The claim holder's own commands still succeed while it holds the claim.
    const ownCommandStillWorks = await request(port, "/api/robot/1/command", {
      method: "POST", headers: operatorAuth, body: JSON.stringify({ command: "play" }),
    });
    assert.equal(ownCommandStillWorks.response.status, 200, "the claim holder's own commands must still succeed");

    // A second, un-forced claim attempt by a different account is refused.
    const contestedClaim = await request(port, "/api/robot/1/claim", {
      method: "POST", headers: adminAuth, body: JSON.stringify({}),
    });
    assert.equal(contestedClaim.response.status, 409, "claiming an already-claimed robot must be refused without force");

    // A non-owner, non-admin release attempt is refused - the operator's
    // own claim survives it.
    const createSecondOperator = await request(port, "/api/users", {
      method: "POST", headers: adminAuth, body: JSON.stringify({ username: "ownership-contract-bystander", password: "ownership-contract-bystander-password", role: "operator" }),
    });
    assert.equal(createSecondOperator.response.status, 200);
    const bystanderToken = await login(port, { username: "ownership-contract-bystander", password: "ownership-contract-bystander-password" });
    const bystanderRelease = await request(port, "/api/robot/1/release", {
      method: "POST", headers: { authorization: `Bearer ${bystanderToken}` }, body: JSON.stringify({}),
    });
    assert.equal(bystanderRelease.response.status, 409, "only the claim holder or an admin may release a claim");

    // Admin can force-override an active claim held by someone else.
    const forcedClaim = await request(port, "/api/robot/1/claim", {
      method: "POST", headers: adminAuth, body: JSON.stringify({ force: true }),
    });
    assert.equal(forcedClaim.response.status, 200, "an admin with force:true must be able to override an active claim");
    assert.equal(forcedClaim.body.reservation.ownerUsername, ADMIN.username);

    // The original operator is now the one refused (roles reversed).
    const nowBlocked = await request(port, "/api/robot/1/command", {
      method: "POST", headers: operatorAuth, body: JSON.stringify({ command: "pause" }),
    });
    assert.equal(nowBlocked.response.status, 409, "the previous claim holder must now itself be blocked after a forced override");

    // Release, then confirm the robot is genuinely free again.
    const release = await request(port, "/api/robot/1/release", { method: "POST", headers: adminAuth, body: JSON.stringify({}) });
    assert.equal(release.response.status, 200);
    const freeAgain = await request(port, "/api/robot/1/command", {
      method: "POST", headers: operatorAuth, body: JSON.stringify({ command: "play" }),
    });
    assert.equal(freeAgain.response.status, 200, "a released robot must accept a command from anyone authenticated again");

    // Releasing an already-unclaimed robot is a safe, idempotent no-op.
    const idempotentRelease = await request(port, "/api/robot/1/release", { method: "POST", headers: adminAuth, body: JSON.stringify({}) });
    assert.equal(idempotentRelease.response.status, 200, "releasing an already-unclaimed robot must succeed, not error");

    // A real, expired claim (short TTL, waited out) never blocks a
    // command - an interruption in ownership must never look like a
    // permanent lock.
    const shortClaim = await request(port, "/api/robot/1/claim", {
      method: "POST", headers: operatorAuth, body: JSON.stringify({ ttlMs: 1000 }),
    });
    assert.equal(shortClaim.response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterExpiry = await request(port, "/api/robot/1/command", {
      method: "POST", headers: adminAuth, body: JSON.stringify({ command: "pause" }),
    });
    assert.equal(afterExpiry.response.status, 200, "an expired claim must never block a command");

    console.log("SERVER_ROBOT_OWNERSHIP_CONTRACT=PASS unclaimed=1 claim=1 blocked=1 stop_exception=1 own_command=1 contested_claim=1 non_owner_release=1 forced_override=1 release=1 idempotent_release=1 expiry=1");
  } finally {
    if (child) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
