import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db.js";
import { hashFingerprint, sha256 } from "../security.js";

const crashSchema = z.object({
  fingerprint: z.string().min(8).max(512).optional(),
  appVersion: z.string().max(40).optional(),
  buildType: z.string().max(20).optional(),
  severity: z.enum(["info", "warning", "error", "fatal"]).default("error"),
  message: z.string().min(1).max(4000),
  stackTrace: z.string().max(60_000).optional(),
  context: z.record(z.unknown()).optional(),
});

/**
 * Crash reports are accepted WITHOUT authentication on purpose: the crashiest
 * bugs (startup, token refresh, keystore failure) happen before a session
 * exists, and a report we refuse to accept is a bug we never see.
 *
 * Abuse is handled the other way round: strict rate limiting, size caps, and an
 * optional device fingerprint that is only linked to a user when it matches one
 * already on file.
 */
export async function crashRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/crash",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { body: { type: "object" } },
    },
    async (req, reply) => {
      const parsed = crashSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues });
      }
      const b = parsed.data;

      let userId: string | null = null;
      let deviceId: string | null = null;
      let fpHash: string | null = null;
      if (b.fingerprint) {
        try {
          fpHash = hashFingerprint(b.fingerprint);
          const d = await query<{ id: string; user_id: string }>(
            "SELECT id, user_id FROM devices WHERE fingerprint = $1 LIMIT 1",
            [fpHash],
          );
          if (d.rows[0]) {
            deviceId = d.rows[0].id;
            userId = d.rows[0].user_id;
          }
        } catch {
          /* pepper missing: keep the report, just unlinked */
        }
      }

      const r = await query<{ id: string }>(
        `INSERT INTO crash_reports
           (user_id, device_id, fingerprint, app_version, build_type, severity, message, stack_trace, context)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          userId,
          deviceId,
          fpHash,
          b.appVersion ?? null,
          b.buildType ?? null,
          b.severity,
          b.message,
          b.stackTrace ?? null,
          b.context ? JSON.stringify(b.context) : null,
        ],
      );

      // A stable dedupe hash so the same crash on 500 devices is one issue.
      const signature = sha256(`${b.message}|${(b.stackTrace ?? "").slice(0, 400)}`).slice(0, 16);
      return reply.code(202).send({ ok: true, id: r.rows[0]?.id, signature });
    },
  );

  app.get("/crash", { preHandler: app.authenticateTrusted }, async (req, reply) => {
    const rows = await query(
      `SELECT id, severity, message, stack_trace, app_version, build_type,
              context, created_at, reviewed
         FROM crash_reports
        WHERE user_id = $1 OR user_id IS NULL
        ORDER BY created_at DESC LIMIT 100`,
      [req.user.sub],
    );
    return reply.send({ reports: rows.rows });
  });
}
