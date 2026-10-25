/**
 * Supabase REST access for the gateway (service role). The gateway is the
 * durable-state writer: connector auth lookup, command_jobs and
 * permission_requests state transitions, servers.last_seen_at.
 *
 * SECURITY: the service role bypasses RLS — every call here MUST scope by the
 * ids the authenticated principal is bound to (never client-supplied owner).
 */
import { createHash } from "node:crypto";

const URL_ = process.env.SUPABASE_URL!.replace(/\/$/, "");
const KEY = process.env.SUPABASE_SECRET_KEY!;
const REST = `${URL_}/rest/v1`;

export const sha256hex = (v: string): string => createHash("sha256").update(v).digest("hex");

export async function rest<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  opts: { body?: unknown; prefer?: string; query?: Record<string, string> } = {},
): Promise<T[]> {
  const url = new URL(`${REST}/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...(opts.prefer ? { prefer: opts.prefer } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) throw new Error(`supabase ${method} ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T[]) : [];
}

export interface CredentialRow {
  id: string;
  server_id: string;
  revoked_at: string | null;
  expires_at: string | null;
}

/** Credential auth (SYSTEM_DESIGN §7): hash-lookup, revocation, expiry. */
export async function findLiveCredential(credential: string): Promise<CredentialRow | null> {
  const rows = await rest<CredentialRow>("GET", "connector_credentials", {
    query: { credential_hash: `eq.${sha256hex(credential)}` },
  });
  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export interface ServerRow {
  id: string;
  owner_id: string;
  enrollment_state: string;
}

/** The connector's server must be ACTIVE and belong to a real owner. */
export async function getServerForCredential(cred: CredentialRow): Promise<ServerRow | null> {
  const rows = await rest<ServerRow>("GET", "servers", {
    query: { id: `eq.${cred.server_id}` },
  });
  const s = rows[0];
  return s && s.enrollment_state === "active" ? s : null;
}

let lastSeenUpdate = 0;
/** Throttled: at most once per minute per process (heartbeat arrives every 15s). */
export async function touchLastSeen(serverId: string): Promise<void> {
  if (Date.now() - lastSeenUpdate < 60_000) return;
  lastSeenUpdate = Date.now();
  await rest("PATCH", "servers", {
    body: { last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    query: { id: `eq.${serverId}` },
  }).catch(() => undefined);
}

export interface CommandJobRow {
  id: string;
  server_id: string;
  state: string;
}

/** Persist BEFORE dispatch (§16 invariant 6). Idempotent per (server, key). */
export async function upsertQueuedJob(
  serverId: string,
  idempotencyKey: string,
  operation: string,
): Promise<CommandJobRow> {
  const rows = await rest<CommandJobRow>("POST", "command_jobs", {
    body: { server_id: serverId, idempotency_key: idempotencyKey, operation, state: "queued" },
    prefer: "return=representation,resolution=merge-duplicates",
  });
  return rows[0]!;
}

export async function setJobState(jobId: string, state: string, resultSummary?: unknown): Promise<void> {
  await rest("PATCH", "command_jobs", {
    body: { state, ...(resultSummary === undefined ? {} : { result_summary: resultSummary }), updated_at: new Date().toISOString() },
    query: { id: `eq.${jobId}` },
  });
}

export async function findQueuedJob(jobId: string): Promise<CommandJobRow | null> {
  const rows = await rest<CommandJobRow>("GET", "command_jobs", { query: { id: `eq.${jobId}` } });
  return rows[0] ?? null;
}

export interface PermissionRequestRow {
  id: string;
  server_id: string;
  status: string;
  payload_hash: string;
  policy_version: number | null;
  expires_at: string;
}

export async function persistPermissionRequest(input: {
  serverId: string;
  connectorId: string | null;
  agentId: string | null;
  sessionId: string | null;
  operation: string;
  payloadHash: string;
  policyVersion: number | null;
  ttlSeconds: number;
}): Promise<PermissionRequestRow> {
  const rows = await rest<PermissionRequestRow>("POST", "permission_requests", {
    body: {
      server_id: input.serverId,
      connector_id: input.connectorId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      operation: input.operation,
      payload_hash: input.payloadHash,
      policy_version: input.policyVersion,
      expires_at: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      status: "pending",
    },
    prefer: "return=representation",
  });
  return rows[0]!;
}

/** Records an authenticated decision; idempotent (repeats are no-ops). */
export async function decidePermissionRequest(
  requestId: string,
  ownerId: string,
  decision: "approved" | "denied",
): Promise<PermissionRequestRow | null> {
  const rows = await rest<PermissionRequestRow>("PATCH", "permission_requests", {
    body: { status: decision, decided_by: ownerId, decided_at: new Date().toISOString() },
    prefer: "return=representation",
    query: { id: `eq.${requestId}`, status: "eq.pending" },
  });
  return rows[0] ?? null;
}
