/**
 * POST /api/v1/servers/[id]/[action] — consolidated server actions
 * (Vercel Hobby caps a deployment at 12 functions, so sibling action routes
 * live here). Supported: `revoke`, `rotate`.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAccessToken } from "../../../../lib/auth.js";
import { revokeServer } from "../../../../lib/enrollments.js";
import { rest } from "../../../../lib/supabase.js";
import { insertAudit } from "../../../../lib/policies.js";
import { clientIp, consumeLimit, limitResponse } from "../../../../lib/ratelimit.js";
import { json, fail } from "../../../../lib/util.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
  const action = req.query?.action;
  const id = req.query?.id;
  if (typeof action !== "string" || typeof id !== "string") return fail(res, 400, "invalid_request");

  const limit = await consumeLimit("revoke", clientIp(req));
  if (!limit.ok) return limitResponse(res, limit);
  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");

  try {
    if (action === "revoke") {
      const ok = await revokeServer(id, user.id);
      if (!ok) return fail(res, 404, "not_found_or_not_active");
      json(res, 200, { state: "revoked" });
      return;
    }
    if (action === "rotate") {
      // Rotation trigger: null connector_id makes the connector's next sync
      // report rotation_due; the connector submits a new hash via
      // /api/v1/connector/rotate-credential (only the hash ever travels).
      const servers = await rest<{ id: string }>("PATCH", "servers", {
        body: { connector_id: null, updated_at: new Date().toISOString() },
        prefer: "return=representation",
        query: { id: `eq.${id}`, owner_id: `eq.${user.id}`, enrollment_state: "eq.active" },
      });
      if (!servers[0]) return fail(res, 404, "not_found_or_not_active");
      await insertAudit({ actorId: user.id, serverId: id, action: "credential.rotation_requested" });
      json(res, 200, { rotation_requested: true });
      return;
    }
    fail(res, 404, "unknown_action");
  } catch {
    fail(res, 500, "action_failed");
  }
}
