import assert from "node:assert/strict";
import { test } from "node:test";
import { requireOperator } from "../src/auth.ts";
import { isWriteToModel, registerLocalAiRoutes } from "../src/routes/localAiRoutes.ts";
import { bearerHeader, configuredUpstreamTokens, resolveToken, tokenForService, upstreamHeaders } from "../src/upstreamAuth.ts";

const files: Record<string, string> = {
  "/run/secrets/vla": "file-token-for-vla-engine\nsecond line is ignored\n",
  "/run/secrets/empty": "\n",
};
const read = (path: string) => {
  if (!(path in files)) throw new Error("ENOENT");
  return files[path];
};

test("a service with no token configured gets no header", () => {
  assert.equal(tokenForService("vla-engine", {}, read), "");
  assert.deepEqual(upstreamHeaders("vla-engine", {}, read), {});
});

test("the token comes from the variable the service itself reads", () => {
  assert.equal(tokenForService("vla-engine", { HYDRA_UMC_VLA_ENGINE_TOKEN: " a-token-of-some-length " }, read), "a-token-of-some-length");
  assert.deepEqual(upstreamHeaders("visual-servoing-api", { HYDRA_UMC_VISUAL_SERVOING_TOKEN: "visual-token-123456" }, read), { authorization: "Bearer visual-token-123456" });
  assert.equal(tokenForService("vision-streamer", { HYDRA_UMC_VISION_STREAMER_TOKEN: "streamer-token-1234" }, read), "streamer-token-1234");
  assert.equal(tokenForService("anomaly-detector", { HYDRA_UMC_ANOMALY_TOKEN: "anomaly-token-12345" }, read), "anomaly-token-12345");
});

test("or from a file named by the variable with _FILE, first line only", () => {
  assert.equal(tokenForService("vla-engine", { HYDRA_UMC_VLA_ENGINE_TOKEN_FILE: "/run/secrets/vla" }, read), "file-token-for-vla-engine");
});

test("the variable wins over the file, and an empty or missing file is no token", () => {
  assert.equal(tokenForService("vla-engine", { HYDRA_UMC_VLA_ENGINE_TOKEN: "from-the-variable-1", HYDRA_UMC_VLA_ENGINE_TOKEN_FILE: "/run/secrets/vla" }, read), "from-the-variable-1");
  assert.equal(tokenForService("vla-engine", { HYDRA_UMC_VLA_ENGINE_TOKEN_FILE: "/run/secrets/empty" }, read), "");
  assert.equal(tokenForService("vla-engine", { HYDRA_UMC_VLA_ENGINE_TOKEN_FILE: "/run/secrets/missing" }, read), "");
});

test("the data lake presents its read token, else the one for every role", () => {
  assert.equal(tokenForService("datalake", { HYDRA_UMC_DATALAKE_READ_TOKEN: "read-token-1234567", HYDRA_UMC_DATALAKE_TOKEN: "shared-token-12345" }, read), "read-token-1234567");
  assert.equal(tokenForService("datalake", { HYDRA_UMC_DATALAKE_TOKEN: "shared-token-12345" }, read), "shared-token-12345");
  assert.equal(tokenForService("datalake", { HYDRA_UMC_DATALAKE_ADMIN_TOKEN: "admin-only-token-12" }, read), "");
});

test("an unknown service has no token", () => {
  assert.equal(tokenForService("not-a-service", { HYDRA_UMC_VLA_ENGINE_TOKEN: "x".repeat(20) }, read), "");
});

test("a token that could split a header is never sent", () => {
  assert.deepEqual(bearerHeader("good\r\nX-Evil: 1"), {});
  assert.deepEqual(bearerHeader("tab\there"), {});
  assert.deepEqual(bearerHeader(""), {});
  assert.deepEqual(bearerHeader("fine-token-12345678"), { authorization: "Bearer fine-token-12345678" });
});

test("the status of the installation says which tokens exist and never what they are", () => {
  const status = configuredUpstreamTokens({ HYDRA_UMC_VLA_ENGINE_TOKEN: "x".repeat(20) }, read);
  assert.equal(status["vla-engine"], true);
  assert.equal(status["vision-streamer"], false);
  assert.ok(!JSON.stringify(status).includes("xxxx"));
});

test("resolveToken tries the variables in order", () => {
  assert.equal(resolveToken(["A", "B"], { B: "second" }, read), "second");
  assert.equal(resolveToken(["A", "B"], { A: "first", B: "second" }, read), "first");
  assert.equal(resolveToken([], {}, read), "");
});

function run(gate: any, user: any) {
  let status = 200;
  let passed = false;
  const res: any = { status(code: number) { status = code; return res; }, json() { return res; } };
  gate({ user }, res, () => { passed = true; });
  return { status, passed };
}

test("only an administrator or an operator passes requireOperator", () => {
  assert.deepEqual(run(requireOperator, { role: "admin" }), { status: 200, passed: true });
  assert.deepEqual(run(requireOperator, { role: "operator" }), { status: 200, passed: true });
  assert.deepEqual(run(requireOperator, { role: "viewer" }), { status: 403, passed: false });
  assert.deepEqual(run(requireOperator, { role: undefined }), { status: 403, passed: false });
  assert.deepEqual(run(requireOperator, undefined), { status: 403, passed: false });
});

test("the relay refuses a session whose role is neither, whatever the access setting", () => {
  let chain: any[] = [];
  const app: any = { all(route: string, ...handlers: any[]) { if (route.startsWith("/api/ai/")) chain = handlers; } };
  const requireAdmin = (_req: any, res: any) => { res.status(403).json({}); };
  registerLocalAiRoutes(app, { authenticate: () => undefined, requireAdmin, requireOperator, adminOnly: false } as any);
  assert.deepEqual(run(chain[1], { role: "operator" }), { status: 200, passed: true });
  assert.deepEqual(run(chain[1], { role: "admin" }), { status: 200, passed: true });
  assert.deepEqual(run(chain[1], { role: "guest" }), { status: 403, passed: false });
});

test("the writes that shape the anomaly baseline are for administrators", () => {
  assert.equal(isWriteToModel("anomaly-detector", "POST", "/baseline/fit"), true);
  assert.equal(isWriteToModel("anomaly-detector", "POST", "/drift/init"), true);
  assert.equal(isWriteToModel("anomaly-detector", "POST", "/drift/observe"), true);
  assert.equal(isWriteToModel("anomaly-detector", "POST", "/detect"), false);
  assert.equal(isWriteToModel("anomaly-detector", "GET", "/stats"), false);
  assert.equal(isWriteToModel("vla-engine", "POST", "/tokens/encode"), false);
});
