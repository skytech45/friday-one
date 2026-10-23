import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";

// Minimal reproduction of the auth decorators from index.ts to test
// that unauthenticated → 401 and authenticated-but-untrusted → 403.
// We do NOT import the real server (it needs DATABASE_URL and pg).

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(jwt, {
    secret: "test-secret-for-pathjail-auth-tests-only",
  });

  // Mirrors index.ts authenticate decorator
  app.decorate("authenticate", async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  // Mirrors index.ts authenticateTrusted but without real DB.
  // Uses an in-memory set of trusted device IDs for testing.
  const trustedDevices = new Set<string>(["device-trusted-1"]);

  app.decorate("authenticateTrusted", async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const did = req.user?.did;
    if (!did || !trustedDevices.has(did)) {
      return reply.code(403).send({ error: "device_not_trusted" });
    }
  });

  // Test routes
  app.get("/protected", { preHandler: app.authenticate }, async () => ({ ok: true }));
  app.get("/trusted", { preHandler: app.authenticateTrusted }, async () => ({ ok: true }));

  return app;
}

describe("auth middleware", () => {
  let app: FastifyInstance;
  let validToken: string;
  let untrustedToken: string;

  before(async () => {
    app = await buildTestApp();
    await app.ready();

    validToken = app.jwt.sign({ sub: "user-1", did: "device-trusted-1" });
    untrustedToken = app.jwt.sign({ sub: "user-1", did: "device-untrusted" });
  });

  after(async () => {
    await app.close();
  });

  it("returns 401 for unauthenticated request to protected route", async () => {
    const res = await app.inject({ method: "GET", url: "/protected" });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "unauthorized" });
  });

  it("returns 401 for unauthenticated request to trusted route", async () => {
    const res = await app.inject({ method: "GET", url: "/trusted" });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "unauthorized" });
  });

  it("returns 401 for invalid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer invalid.token.here" },
    });
    assert.equal(res.statusCode, 401);
  });

  it("returns 200 for valid token on protected route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${validToken}` },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  it("returns 403 for valid token but untrusted device on trusted route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/trusted",
      headers: { authorization: `Bearer ${untrustedToken}` },
    });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "device_not_trusted" });
  });

  it("returns 403 when token has no device id on trusted route", async () => {
    const noDidToken = app.jwt.sign({ sub: "user-1" });
    const res = await app.inject({
      method: "GET",
      url: "/trusted",
      headers: { authorization: `Bearer ${noDidToken}` },
    });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "device_not_trusted" });
  });

  it("returns 200 for valid token with trusted device on trusted route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/trusted",
      headers: { authorization: `Bearer ${validToken}` },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });
});