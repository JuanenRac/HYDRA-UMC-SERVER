import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import jwt from "jsonwebtoken";
import { probeHttp } from "../src/ecosystemStatus.ts";
import { identityEnvSwitch, identityHeader, roleForMethod, serviceIdentityIdle, setServiceIdentitySwitch, signServiceToken, withIdentity } from "../src/serviceIdentity.ts";
import { upstreamHeaders } from "../src/upstreamAuth.ts";

// The calls this server makes to the services carry a short signed token of its own when the identity of the services is on.

const KEY = "k3y-for-the-tests-0123456789abcdefghijkl";
const ON = { HYDRA_UMC_SERVICE_IDENTITY: "1", JWT_SECRET: KEY };

afterEach(() => setServiceIdentitySwitch(null));

test("with the switch off nothing is signed and no header is added (the default)", () => {
  assert.equal(signServiceToken("viewer", { JWT_SECRET: KEY }), "");
  assert.deepEqual(identityHeader("viewer", { JWT_SECRET: KEY }), {});
  assert.equal(serviceIdentityIdle({ JWT_SECRET: KEY }), "off");
  assert.deepEqual(upstreamHeaders("vla-engine", { JWT_SECRET: KEY }), {});
  assert.deepEqual(withIdentity({ accept: "x" }, "viewer", { JWT_SECRET: KEY }), { accept: "x" });
});

test("the environment word: 1 on, 0 off, anything else says nothing", () => {
  assert.equal(identityEnvSwitch({ HYDRA_UMC_SERVICE_IDENTITY: "1" }), "on");
  assert.equal(identityEnvSwitch({ HYDRA_UMC_SERVICE_IDENTITY: "0" }), "off");
  assert.equal(identityEnvSwitch({ HYDRA_UMC_SERVICE_IDENTITY: "yes" }), null);
  assert.equal(identityEnvSwitch({}), null);
});

test("with the switch on the token is HS256, short-lived, and has the claims the services verify", () => {
  const now = 1_800_000_000;
  const token = signServiceToken("operator", ON, now);
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf-8"));
  assert.deepEqual(header, { alg: "HS256", typ: "JWT" });
  const claims = jwt.verify(token, KEY, { algorithms: ["HS256"], clockTimestamp: now }) as Record<string, unknown>;
  assert.deepEqual(claims, { username: "hydra-umc-server", role: "operator", exp: now + 60 });
  assert.throws(() => jwt.verify(token, KEY, { algorithms: ["HS256"], clockTimestamp: now + 61 }));
  assert.throws(() => jwt.verify(token, `${KEY}x`, { algorithms: ["HS256"] }));
});

test("no token is made with a key that is unset, an example value or too short", () => {
  for (const key of [undefined, "", "short", "hydra_industrial_secret_2026", "change-me-change-me-change-me-change-me", "a".repeat(40)]) {
    assert.equal(signServiceToken("viewer", { HYDRA_UMC_SERVICE_IDENTITY: "1", JWT_SECRET: key }), "", String(key));
  }
  assert.equal(serviceIdentityIdle({ HYDRA_UMC_SERVICE_IDENTITY: "1" }), "no_key");
  assert.equal(serviceIdentityIdle(ON), null);
});

test("the wired switch (the configuration of the server) wins over the environment word", () => {
  setServiceIdentitySwitch(() => false);
  assert.equal(signServiceToken("viewer", ON), "");
  setServiceIdentitySwitch(() => true);
  assert.notEqual(signServiceToken("viewer", { JWT_SECRET: KEY }), "");
});

test("a service with a token of its own keeps receiving it; the signed token fills the gap of the ones with none", () => {
  const own = upstreamHeaders("vla-engine", { ...ON, HYDRA_UMC_VLA_ENGINE_TOKEN: "own-token-of-the-service-1" });
  assert.deepEqual(own, { authorization: "Bearer own-token-of-the-service-1" });
  const filled = upstreamHeaders("vla-engine", ON, undefined, "operator");
  assert.match(filled.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal((jwt.decode(filled.authorization.slice(7)) as { role: string }).role, "operator");
  assert.equal((jwt.decode(upstreamHeaders("anything", ON).authorization.slice(7)) as { role: string }).role, "viewer");
});

test("a header bag that already has an Authorization is left as it is", () => {
  assert.deepEqual(withIdentity({ Authorization: "Bearer own" }, "viewer", ON), { Authorization: "Bearer own" });
  assert.match(withIdentity({ accept: "x" }, "viewer", ON).authorization, /^Bearer /);
});

test("a read needs a viewer and anything else an operator", () => {
  assert.equal(roleForMethod("GET"), "viewer");
  assert.equal(roleForMethod("head"), "viewer");
  assert.equal(roleForMethod("POST"), "operator");
  assert.equal(roleForMethod("DELETE"), "operator");
});

test("the health probe of the family presents the token to a service that is listening", async () => {
  setServiceIdentitySwitch(() => true);
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = KEY;
  const seen: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.statusCode = req.headers.authorization ? 200 : 401;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    assert.equal(await probeHttp(port, "/stats"), true);
    assert.match(seen[0] ?? "", /^Bearer /);
    setServiceIdentitySwitch(() => false);
    assert.equal(await probeHttp(port, "/stats"), false);
    assert.equal(seen[1], undefined);
  } finally {
    server.close();
    if (saved === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved;
  }
});
