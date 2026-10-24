import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { query, withTransaction } from "../db.js";
import {
  hashPassword,
  verifyPassword,
  newOpaqueToken,
  sha256,
  hashFingerprint,
} from "../security.js";
import {
  accountLockState,
  checkIpThrottle,
  clearIpThrottle,
  recordFailure,
  recordSuccess,
  sendThrottled,
} from "../loginGuard.js";
import { clientIp } from "../clientIp.js";
import { revokeKey } from "../revocation.js";
import { config } from "../config.js";

const REFRESH_TTL_DAYS = 30;

/**
 * Emails permitted to register. Single-user app: this is the whole allowlist.
 * Read per-call rather than cached at import so changing .env and restarting is
 * enough (no rebuild), and so a typo surfaces as a rejected registration rather
 * than a silently empty list. An EMPTY list is a fatal misconfiguration, not a
 * permission grant: registration fails closed (see the handler).
 */
function allowedEmails(): string[] {
  return config.allowedEmails
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const deviceSchema = z.object({
  fingerprint: z.string().min(16).max(512),
  name: z.string().max(120).optional(),
  platform: z.string().max(120).optional(),
  appVersion: z.string().max(40).optional(),
});

const registerSchema = deviceSchema.extend({
  email: z.string().email().max(254),
  password: z.string().min(10).max(200),
  displayName: z.string().max(120).optional(),
});

const loginSchema = deviceSchema.extend({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(16).max(512),
  fingerprint: z.string().min(16).max(512),
});

type DeviceFields = z.infer<typeof deviceSchema>;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  disabled: boolean;
}

interface DeviceRow {
  id: string;
  trusted: boolean;
  revoked: boolean;
}

/**
 * Upsert the device for this user. The first device a user ever registers is
 * trusted (otherwise they could never approve anything); every later unseen
 * fingerprint starts untrusted and can only reach /auth and /me until a
 * trusted device approves it.
 */
async function upsertDevice(
  userId: string,
  d: DeviceFields,
  isFirstDevice: boolean,
  tx: { query: typeof query },
): Promise<DeviceRow> {
  const fp = hashFingerprint(d.fingerprint);
  const res = await tx.query<DeviceRow>(
    `INSERT INTO devices (user_id, fingerprint, name, platform, app_version, trusted)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, fingerprint) DO UPDATE
       SET last_seen = now(),
           name = COALESCE(EXCLUDED.name, devices.name),
           platform = COALESCE(EXCLUDED.platform, devices.platform),
           app_version = COALESCE(EXCLUDED.app_version, devices.app_version)
     RETURNING id, trusted, revoked`,
    [userId, fp, d.name ?? null, d.platform ?? null, d.appVersion ?? null, isFirstDevice],
  );
  const row = res.rows[0];
  if (!row) throw new Error("device upsert returned no row");
  return row;
}

async function issueSession(
  app: FastifyInstance,
  userId: string,
  deviceId: string,
  req: FastifyRequest,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const refreshToken = newOpaqueToken();
  const tokenHash = sha256(refreshToken);
  const expiresAt = new Date(
    Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  await query(
    `INSERT INTO sessions (user_id, device_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, deviceId, tokenHash, expiresAt, clientIp(req), req.headers["user-agent"] ?? null],
  );
  const accessToken = app.jwt.sign({ sub: userId, did: deviceId }, { expiresIn: "15m" });
  return { accessToken, refreshToken, expiresIn: 900 };
}

async function audit(
  userId: string | null,
  deviceId: string | null,
  action: string,
  ip: string,
  detail: unknown = null,
): Promise<void> {
  await query(
    `INSERT INTO audit_log (user_id, device_id, action, ip, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, deviceId, action, ip, detail === null ? null : JSON.stringify(detail)],
  );
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (req, reply) => {
    const body = registerSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", detail: body.error.issues });
    }
    const b = body.data;
    const email = b.email.trim().toLowerCase();

    // Registration is closed to anyone but the owner. This app is single-user
    // by design, so an open signup endpoint is pure attack surface: without
    // this, anyone who finds the tunnel URL can create an account on the box.
    // Configured via ALLOWED_EMAILS (comma-separated). An EMPTY list fails
    // CLOSED with 503 rather than opening signup: a fresh deployment that has
    // not been configured must never register a fully trusted device for an
    // anonymous caller (that was the F-04 fail-open hole).
    const allowed = allowedEmails();
    if (allowed.length === 0) {
      req.log.error("ALLOWED_EMAILS is not configured; refusing registration");
      await audit(null, null, "auth.register_not_configured", clientIp(req), null);
      return reply.code(503).send({ error: "registration_not_configured" });
    }
    if (!allowed.includes(email)) {
      await audit(null, null, "auth.register_rejected", clientIp(req), { email });
      return reply.code(403).send({ error: "registration_closed" });
    }

    const existing = await query<{ id: string }>(
      "SELECT id FROM users WHERE email = $1",
      [email],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return reply.code(409).send({ error: "email_taken" });
    }

    const passwordHash = await hashPassword(b.password);

    const created = await withTransaction(async (client) => {
      const u = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3) RETURNING id`,
        [email, passwordHash, b.displayName ?? null],
      );
      const userId = u.rows[0]!.id;
      const device = await upsertDevice(userId, b, true, client);
      return { userId, deviceId: device.id };
    });

    const tokens = await issueSession(app, created.userId, created.deviceId, req);
    await audit(created.userId, created.deviceId, "auth.register", clientIp(req), { email });
    return reply.code(201).send({
      ...tokens,
      deviceId: created.deviceId,
      trusted: true,
    });
  });

  app.post("/auth/login", async (req, reply) => {
    // Throttle on the caller's IP before touching the database, so a flood of
    // attempts cannot be used to hammer Postgres.
    const ip = clientIp(req);
    const ipVerdict = checkIpThrottle(ip);
    if (!ipVerdict.allowed) {
      return sendThrottled(reply, ipVerdict.retryAfterSeconds);
    }

    const body = loginSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", detail: body.error.issues });
    }
    const b = body.data;
    const email = b.email.trim().toLowerCase();

    const found = await query<UserRow>(
      "SELECT id, email, password_hash, display_name, disabled FROM users WHERE email = $1",
      [email],
    );
    const user = found.rows[0];

    // Check the account lockout before verifying anything. Doing this first
    // means a locked account costs one indexed read, not a scrypt computation -
    // otherwise the lockout itself becomes a CPU exhaustion vector.
    const lockState = await accountLockState(user?.id ?? null);
    if (lockState.locked) {
      await audit(user!.id, null, "auth.login_locked", ip, { email });
      return sendThrottled(reply, lockState.retryAfterSeconds);
    }

    // Distinguish "unknown user" from "bad password" only in the audit log,
    // never in the response: the client always sees the same failure.
    if (!user || user.disabled) {
      if (user?.disabled) {
        await audit(user.id, null, "auth.login_disabled", ip);
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const ok = await verifyPassword(b.password, user.password_hash);
    if (!ok) {
      const lockedFor = await recordFailure(user.id);
      await audit(user.id, null, "auth.login_failed", ip, {
        lockedForSeconds: lockedFor,
      });
      // A lock that just engaged is reported as 429 so the client can back off;
      // otherwise stay with the uniform 401 to avoid leaking state.
      if (lockedFor > 0) return sendThrottled(reply, lockedFor);
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    // Successful login clears both counters, so a legitimate user who fat-fingers
    // their password a few times is not left locked out.
    await recordSuccess(user.id);
    clearIpThrottle(ip);

    const deviceCount = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM devices WHERE user_id = $1",
      [user.id],
    );
    const isFirst = (deviceCount.rows[0]?.n ?? "0") === "0";

    const device = await upsertDevice(user.id, b, isFirst, { query });
    if (device.revoked) {
      await audit(user.id, device.id, "auth.login_revoked_device", clientIp(req));
      return reply.code(403).send({ error: "device_revoked" });
    }

    const tokens = await issueSession(app, user.id, device.id, req);
    await audit(user.id, device.id, "auth.login", clientIp(req), {
      trusted: device.trusted,
    });
    return reply.send({
      ...tokens,
      deviceId: device.id,
      trusted: device.trusted,
      displayName: user.display_name,
      email: user.email,
    });
  });

  app.post("/auth/refresh", async (req, reply) => {
    const body = refreshSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const { refreshToken, fingerprint } = body.data;
    const tokenHash = sha256(refreshToken);
    const fp = hashFingerprint(fingerprint);

    const found = await query<{
      id: string;
      user_id: string;
      device_id: string | null;
      expires_at: Date;
      revoked: boolean;
      trusted: boolean | null;
      device_fp: string | null;
      device_revoked: boolean | null;
      disabled: boolean;
    }>(
      `SELECT s.id, s.user_id, s.device_id, s.expires_at, s.revoked,
              d.trusted, d.fingerprint AS device_fp, d.revoked AS device_revoked,
              u.disabled
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN devices d ON d.id = s.device_id
        WHERE s.token_hash = $1`,
      [tokenHash],
    );
    const row = found.rows[0];
    if (!row || row.revoked || row.expires_at.getTime() < Date.now()) {
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }
    if (row.disabled) return reply.code(403).send({ error: "account_disabled" });
    // A refresh from a different device than the one the session was minted on
    // is a stolen-token signature: kill the session.
    if (!row.device_fp || row.device_fp !== fp || row.device_revoked) {
      await query("UPDATE sessions SET revoked = true WHERE id = $1", [row.id]);
      await audit(row.user_id, row.device_id, "auth.refresh_fingerprint_mismatch", clientIp(req));
      return reply.code(401).send({ error: "device_mismatch" });
    }

    await query("UPDATE sessions SET revoked = true WHERE id = $1", [row.id]);
    const tokens = await issueSession(app, row.user_id, row.device_id!, req);
    await audit(row.user_id, row.device_id, "auth.refresh", clientIp(req));
    return reply.send({ ...tokens, trusted: row.trusted ?? false });
  });

  app.post("/auth/logout", { preHandler: app.authenticate }, async (req, reply) => {
    const { sub, did } = req.user;
    await query(
      "UPDATE sessions SET revoked = true WHERE user_id = $1 AND (device_id = $2 OR $2 IS NULL)",
      [sub, did ?? null],
    );
    // The access token must die with the session, not linger for 15 minutes (F-07).
    if (did) revokeKey(did);
    await audit(sub, did ?? null, "auth.logout", clientIp(req));
    return reply.send({ ok: true });
  });

  app.get("/me", { preHandler: app.authenticate }, async (req, reply) => {
    const { sub, did } = req.user;
    const u = await query<{
      id: string;
      email: string;
      display_name: string | null;
      created_at: Date;
    }>("SELECT id, email, display_name, created_at FROM users WHERE id = $1", [sub]);
    const user = u.rows[0];
    if (!user) return reply.code(404).send({ error: "not_found" });

    const d = await query<{ id: string; trusted: boolean; name: string | null; platform: string | null }>(
      "SELECT id, trusted, name, platform FROM devices WHERE id = $1",
      [did ?? null],
    );
    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        createdAt: user.created_at,
      },
      device: d.rows[0] ?? null,
    });
  });

  app.get("/auth/devices", { preHandler: app.authenticate }, async (req, reply) => {
    const rows = await query(
      `SELECT id, name, platform, app_version, trusted, revoked, first_seen, last_seen
         FROM devices WHERE user_id = $1 ORDER BY first_seen DESC`,
      [req.user.sub],
    );
    return reply.send({ devices: rows.rows });
  });

  app.post<{ Params: { id: string } }>(
    "/auth/devices/:id/approve",
    { preHandler: app.authenticateTrusted },
    async (req, reply) => {
      const { id } = req.params;
      const r = await query(
        `UPDATE devices SET trusted = true, revoked = false
          WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, req.user.sub],
      );
      if (!r.rowCount) return reply.code(404).send({ error: "not_found" });
      await audit(req.user.sub, req.user.did ?? null, "device.approve", clientIp(req), { id });
      return reply.send({ ok: true });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/auth/devices/:id",
    { preHandler: app.authenticateTrusted },
    async (req, reply) => {
      const { id } = req.params;
      const r = await query(
        `UPDATE devices SET revoked = true, trusted = false
          WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, req.user.sub],
      );
      if (!r.rowCount) return reply.code(404).send({ error: "not_found" });
      await query("UPDATE sessions SET revoked = true WHERE device_id = $1", [id]);
      // The device's live access token stops working immediately (F-07).
      revokeKey(id);
      await audit(req.user.sub, req.user.did ?? null, "device.revoke", clientIp(req), { id });
      return reply.send({ ok: true });
    },
  );
}
