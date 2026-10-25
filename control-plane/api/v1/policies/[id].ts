/**
 * PATCH  /api/v1/policies/:id — toggle/patch an owned policy.
 * DELETE /api/v1/policies/:id — remove an owned policy.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAccessToken } from "../../../lib/auth.js";
import { getOwnedPolicy, patchPolicy, insertAudit } from "../../../lib/policies.js";
import { json, fail } from "../../../lib/util.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");
  const id = req.query?.id;
  if (typeof id !== "string") return fail(res, 400, "invalid_request");

  const existing = await getOwnedPolicy(id, user.id);
  if (!existing) return fail(res, 404, "not_found");

  if (req.method === "PATCH") {
    const patch: Record<string, unknown> = {};
    if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
    if (req.body?.decision === "allow" || req.body?.decision === "deny" ||
        req.body?.decision === "require_approval") patch.decision = req.body.decision;
    if (Object.keys(patch).length === 0) return fail(res, 400, "nothing_to_update");
    try {
      // version bump so approvals bound to the old version die (plan v2 §9)
      await patchPolicy(id, {
        ...patch,
        version: existing.version + 1,
        updated_at: new Date().toISOString(),
      });
      await insertAudit({
        actorId: user.id, serverId: existing.server_id, action: "policy.updated",
        detail: { policy_id: id, patch: { ...patch, version: undefined } },
      });
      json(res, 200, { ok: true });
    } catch {
      fail(res, 500, "update_failed");
    }
    return;
  }

  if (req.method === "DELETE") {
    try {
      await patchPolicy(id, { enabled: false, expires_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      await insertAudit({
        actorId: user.id, serverId: existing.server_id, action: "policy.revoked",
        detail: { policy_id: id },
      });
      json(res, 200, { ok: true });
    } catch {
      fail(res, 500, "delete_failed");
    }
    return;
  }

  fail(res, 405, "method_not_allowed");
}
