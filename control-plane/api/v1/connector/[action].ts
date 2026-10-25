/**
 * POST /api/v1/connector/[action] — CONNECTOR-side RPCs (consolidated for
 * the Hobby 12-function cap). Supported: `rotate-credential`.
 *
 * Auth: the connector's CURRENT credential (x-connector-credential header).
 * Body: { new_credential_hash } — sha256 hex of the new secret generated
 * LOCALLY by the connector. Only the hash ever travels. Creates the new
 * credential row, re-points the server, grace-expires older credentials.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sha256hex, rest } from "../../../lib/supabase.js";
import { insertAudit } from "../../../lib/policies.js";
import { json, fail } from "../../../lib/util.js";

const GRACE_SECONDS = Number(process.env.ROTATE_GRACE_SECONDS ?? 600);

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const action = req.query?.action;
  if (typeof action !== "string") return fail(res, 400, "invalid_request");
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
  if (action !== "rotate-credential") return fail(res, 404, "unknown_action");

  const current = req.headers["x-connector-credential"];
  if (typeof current !== "string" || !current) return fail(res, 401, "unauthenticated");
  const newHash = req.body?.new_credential_hash;
  if (typeof newHash !== "string" || !/^[a-f0-9]{64}$/.test(newHash)) {
    return fail(res, 400, "invalid_hash");
  }
  try {
    const creds = await rest<{ id: string; server_id: string }>("GET", "connector_credentials", {
      query: {
        credential_hash: `eq.${sha256hex(current)}`,
        revoked_at: "is.null",
        select: "id,server_id",
      },
    });
    const cred = creds[0];
    if (!cred) return fail(res, 403, "credential_invalid");

    // Idempotency: a replayed rotation with the SAME hash just re-points.
    const existing = await rest<{ id: string }>("GET", "connector_credentials", {
      query: { credential_hash: `eq.${newHash}`, server_id: `eq.${cred.server_id}`, select: "id" },
    });
    let newId = existing[0]?.id;
    if (!newId) {
      const created = await rest<{ id: string }>("POST", "connector_credentials", {
        body: { server_id: cred.server_id, credential_hash: newHash },
        prefer: "return=representation",
      });
      newId = created[0]!.id;
    }
    await rest("PATCH", "servers", {
      body: { connector_id: newId, updated_at: new Date().toISOString() },
      query: { id: `eq.${cred.server_id}` },
    });
    const graceUntil = new Date(Date.now() + GRACE_SECONDS * 1000).toISOString();
    await rest("PATCH", "connector_credentials", {
      body: { expires_at: graceUntil },
      query: { server_id: `eq.${cred.server_id}`, id: `neq.${newId}`, expires_at: "is.null" },
    });
    await insertAudit({
      actorId: null, serverId: cred.server_id, action: "credential.rotated",
      detail: { grace_seconds: GRACE_SECONDS },
    });
    json(res, 200, { rotated: true, grace_seconds: GRACE_SECONDS });
  } catch {
    fail(res, 500, "rotate_failed");
  }
}
