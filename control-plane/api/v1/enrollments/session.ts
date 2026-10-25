/**
 * Connector-side enrollment session endpoints (plan v2 §7).
 * POST /api/v1/enrollments/session  { token }  -> display code (once)
 * GET  /api/v1/enrollments/session?token=...   -> state + credential pickup
 *
 * The enrollment token authorizes PAIRING ONLY — never shell access.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { openEnrollmentSession, pickupCredential } from "../../../lib/enrollments.js";
import { json, fail } from "../../../lib/util.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const token = typeof req.body?.token === "string" ? req.body.token
    : typeof req.query?.token === "string" ? String(req.query.token) : "";

  if (req.method === "POST") {
    if (!token) return fail(res, 400, "invalid_request");
    const sess = await openEnrollmentSession(token);
    if (!sess) return fail(res, 403, "invalid_or_expired_token");
    return json(res, 200, {
      enrollment_id: sess.enrollmentId,
      server_id: sess.serverId,
      display_code: sess.displayCode,
      display_code_expires_at: sess.displayCodeExpiresAt,
    });
  }

  if (req.method === "GET") {
    if (!token) return fail(res, 400, "invalid_request");
    const pickup = await pickupCredential(token);
    if (pickup) {
      return json(res, 200, {
        state: "paired",
        server_id: pickup.serverId,
        enrollment_id: pickup.enrollmentId,
        credential: pickup.credential,
      });
    }
    // Not yet claimed (or already picked up): state-only, no secrets.
    return json(res, 200, { state: "pending" });
  }

  return fail(res, 405, "method_not_allowed");
}
