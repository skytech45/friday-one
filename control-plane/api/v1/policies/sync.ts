/**
 * GET /api/v1/policies/sync — CONNECTOR-side policy pull, authenticated by
 * the connector credential (hash-lookup, same as the gateway). Returns the
 * effective rules the connector evaluates IMMEDIATELY before execution
 * (plan v2 §10: "Connector rechecks policy immediately before execution").
 * Fail closed: connector treats fetch errors as deny/require_approval.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sha256hex, rest } from "../../../lib/supabase.js";
import { syncRulesFor } from "../../../lib/policies.js";
import { json, fail } from "../../../lib/util.js";

interface CredRow { id: string; server_id: string; revoked_at: string | null }

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") return fail(res, 405, "method_not_allowed");
  const credential = req.headers["x-connector-credential"];
  if (typeof credential !== "string" || !credential) return fail(res, 401, "unauthenticated");
  try {
    const creds = await rest<CredRow>("GET", "connector_credentials", {
      query: { credential_hash: `eq.${sha256hex(credential)}`, revoked_at: "is.null", select: "id,server_id,revoked_at" },
    });
    const cred = creds[0];
    if (!cred) return fail(res, 403, "credential_revoked");
    const servers = await rest<{ owner_id: string; enrollment_state: string }>("GET", "servers", {
      query: { id: `eq.${cred.server_id}`, select: "owner_id,enrollment_state" },
    });
    const server = servers[0];
    if (!server || server.enrollment_state !== "active") return fail(res, 403, "server_not_active");
    const rules = await syncRulesFor(cred.server_id, server.owner_id);
    json(res, 200, { version: Date.now(), server_id: cred.server_id, rules });
  } catch {
    fail(res, 500, "sync_failed");
  }
}
