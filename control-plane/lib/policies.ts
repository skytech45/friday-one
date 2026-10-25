/**
 * Policy CRUD + connector policy sync (plan v2 §10 policy engine data).
 * Policies live in permission_policies; the connector pulls its effective
 * rules from /policies/sync immediately before execution (fail closed).
 */
import { rest } from "./supabase.js";

export interface PolicyRow {
  id: string;
  owner_id: string;
  server_id: string | null;
  agent_id: string | null;
  action: string;
  executable: string | null;
  decision: string;
  priority: number;
  version: number;
  enabled: boolean;
  expires_at: string | null;
  created_at: string;
}

const VALID_ACTIONS = new Set([
  "session.prompt", "shell.exec", "file.read", "file.write", "file.delete",
  "process.spawn", "credential.access", "terminal.stream",
]);
const VALID_DECISIONS = new Set(["allow", "deny", "require_approval"]);

export function validatePolicyInput(b: {
  action?: unknown; decision?: unknown; server_id?: unknown;
  agent_id?: unknown; executable?: unknown; priority?: unknown; expires_at?: unknown;
}): { ok: true; v: Record<string, unknown> } | { ok: false; why: string } {
  if (typeof b.action !== "string" || !VALID_ACTIONS.has(b.action)) {
    return { ok: false, why: "invalid action" };
  }
  if (typeof b.decision !== "string" || !VALID_DECISIONS.has(b.decision)) {
    return { ok: false, why: "invalid decision" };
  }
  const v: Record<string, unknown> = { action: b.action, decision: b.decision };
  if (b.server_id !== undefined && b.server_id !== null) {
    if (typeof b.server_id !== "string") return { ok: false, why: "invalid server_id" };
    v.server_id = b.server_id; // ownership re-checked by caller
  }
  if (b.agent_id !== undefined && b.agent_id !== null) {
    if (typeof b.agent_id !== "string") return { ok: false, why: "invalid agent_id" };
    v.agent_id = b.agent_id;
  }
  if (b.executable !== undefined && b.executable !== null) {
    if (typeof b.executable !== "string" || b.executable.length > 256) {
      return { ok: false, why: "invalid executable" };
    }
    v.executable = b.executable;
  }
  if (b.priority !== undefined) {
    const p = Number(b.priority);
    if (!Number.isInteger(p) || p < 0 || p > 1000) return { ok: false, why: "invalid priority" };
    v.priority = p;
  }
  if (b.expires_at !== undefined && b.expires_at !== null) {
    if (typeof b.expires_at !== "string" || Number.isNaN(Date.parse(b.expires_at))) {
      return { ok: false, why: "invalid expires_at" };
    }
    v.expires_at = b.expires_at;
  }
  return { ok: true, v };
}

export async function listPolicies(ownerId: string): Promise<Array<PolicyRow & { server_name: string | null }>> {
  // Left join server names for display; owner scope enforced in the filter.
  const rows = await rest<PolicyRow & { server_name?: string }>("GET", "permission_policies", {
    query: { owner_id: `eq.${ownerId}`, order: "created_at.desc", select: "*,servers(name)" },
  });
  return rows.map((r) => ({
    ...r,
    server_name: (r as { servers?: { name?: string }[] }).servers?.[0]?.name ?? null,
  }));
}

export async function createPolicy(ownerId: string, v: Record<string, unknown>): Promise<PolicyRow> {
  const rows = await rest<PolicyRow>("POST", "permission_policies", {
    body: { ...v, owner_id: ownerId, enabled: true, version: 1 },
    prefer: "return=representation",
  });
  return rows[0]!;
}

export async function getOwnedPolicy(id: string, ownerId: string): Promise<PolicyRow | null> {
  const rows = await rest<PolicyRow>("GET", "permission_policies", {
    query: { id: `eq.${id}`, owner_id: `eq.${ownerId}` },
  });
  return rows[0] ?? null;
}

export async function patchPolicy(id: string, patch: Record<string, unknown>): Promise<void> {
  await rest("PATCH", "permission_policies", {
    body: patch,
    query: { id: `eq.${id}` },
  });
}

/** Owner's server ids — used to reject policies pointing at foreign servers. */
export async function ownedServerIds(ownerId: string): Promise<Set<string>> {
  const rows = await rest<{ id: string }>("GET", "servers", { query: { owner_id: `eq.${ownerId}`, select: "id" } });
  return new Set(rows.map((r) => r.id));
}

export interface SyncRule {
  action: string;
  decision: string;
  agent_id: string | null;
  project_root: string | null;
  executable: string | null;
  priority: number;
  expires_at: string | null;
}

/**
 * Effective rules for a connector's server: policies scoped to that server
 * plus the owner's global (server-null) policies, enabled and unexpired,
 * with project canonical roots joined in. This is what the connector
 * evaluates IMMEDIATELY before execution.
 */
export async function syncRulesFor(serverId: string, ownerId: string): Promise<SyncRule[]> {
  const rows = await rest<PolicyRow & { projects?: { canonical_root?: string }[] }>(
    "GET",
    "permission_policies",
    {
      query: {
        or: `(server_id.eq.${serverId},and(server_id.is.null,owner_id.eq.${ownerId}))`,
        enabled: "eq.true",
        select: "*,projects(canonical_root)",
      },
    },
  );
  const now = Date.now();
  return rows
    .filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now)
    .map((r) => ({
      action: r.action,
      decision: r.decision,
      agent_id: r.agent_id,
      project_root: r.projects?.[0]?.canonical_root ?? null,
      executable: r.executable,
      priority: r.priority,
      expires_at: r.expires_at,
    }));
}

/** Durable audit trail (plan v2 §11 audit_events). Redacted by construction. */
export async function insertAudit(input: {
  actorId: string | null;
  serverId: string | null;
  action: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await rest("POST", "audit_events", {
    body: {
      actor_id: input.actorId,
      server_id: input.serverId,
      action: input.action,
      detail: input.detail ?? {},
    },
  });
}

export async function listAudit(ownerId: string): Promise<Array<{
  id: number; action: string; server_id: string | null; created_at: string; detail: unknown;
}>> {
  return rest("GET", "audit_events", {
    query: { actor_id: `eq.${ownerId}`, order: "created_at.desc", limit: "50" },
  });
}

export async function listJobs(ownerId: string, serverId?: string): Promise<Array<{
  id: string; server_id: string; operation: string; state: string; updated_at: string;
}>> {
  const servers = await rest<{ id: string }>("GET", "servers", { query: { owner_id: `eq.${ownerId}`, select: "id" } });
  const ids = servers.map((s) => s.id);
  if (ids.length === 0) return [];
  const filter = serverId ? `eq.${serverId}` : `in.(${ids.join(",")})`;
  return rest("GET", "command_jobs", {
    query: { server_id: filter, order: "updated_at.desc", limit: "50" },
  });
}
