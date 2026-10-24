import "./env.js";
import type { FastifyRequest } from "fastify";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";

import { authRoutes } from "./routes/auth.js";
import { systemRoutes } from "./routes/system.js";
import { fileRoutes } from "./routes/files.js";
import { crashRoutes } from "./routes/crash.js";
import { terminalRoutes } from "./routes/terminal.js";
import { assertTokenClaims, assertNoCritHeader } from "./tokenClaims.js";
import { pool, query } from "./db.js";

declare module "@fastify/jwt" {
  // @fastify/jwt types request.user from this interface; augmenting
  // FastifyRequest directly collides with its own declaration.
  interface FastifyJWT {
    payload: { sub: string; did?: string };
    user: { sub: string; did?: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateTrusted: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const PORT = Number(process.env.PORT ?? 8787);
// Loopback by default: the tunnel is what exposes this, not a public bind.
const HOST = process.env.HOST ?? "127.0.0.1";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    // Redact the bearer token that the WebSocket terminal passes as a query
    // parameter (?token=…). Without this the live access token is written to
    // the journal on every terminal connection (F-03).
    serializers: {
      req(req: FastifyRequest) {
        const url = req.url.replace(/([?&]token=)[^&\s]*/i, "$1<redacted>");
        return { method: req.method, url, hostname: req.hostname, remoteAddress: req.socket?.remoteAddress };
      },
    },
  },
  trustProxy: true,
  bodyLimit: 1024 * 1024,
});

await app.register(cors, {
  origin: (process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean),
  credentials: false,
});

await app.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX ?? 120),
  timeWindow: "1 minute",
});

await app.register(jwt, {
  secret: process.env.JWT_SECRET ?? (() => {
    throw new Error("JWT_SECRET is not set");
  })(),
  // Accept ONLY HS256. Without this fast-jwt accepts HS384/HS512 and, via the
  // upstream advisories, non-conforming shapes (F-06, F-11).
  verify: { algorithms: ["HS256"] },
  // `complete: true` makes the decoder return the JOSE header as well as the
  // payload. The header is needed to reject a `crit` extension, which
  // fast-jwt 5.x does not handle at all (F-11).
  decode: { complete: true },
});

await app.register(multipart, {
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024) },
});

await app.register(websocket);

app.decorate("authenticate", async (req, reply) => {
  try {
    const payload = await req.jwtVerify();
    assertTokenClaims(payload);
    const decoded = await req.jwtDecode<{ header?: unknown }>();
    assertNoCritHeader(decoded?.header);
  } catch (e) {
    if (process.env.DEBUG_JWT) req.log.warn({ why: (e as Error).message }, "authenticate rejected");
    return reply.code(401).send({ error: "unauthorized" });
  }
});

app.decorate("authenticateTrusted", async (req, reply) => {
  try {
    const payload = await req.jwtVerify();
    assertTokenClaims(payload);
    const decoded = await req.jwtDecode<{ header?: unknown }>();
    assertNoCritHeader(decoded?.header);
  } catch {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const r = await query<{ trusted: boolean; revoked: boolean }>(
    "SELECT trusted, revoked FROM devices WHERE id = $1 AND user_id = $2",
    [req.user.did ?? null, req.user.sub],
  );
  const d = r.rows[0];
  if (!d || !d.trusted || d.revoked) {
    return reply.code(403).send({ error: "device_not_trusted" });
  }
});

// Never let an internal error reach the client. Fastify's default handler
// returns err.message verbatim, which for a Postgres failure is the raw
// driver message — e.g. {"code":"42P01","message":"relation \"users\" does
// not exist"}. That leaks schema details and is a 500 where a 400 belongs.
// The full error still goes to the server log; the client gets a flat body.
app.setErrorHandler((err: unknown, req, reply) => {
  const e = err as { statusCode?: number; name?: string; message?: string };
  const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600
    ? e.statusCode
    : 500;
  if (status >= 500) {
    req.log.error({ err: e, path: req.url }, "unhandled error");
  } else {
    req.log.info({ err: e.message, path: req.url }, "request rejected");
  }
  return reply.code(status).send({
    statusCode: status,
    error: status >= 500 ? "internal_error" : (e.name || "error"),
    message: status >= 500 ? "Internal Server Error" : e.message,
  });
});

app.get("/health", async () => {
  const db = await pool.query("SELECT 1 AS ok");
  return {
    ok: db.rowCount === 1,
    app: "friday-one",
    version: process.env.APP_VERSION ?? "0.1.0",
    uptime_s: Math.round(process.uptime()),
  };
});

await app.register(authRoutes);
await app.register(systemRoutes);
await app.register(fileRoutes);
await app.register(crashRoutes);
await app.register(terminalRoutes);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: PORT, host: HOST });
app.log.info(`friday-one listening on http://${HOST}:${PORT}`);
