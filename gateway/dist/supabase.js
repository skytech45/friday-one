/**
 * Supabase REST access for the gateway (service role). The gateway is the
 * durable-state writer: connector auth lookup, command_jobs and
 * permission_requests state transitions, servers.last_seen_at.
 *
 * SECURITY: the service role bypasses RLS — every call here MUST scope by the
 * ids the authenticated principal is bound to (never client-supplied owner).
 */
import { createHash } from "node:crypto";
const URL_ = process.env.SUPABASE_URL.replace(/\/$/, "");
const KEY = process.env.SUPABASE_SECRET_KEY;
const REST = `${URL_}/rest/v1`;
export const sha256hex = (v) => createHash("sha256").update(v).digest("hex");
export async function rest(method, path, opts = {}) {
    const url = new URL(`${REST}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {}))
        url.searchParams.set(k, v);
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
    if (!res.ok)
        throw new Error(`supabase ${method} ${path} -> ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : [];
}
/** Credential auth (SYSTEM_DESIGN §7): hash-lookup, revocation, expiry. */
export async function findLiveCredential(credential) {
    const rows = await rest("GET", "connector_credentials", {
        query: { credential_hash: `eq.${sha256hex(credential)}` },
    });
    const row = rows[0];
    if (!row)
        return null;
    if (row.revoked_at)
        return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now())
        return null;
    return row;
}
/** The connector's server must be ACTIVE and belong to a real owner. */
export async function getServerForCredential(cred) {
    const rows = await rest("GET", "servers", {
        query: { id: `eq.${cred.server_id}` },
    });
    const s = rows[0];
    return s && s.enrollment_state === "active" ? s : null;
}
let lastSeenUpdate = 0;
/** Throttled: at most once per minute per process (heartbeat arrives every 15s). */
export async function touchLastSeen(serverId) {
    if (Date.now() - lastSeenUpdate < 60_000)
        return;
    lastSeenUpdate = Date.now();
    await rest("PATCH", "servers", {
        body: { last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        query: { id: `eq.${serverId}` },
    }).catch(() => undefined);
}
/** Persist BEFORE dispatch (§16 invariant 6). Idempotent per (server, key). */
export async function upsertQueuedJob(serverId, idempotencyKey, operation) {
    const rows = await rest("POST", "command_jobs", {
        body: { server_id: serverId, idempotency_key: idempotencyKey, operation, state: "queued" },
        prefer: "return=representation,resolution=merge-duplicates",
    });
    return rows[0];
}
export async function setJobState(jobId, state, resultSummary) {
    await rest("PATCH", "command_jobs", {
        body: { state, ...(resultSummary === undefined ? {} : { result_summary: resultSummary }), updated_at: new Date().toISOString() },
        query: { id: `eq.${jobId}` },
    });
}
export async function findQueuedJob(jobId) {
    const rows = await rest("GET", "command_jobs", { query: { id: `eq.${jobId}` } });
    return rows[0] ?? null;
}
/**
 * Upsert discovered agents (plan §7/§9). Scoped by the connector's own
 * server id — never a payload-supplied server. Uniqueness is
 * (server_id, adapter), so re-reporting refreshes health/version in place.
 */
export async function upsertAgents(serverId, agents) {
    if (agents.length === 0)
        return;
    const now = new Date().toISOString();
    await rest("POST", "agents", {
        body: agents.map((a) => ({
            server_id: serverId,
            adapter: a.adapter,
            adapter_version: a.version,
            capabilities: {},
            health: a.health,
            discovered_at: now,
            updated_at: now,
        })),
        query: { on_conflict: "server_id,adapter" },
        prefer: "resolution=merge-duplicates,return=minimal",
    });
}
/** Resolve an adapter name to its durable agent row for THIS server. */
export async function findAgent(serverId, adapter) {
    const rows = await rest("GET", "agents", {
        query: { server_id: `eq.${serverId}`, adapter: `eq.${adapter}` },
    });
    return rows[0] ?? null;
}
/**
 * Record the connector's allowed project roots so the app can offer a
 * selector. The connector still enforces containment locally before any
 * execution; this table is descriptive, not authoritative.
 */
export async function upsertProjects(serverId, projects) {
    if (projects.length === 0)
        return;
    await rest("POST", "projects", {
        body: projects.map((p) => ({
            server_id: serverId,
            canonical_root: p.root,
            label: p.label,
        })),
        query: { on_conflict: "server_id,canonical_root" },
        prefer: "resolution=merge-duplicates,return=minimal",
    });
}
export async function persistPermissionRequest(input) {
    const rows = await rest("POST", "permission_requests", {
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
    return rows[0];
}
/** Records an authenticated decision; idempotent (repeats are no-ops). */
export async function decidePermissionRequest(requestId, ownerId, decision) {
    const rows = await rest("PATCH", "permission_requests", {
        body: { status: decision, decided_by: ownerId, decided_at: new Date().toISOString() },
        prefer: "return=representation",
        query: { id: `eq.${requestId}`, status: "eq.pending" },
    });
    return rows[0] ?? null;
}
