/**
 * GET /api/v1/servers — the owner's enrolled servers (dashboard list).
 * Auth: Supabase access token; identity derived from the verified token, the
 * query is scoped by it — never by anything in the request.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAccessToken } from "../../../lib/auth.js";
import { rest } from "../../../lib/supabase.js";
import { json, fail } from "../../../lib/util.js";

interface Row {
  id: string;
  name: string;
  enrollment_state: string;
  last_seen_at: string | null;
  created_at: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") return fail(res, 405, "method_not_allowed");
  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");
  try {
    const servers = await rest<Row>("GET", "servers", {
      query: { owner_id: `eq.${user.id}`, order: "created_at.desc" },
    });
    json(res, 200, {
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        enrollment_state: s.enrollment_state,
        // Online = heartbeat within the last 2 minutes (gateway writes it).
        online: s.last_seen_at !== null &&
          Date.now() - new Date(s.last_seen_at).getTime() < 120_000,
        last_seen_at: s.last_seen_at,
      })),
    });
  } catch {
    fail(res, 500, "list_failed");
  }
}
