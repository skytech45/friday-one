/**
 * POST /api/v1/enrollments — create an owner-bound enrollment (plan v2 §4).
 * Returns the enrollment token ONCE; the app shows the version-pinned
 * install command embedding it.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAccessToken } from "../../../lib/auth.js";
import { createEnrollment } from "../../../lib/enrollments.js";
import { clientIp, consumeLimit, limitResponse } from "../../../lib/ratelimit.js";
import { json, fail } from "../../../lib/util.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
  const limit = await consumeLimit("enrollCreate", clientIp(req));
  if (!limit.ok) return limitResponse(res, limit);
  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  if (!name) return fail(res, 400, "invalid_request");
  try {
    const out = await createEnrollment(user.id, name);
    json(res, 201, {
      enrollment_id: out.enrollmentId,
      server_id: out.serverId,
      enrollment_token: out.enrollmentToken,
      expires_at: out.expiresAt,
    });
  } catch {
    fail(res, 500, "enrollment_failed");
  }
}
