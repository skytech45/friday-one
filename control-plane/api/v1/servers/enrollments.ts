/**
 * POST /api/v1/servers/enrollments — create a server + single-use pairing code.
 * Auth: Supabase access token (verified via JWKS). Identity derives from the
 * token; the request body can only name the server.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAccessToken } from "../../../lib/auth.js";
import { insertPairingCode, insertServer } from "../../../lib/supabase.js";
import { json, fail } from "../../../lib/util.js";

const PAIRING_TTL_SECONDS = 15 * 60;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");

  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");

  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  if (!name) return fail(res, 400, "invalid_request");

  try {
    const server = await insertServer(user.id, name);
    const { code, expiresAt } = await insertPairingCode(server.id, PAIRING_TTL_SECONDS);
    // The code exists ONLY in this response: hashed at rest, single-use.
    json(res, 201, { server_id: server.id, code, expires_at: expiresAt });
  } catch {
    fail(res, 500, "enrollment_failed");
  }
}
