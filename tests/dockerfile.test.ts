import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// The image of the server for the container bench: it runs as a user that is not root, has a health check, keeps every secret out of the image and
// copies in nothing of the local data folder.

const root = process.cwd();
const dockerfile = fs.readFileSync(path.join(root, "scripts", "Dockerfile"), "utf8").replace(/\r\n/g, "\n");
const instructions = dockerfile.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
const ignored = fs.readFileSync(path.join(root, ".dockerignore"), "utf8").split(/\r?\n/).map((line) => line.trim());

test("the last stage runs as a user that is not root", () => {
  const lastStage = instructions.slice(instructions.map((line) => line.startsWith("FROM ")).lastIndexOf(true));
  const users = lastStage.filter((line) => line.startsWith("USER "));
  assert.equal(users.length, 1);
  assert.equal(users[0], "USER node");
  assert.ok(lastStage.indexOf(users[0]) > lastStage.findIndex((line) => line.startsWith("RUN mkdir")), "the folder of the data is made and handed over before the user changes");
});

test("it has a health check on the route that answers without a token, and starts the bundle", () => {
  assert.ok(instructions.some((line) => line.startsWith("HEALTHCHECK ")));
  assert.match(dockerfile, /\/api\/hydra-info/);
  assert.ok(instructions.includes('CMD ["node", "dist/server.cjs"]'));
});

test("no secret is set in the image: the signing key and the first administrator come when the container starts", () => {
  for (const line of instructions) {
    assert.doesNotMatch(line, /^(ENV|ARG)\b.*(JWT_SECRET|PASSWORD|TOKEN|SECRET|KEY)/i, line);
  }
  assert.doesNotMatch(dockerfile, /^COPY .*\b(\.env|data|\.pem|\.key)\b/m);
});

test("the build installs from the lock file and the run stage has only the production dependencies", () => {
  assert.ok(instructions.some((line) => line.startsWith("RUN npm ci")));
  assert.ok(instructions.some((line) => line.includes("npm prune --omit=dev")));
});

test(".dockerignore keeps the local data, the logs, the dependencies and the keys out of the build", () => {
  for (const entry of ["data", "node_modules", "dist", ".env", "*.pem", "*.key", ".git"]) {
    assert.ok(ignored.includes(entry), `${entry} is not ignored`);
  }
});
