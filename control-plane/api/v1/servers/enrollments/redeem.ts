/**
 * POST /api/v1/servers/enrollments/redeem — connector-side redemption.
 * Auth: the single-use pairing code itself (no user token — the operator runs
 * this over their own SSH session). Atomic consumption guarantees single use.
 * Never echoes the code or the credential beyond the one response.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { consumePairingCode, issueConnectorCredential } from "../../../../lib/supabase.js";
import { json, fail } from "../../../../lib/util.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");

  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const connectorVersion =
    typeof req.body?.connector_version === "string" ? req.body.connector_version.slice(0, 40) : "";
  if (!code || code.length > 128) return fail(res, 400, "invalid_request");

  try {
    const row = await consumePairingCode(code);
    if (!row) return fail(res, 403, "invalid_or_used_code"); // uniform: no enumeration
    const credential = await issueConnectorCredential(row.server_id);
    json(res, 201, {
      server_id: row.server_id,
      credential,
      credential_expires_at: null,
      connector_version: connectorVersion,
    });
  } catch {
    fail(res, 500, "redemption_failed");
  }
}
