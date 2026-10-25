/**
 * POST /api/v1/enrollments/:id/claim — app-side one-time claim (plan v2 §4).
 * Verifies: JWT owner == enrollment owner, code hash, expiry, attempt budget.
 * Atomic; wrong/expired/replayed/guessed claims fail closed.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAccessToken } from "../../../../lib/auth.js";
import { claimEnrollment } from "../../../../lib/enrollments.js";
import { clientIp, consumeLimit, limitResponse } from "../../../../lib/ratelimit.js";
import { json, fail } from "../../../../lib/util.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
  const ip = clientIp(req);
  const preLimit = await consumeLimit("claim", ip);
  if (!preLimit.ok) return limitResponse(res, preLimit);
  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");
  const id = req.query?.id;
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (typeof id !== "string" || !/^\d{16,20}$/.test(code)) {
    return fail(res, 400, "invalid_request");
  }
  try {
    const result = await claimEnrollment(id, user.id, code);
    if (!result.ok) {
      // Failed claims (wrong/expired/replayed codes) burn 5x the budget —
      // bulk guessing across enrollments hits the wall fast.
      const failLimit = await consumeLimit("claimFail", ip, 5);
      if (!failLimit.ok) return limitResponse(res, failLimit);
      // Uniform 403 mapping: no oracle about which check failed beyond the
      // generic categories the app needs to render UX.
      const status = result.reason === "not_found" ? 404 : 403;
      return fail(res, status, result.reason);
    }
    json(res, 200, { state: "claim_requested", server_id: result.serverId });
  } catch {
    fail(res, 500, "claim_failed");
  }
}
