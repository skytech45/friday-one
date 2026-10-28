/**
 * Connector-side enrollment session endpoints (plan v2 §7).
 * POST /api/v1/enrollments/session       { token }  -> display code (once)
 * POST /api/v1/enrollments/session/poll  { token }  -> state + credential pickup
 *      (vercel.json rewrites it here with ?mode=poll; no extra function)
 * GET  /api/v1/enrollments/session?token=...         -> same as poll, for
 *      connectors <= v0.9.0 only: it puts the token in URLs and logs (F-M2)
 *
 * The enrollment token authorizes PAIRING ONLY — never shell access.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { openEnrollmentSession, pickupCredential } from "../../../lib/enrollments.js";
import { clientIp, consumeLimit, limitResponse } from "../../../lib/ratelimit.js";
import { json, fail } from "../../../lib/util.js";

async function pollResponse(res: VercelResponse, token: string): Promise<void> {
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

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const ip = clientIp(req);
  const isPoll = req.method === "GET" || (req.method === "POST" && req.query?.mode === "poll");
  // Session-open is the expensive operation; polls are cheap but numerous.
  if (req.method === "POST" || req.method === "GET") {
    const limit = await consumeLimit(isPoll ? "sessionPoll" : "sessionOpen", ip);
    if (!limit.ok) return limitResponse(res, limit);
  }
  const bodyToken = typeof req.body?.token === "string" ? req.body.token : "";

  if (req.method === "POST" && isPoll) return pollResponse(res, bodyToken);

  if (req.method === "POST") {
    if (!bodyToken) return fail(res, 400, "invalid_request");
    const sess = await openEnrollmentSession(bodyToken);
    if (!sess) return fail(res, 403, "invalid_or_expired_token");
    return json(res, 200, {
      enrollment_id: sess.enrollmentId,
      server_id: sess.serverId,
      display_code: sess.displayCode,
      display_code_expires_at: sess.displayCodeExpiresAt,
    });
  }

  if (req.method === "GET") {
    return pollResponse(res, typeof req.query?.token === "string" ? String(req.query.token) : "");
  }

  return fail(res, 405, "method_not_allowed");
}
