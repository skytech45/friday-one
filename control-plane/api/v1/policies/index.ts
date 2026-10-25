/**
 * GET  /api/v1/policies — list the owner's policies.
 * POST /api/v1/policies — create (owner-bound; server ownership verified).
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAccessToken } from "../../../lib/auth.js";
import {
  createPolicy, listPolicies, ownedServerIds, validatePolicyInput, insertAudit,
} from "../../../lib/policies.js";
import { json, fail } from "../../../lib/util.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");

  if (req.method === "GET") {
    try {
      json(res, 200, { policies: await listPolicies(user.id) });
    } catch {
      fail(res, 500, "list_failed");
    }
    return;
  }

  if (req.method === "POST") {
    const parsed = validatePolicyInput(req.body ?? {});
    if (!parsed.ok) return fail(res, 400, parsed.why);
    if (parsed.v.server_id !== undefined) {
      const owned = await ownedServerIds(user.id);
      if (!owned.has(String(parsed.v.server_id))) return fail(res, 403, "not_your_server");
    }
    try {
      const row = await createPolicy(user.id, parsed.v);
      await insertAudit({
        actorId: user.id, serverId: row.server_id, action: "policy.created",
        detail: { policy_id: row.id, action_rule: row.action, decision: row.decision },
      });
      json(res, 201, { policy: row });
    } catch {
      fail(res, 500, "create_failed");
    }
    return;
  }

  fail(res, 405, "method_not_allowed");
}
