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

interface AgentRow {
  id: string;
  server_id: string;
  adapter: string;
  adapter_version: string | null;
  health: string;
  capabilities: Record<string, unknown> | null;
}

interface ProjectRow {
  id: string;
  server_id: string;
  canonical_root: string;
  label: string | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") return fail(res, 405, "method_not_allowed");
  const user = await verifyAccessToken(req.headers.authorization);
  if (!user) return fail(res, 401, "unauthorized");
  try {
    const servers = await rest<Row>("GET", "servers", {
      query: { owner_id: `eq.${user.id}`, order: "created_at.desc" },
    });
    // Discovered capabilities (plan §7/§9). Scoped by the OWNER's server ids
    // so a connector report can never surface another account's rows.
    const ids = servers.map((s) => s.id);
    let agents: AgentRow[] = [];
    let projects: ProjectRow[] = [];
    if (ids.length > 0) {
      const filter = `in.(${ids.join(",")})`;
      [agents, projects] = await Promise.all([
        rest<AgentRow>("GET", "agents", {
          query: { server_id: filter, order: "adapter.asc" },
        }),
        rest<ProjectRow>("GET", "projects", {
          query: { server_id: filter, order: "canonical_root.asc" },
        }),
      ]);
    }
    json(res, 200, {
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        enrollment_state: s.enrollment_state,
        // Online = heartbeat within the last 2 minutes (gateway writes it).
        online: s.last_seen_at !== null &&
          Date.now() - new Date(s.last_seen_at).getTime() < 120_000,
        last_seen_at: s.last_seen_at,
        agents: agents
          .filter((a) => a.server_id === s.id)
          .map((a) => ({
            id: a.id,
            adapter: a.adapter,
            version: a.adapter_version,
            health: a.health,
            capabilities: a.capabilities ?? {},
          })),
        projects: projects
          .filter((p) => p.server_id === s.id)
          .map((p) => ({ id: p.id, root: p.canonical_root, label: p.label })),
      })),
    });
  } catch {
    fail(res, 500, "list_failed");
  }
}
