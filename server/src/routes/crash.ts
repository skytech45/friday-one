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
  context: z.record(z.string(), z.unknown()).optional(),
});

// F-12: the write path is unauthenticated, so message/stack_trace are hostile
// input. Strip control characters (NUL, ANSI/C1 escapes) but keep \n and \t —
// a stack trace without newlines is useless — and cap length at the boundary
// rather than trusting the schema alone.
function sanitizeText(s: string, max: number): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "").slice(0, max);
}

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
      const message = sanitizeText(b.message, 4000);
      const stackTrace = b.stackTrace === undefined ? null : sanitizeText(b.stackTrace, 60_000);

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
          message,
          stackTrace,
          b.context ? JSON.stringify(b.context) : null,
        ],
      );

      // A stable dedupe hash so the same crash on 500 devices is one issue.
      const signature = sha256(`${message}|${(stackTrace ?? "").slice(0, 400)}`).slice(0, 16);
      return reply.code(202).send({ ok: true, id: r.rows[0]?.id, signature });
    },
  );

  app.get("/crash", { preHandler: app.authenticateTrusted }, async (req, reply) => {
    // F-12: only reports LINKED to this user are served. Unlinked reports
    // (no fingerprint, or a fingerprint matching no known device) are kept in
    // the table for manual inspection but are never handed to the console —
    // anyone on the internet could otherwise inject content into it.
    const rows = await query(
      `SELECT id, severity, message, stack_trace, app_version, build_type,
              context, created_at, reviewed
         FROM crash_reports
        WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 100`,
      [req.user.sub],
    );
    return reply.send({ reports: rows.rows });
  });
}
