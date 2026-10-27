/**
 * Snapshot (Supabase export) → migration plan (Firebase Auth users +
 * Firestore documents) + report. Pure: no I/O, so it is unit-tested and the
 * plan can be reviewed as a file before anything is written.
 *
 * Identity mapping (docs/DATA_MIGRATION.md):
 *   - Supabase user UUID = Firebase UID, so every ownerId stays unchanged.
 *   - Google identities are carried over (provider google.com, Google `sub`),
 *     so the same Google account signs in to the same UID.
 *   - Email/password-only users get an account with no provider (UID and
 *     email reserved, no password; decision D2) and are flagged for review.
 *   - Agent UUIDs are preserved as `agentId`, so policies keep their agent_id.
 *
 * Timestamps are emitted as { "__ts": ISO } and converted at import.
 */
import { createHash } from "node:crypto";

export const PLAN_VERSION = 1;
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const ts = (v) => (v ? { __ts: new Date(v).toISOString() } : null);
const addDays = (iso, days) => (iso ? { __ts: new Date(Date.parse(iso) + days * 86_400_000).toISOString() } : null);
const SECRET_KEY = /token|credential|secret|password|code|key|authorization/i;
const MAX_SUMMARY_BYTES = 4096;

/** Tables that are deliberately not migrated, with the reason recorded per row. */
export const NOT_MIGRATED = {
  enrollments: "in-flight pairings are not carried over; re-pair after cutover (also avoids copying credential pickups)",
  pairing_codes: "legacy table, unused by v2 code (F-M5)",
  rate_limit_hits: "transient counters; Firestore limits start fresh",
  agent_sessions: "unused by code (F-M6)",
  chat_messages: "unused by code (F-M6)",
  app_config: "gateway URL changes at cutover; set appConfig/gateway_url by hand",
};

function redact(detail) {
  if (!detail || typeof detail !== "object") return {};
  return Object.fromEntries(Object.entries(detail).filter(([k]) => !SECRET_KEY.test(k)));
}

function boundedSummary(summary) {
  if (summary == null) return null;
  const text = JSON.stringify(summary);
  return Buffer.byteLength(text) <= MAX_SUMMARY_BYTES ? summary : { truncated: true, bytes: Buffer.byteLength(text) };
}

class Report {
  constructor() {
    this.tables = {};
    this.skipped = [];
    this.failed = [];
    this.flagged = [];
  }
  table(name) {
    return (this.tables[name] ??= { source: 0, planned: 0, skipped: 0, failed: 0 });
  }
  skip(table, id, reason) {
    this.table(table).skipped++;
    this.skipped.push({ table, id, reason });
  }
  fail(table, id, reason) {
    this.table(table).failed++;
    this.failed.push({ table, id, reason });
  }
  flag(table, id, reason) {
    this.flagged.push({ table, id, reason });
  }
}

/**
 * @param {object} snapshot  { manifest, auth_users, profiles, servers, connector_credentials,
 *                             agents, projects, permission_policies, permission_requests,
 *                             command_jobs, audit_events, ...counts for NOT_MIGRATED tables }
 * @returns {{ version: number, users: object[], docs: {path: string, data: object}[], report: Report }}
 */
export function transform(snapshot) {
  const report = new Report();
  const docs = [];
  const users = [];
  const plan = (table, path, data) => {
    report.table(table).planned++;
    docs.push({ path, data });
  };
  const rows = (name) => {
    const list = Array.isArray(snapshot[name]) ? snapshot[name] : [];
    report.table(name).source += list.length;
    return list;
  };

  // ---- identities ------------------------------------------------------------
  const userIds = new Set();
  for (const u of rows("auth_users")) {
    if (!u?.id || !u.email) {
      report.fail("auth_users", u?.id ?? "?", "missing id or email");
      continue;
    }
    const google = (u.identities ?? []).find((i) => i.provider === "google");
    const googleSub = google?.identity_data?.sub ?? google?.provider_id ?? google?.id ?? null;
    const user = {
      uid: u.id,
      email: u.email,
      emailVerified: Boolean(u.email_confirmed_at) || Boolean(google),
      displayName: u.user_metadata?.full_name ?? u.user_metadata?.name ?? null,
      disabled: Boolean(u.banned_until && Date.parse(u.banned_until) > Date.now()),
      providers: googleSub ? [{ providerId: "google.com", uid: String(googleSub), email: u.email }] : [],
      createdAt: u.created_at ?? null,
    };
    if (!googleSub) {
      report.flag("auth_users", u.id, "no Google identity: imported without a provider; must sign in with Google using the same email (verify linking in staging)");
    }
    users.push(user);
    userIds.add(u.id);
    report.table("auth_users").planned++;
  }

  const emailOf = new Map(users.map((u) => [u.uid, u.email]));
  const profiles = new Map(rows("profiles").map((p) => [p.id, p]));
  for (const u of users) {
    const p = profiles.get(u.uid);
    const name = (p?.display_name ?? u.displayName ?? u.email.split("@")[0] ?? "FRIDAY user").slice(0, 120) || "FRIDAY user";
    const data = {
      displayName: name,
      email: u.email,
      createdAt: ts(p?.created_at ?? u.createdAt) ?? ts(new Date().toISOString()),
      updatedAt: ts(p?.updated_at ?? u.createdAt) ?? ts(new Date().toISOString()),
    };
    if (p) {
      plan("profiles", `users/${u.uid}`, data);
    } else {
      // Every user gets a profile document; one with no source row is
      // counted as synthesized so source = planned + skipped + failed holds.
      report.table("profiles").synthesized = (report.table("profiles").synthesized ?? 0) + 1;
      docs.push({ path: `users/${u.uid}`, data });
    }
  }
  for (const p of profiles.values()) {
    if (!userIds.has(p.id)) report.fail("profiles", p.id, "profile without an auth user");
  }

  // ---- servers ------------------------------------------------------------------
  const serverOwner = new Map();
  for (const s of rows("servers")) {
    if (!userIds.has(s.owner_id)) {
      report.fail("servers", s.id, "owner not in auth export");
      continue;
    }
    serverOwner.set(s.id, s.owner_id);
    plan("servers", `servers/${s.id}`, {
      ownerId: s.owner_id,
      name: String(s.name ?? "server").slice(0, 120),
      hostLabel: s.host_label ?? null,
      enrollmentState: s.enrollment_state,
      connectorId: s.connector_id ?? null,
      lastSeenAt: ts(s.last_seen_at),
      createdAt: ts(s.created_at),
      updatedAt: ts(s.updated_at),
    });
  }

  for (const c of rows("connector_credentials")) {
    const owner = serverOwner.get(c.server_id);
    if (!owner) {
      report.fail("connector_credentials", c.id, "server not migrated");
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(c.credential_hash ?? "")) {
      report.fail("connector_credentials", c.id, "credential_hash is not a sha256 hex digest");
      continue;
    }
    plan("connector_credentials", `connectorCredentials/${c.credential_hash}`, {
      credentialId: c.id,
      serverId: c.server_id,
      ownerId: owner,
      createdAt: ts(c.created_at),
      expiresAt: ts(c.expires_at),
      revokedAt: ts(c.revoked_at),
      rotatedFrom: c.rotated_from ?? null,
    });
  }

  /** agent UUID → { serverId, adapter } (the agent-ID map). */
  const agentMap = new Map();
  const seenAdapters = new Set();
  for (const a of rows("agents")) {
    const owner = serverOwner.get(a.server_id);
    if (!owner) {
      report.fail("agents", a.id, "server not migrated");
      continue;
    }
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(a.adapter ?? "")) {
      report.fail("agents", a.id, "adapter name not valid as a document id");
      continue;
    }
    const key = `${a.server_id}/${a.adapter}`;
    if (seenAdapters.has(key)) {
      report.fail("agents", a.id, "duplicate (server, adapter)");
      continue;
    }
    seenAdapters.add(key);
    agentMap.set(a.id, { serverId: a.server_id, adapter: a.adapter });
    plan("agents", `servers/${a.server_id}/agents/${a.adapter}`, {
      agentId: a.id, // preserved: policies and envelopes refer to it
      ownerId: owner,
      serverId: a.server_id,
      adapter: a.adapter,
      adapterVersion: a.adapter_version ?? null,
      capabilities: a.capabilities ?? {},
      health: a.health ?? "unknown",
      discoveredAt: ts(a.discovered_at),
      updatedAt: ts(a.updated_at),
    });
  }

  const projectRoot = new Map();
  for (const p of rows("projects")) {
    const owner = serverOwner.get(p.server_id);
    if (!owner) {
      report.fail("projects", p.id, "server not migrated");
      continue;
    }
    projectRoot.set(p.id, { root: p.canonical_root, serverId: p.server_id });
    plan("projects", `servers/${p.server_id}/projects/${sha256(p.canonical_root)}`, {
      ownerId: owner,
      serverId: p.server_id,
      canonicalRoot: p.canonical_root,
      label: p.label ?? null,
      createdAt: ts(p.created_at),
    });
  }

  // ---- policies ----------------------------------------------------------------
  for (const pol of rows("permission_policies")) {
    if (!userIds.has(pol.owner_id)) {
      report.fail("permission_policies", pol.id, "owner not in auth export");
      continue;
    }
    if (pol.server_id && serverOwner.get(pol.server_id) !== pol.owner_id) {
      report.fail("permission_policies", pol.id, "server_id not migrated or owned by someone else");
      continue;
    }
    if (pol.agent_id && !agentMap.has(pol.agent_id)) {
      report.fail("permission_policies", pol.id, "agent_id not migrated");
      continue;
    }
    let root = null;
    if (pol.project_id) {
      const proj = projectRoot.get(pol.project_id);
      if (!proj) {
        report.fail("permission_policies", pol.id, "project_id not migrated");
        continue;
      }
      root = proj.root;
    }
    plan("permission_policies", `policies/${pol.id}`, {
      ownerId: pol.owner_id,
      serverScope: pol.server_id ?? "all",
      agentId: pol.agent_id ?? null,
      projectRoot: root,
      action: pol.action,
      executable: pol.executable ?? null,
      argumentPattern: pol.argument_pattern ?? null,
      decision: pol.decision,
      priority: Number(pol.priority ?? 100),
      version: Number(pol.version ?? 1),
      enabled: Boolean(pol.enabled),
      expiresAt: ts(pol.expires_at),
      createdAt: ts(pol.created_at),
      updatedAt: ts(pol.updated_at),
    });
  }

  // ---- jobs (ID scheme changes: sha256(serverId:idempotencyKey)) ----------------
  for (const j of rows("command_jobs")) {
    const owner = serverOwner.get(j.server_id);
    if (!owner) {
      report.fail("command_jobs", j.id, "server not migrated");
      continue;
    }
    const jobId = sha256(`${j.server_id}:${j.idempotency_key}`);
    plan("command_jobs", `servers/${j.server_id}/jobs/${jobId}`, {
      jobId,
      legacyId: j.id,
      ownerId: owner,
      serverId: j.server_id,
      idempotencyKey: j.idempotency_key,
      operation: j.operation,
      agentId: null,
      state: j.state,
      resultSummary: boundedSummary(j.result_summary),
      createdAt: ts(j.created_at),
      updatedAt: ts(j.updated_at),
      expireAt: addDays(j.updated_at ?? j.created_at, 90),
    });
  }

  // ---- approvals: history only; pending ones are expired at cutover --------------
  for (const r of rows("permission_requests")) {
    const owner = serverOwner.get(r.server_id);
    if (!owner) {
      report.fail("permission_requests", r.id, "server not migrated");
      continue;
    }
    const status = r.status === "pending" ? "expired" : r.status;
    if (r.status === "pending") report.flag("permission_requests", r.id, "pending at cutover: imported as expired");
    plan("permission_requests", `servers/${r.server_id}/permissionRequests/${String(r.id).replaceAll("-", "")}`, {
      legacyId: r.id,
      ownerId: owner,
      serverId: r.server_id,
      connectorId: r.connector_id ?? null,
      agentId: r.agent_id ?? null,
      sessionId: r.session_id ?? null,
      operation: r.operation,
      payloadHash: r.payload_hash,
      policyVersion: r.policy_version ?? null,
      status,
      requestedAt: ts(r.requested_at),
      expiresAt: ts(r.expires_at),
      decidedBy: r.decided_by ?? null,
      decidedAt: ts(r.decided_at),
      outcome: r.outcome ?? null,
      expireAt: addDays(r.expires_at, 30),
    });
  }

  // ---- audit -------------------------------------------------------------------------
  for (const e of rows("audit_events")) {
    const owner = e.actor_id && userIds.has(e.actor_id) ? e.actor_id : serverOwner.get(e.server_id);
    if (!owner) {
      report.skip("audit_events", String(e.id), "no owning user (actor and server both unknown)");
      continue;
    }
    plan("audit_events", `auditEvents/legacy-${e.id}`, {
      ownerId: owner,
      actorId: e.actor_id ?? "legacy:system",
      serverId: e.server_id ?? null,
      action: String(e.action).slice(0, 120),
      decision: e.decision ?? null,
      correlationId: e.correlation_id ?? null,
      detail: redact(e.detail),
      createdAt: ts(e.created_at),
      expireAt: addDays(e.created_at, 365),
    });
  }

  // ---- deliberately not migrated --------------------------------------------------------
  for (const [table, reason] of Object.entries(NOT_MIGRATED)) {
    const value = snapshot[table];
    const count = Array.isArray(value) ? value.length : Number(snapshot.counts?.[table] ?? 0);
    report.table(table).source += count;
    report.table(table).skipped += count;
    if (count > 0) report.skipped.push({ table, id: `${count} row(s)`, reason });
  }

  return {
    version: PLAN_VERSION,
    source: snapshot.manifest ?? null,
    agentIdMap: Object.fromEntries(agentMap),
    users,
    docs,
    report: { tables: report.tables, skipped: report.skipped, failed: report.failed, flagged: report.flagged },
  };
}
