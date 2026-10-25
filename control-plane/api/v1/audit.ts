/**
 * GET /api/v1/audit — the owner's recent audit events (redacted at write).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAccessToken } from "../../lib/auth.js";
import { listAudit } from "../../lib/policies.js";
import { json, fail } from "../../lib/util.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") return fail(res, 405, "method_not_allowed");
  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");
  try {
    json(res, 200, { events: await listAudit(user.id) });
  } catch {
    fail(res, 500, "list_failed");
  }
}
