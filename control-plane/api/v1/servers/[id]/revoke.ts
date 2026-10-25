/**
 * POST /api/v1/servers/:id/revoke — owner revokes a server: credential dead,
 * enrollment revoked, gateway will refuse the connector's reconnect.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAccessToken } from "../../../../lib/auth.js";
import { revokeServer } from "../../../../lib/enrollments.js";
import { clientIp, consumeLimit, limitResponse } from "../../../../lib/ratelimit.js";
import { json, fail } from "../../../../lib/util.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
  const limit = await consumeLimit("revoke", clientIp(req));
  if (!limit.ok) return limitResponse(res, limit);
  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");
  const id = req.query?.id;
  if (typeof id !== "string") return fail(res, 400, "invalid_request");
  try {
    const ok = await revokeServer(id, user.id);
    if (!ok) return fail(res, 404, "not_found_or_not_active");
    json(res, 200, { state: "revoked" });
  } catch {
    fail(res, 500, "revoke_failed");
  }
}
