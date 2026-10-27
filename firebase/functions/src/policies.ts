/**
 * Policy CRUD (owner, via the API) and connector policy sync.
 * Port of control-plane/lib/policies.ts; validation rules are unchanged.
 * `serverScope` is the server ID, or "all" for owner-wide rules.
 */
import { COL, FieldValue, Timestamp, db, iso, millis } from "./db.js";
import { writeAudit } from "./audit.js";
import { field } from "./http.js";

const VALID_ACTIONS = new Set([
  "session.prompt", "shell.exec", "file.read", "file.write", "file.delete",
  "process.spawn", "credential.access", "terminal.stream",
]);
const VALID_DECISIONS = new Set(["allow", "deny", "require_approval"]);
const ALL = "all";

export interface PolicyInput {
  action: string;
  decision: string;
  serverId: string | null;
  agentId: string | null;
  executable: string | null;
  priority: number;
  expiresAt: Timestamp | null;
}

export function validatePolicyInput(body: unknown): { ok: true; v: PolicyInput } | { ok: false; why: string } {
  const action = field(body, "action");
  const decision = field(body, "decision");
  const serverId = field(body, "server_id");
  const agentId = field(body, "agent_id");
  const executable = field(body, "executable");
  const priority = field(body, "priority");
  const expiresAt = field(body, "expires_at");
  if (typeof action !== "string" || !VALID_ACTIONS.has(action)) return { ok: false, why: "invalid action" };
  if (typeof decision !== "string" || !VALID_DECISIONS.has(decision)) return { ok: false, why: "invalid decision" };
  if (serverId != null && (typeof serverId !== "string" || serverId.length > 128)) return { ok: false, why: "invalid server_id" };
  if (agentId != null && (typeof agentId !== "string" || agentId.length > 128)) return { ok: false, why: "invalid agent_id" };
  if (executable != null && (typeof executable !== "string" || executable.length > 256)) {
    return { ok: false, why: "invalid executable" };
  }
  let p = 100;
  if (priority !== undefined) {
    p = Number(priority);
    if (!Number.isInteger(p) || p < 0 || p > 1000) return { ok: false, why: "invalid priority" };
  }
  let exp: Timestamp | null = null;
  if (expiresAt != null) {
    if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return { ok: false, why: "invalid expires_at" };
    exp = Timestamp.fromMillis(Date.parse(expiresAt));
  }
  return {
    ok: true,
    v: {
      action, decision,
      serverId: (serverId as string | null | undefined) ?? null,
      agentId: (agentId as string | null | undefined) ?? null,
      executable: (executable as string | null | undefined) ?? null,
      priority: p,
      expiresAt: exp,
    },
  };
}

/** API row shape (snake_case, as the Vercel route returned it). */
function toRow(id: string, d: FirebaseFirestore.DocumentData, serverName?: string | null): Record<string, unknown> {
  const scope = d.serverScope === ALL ? null : (d.serverScope ?? null);
  return {
    id,
    owner_id: d.ownerId,
    server_id: scope,
    agent_id: d.agentId ?? null,
    action: d.action,
    executable: d.executable ?? null,
    decision: d.decision,
    priority: d.priority,
    version: d.version,
    enabled: d.enabled,
    expires_at: iso(d.expiresAt),
    created_at: iso(d.createdAt),
    ...(serverName !== undefined ? { server_name: serverName } : {}),
  };
}

export async function listPolicies(uid: string): Promise<unknown[]> {
  const [policies, servers] = await Promise.all([
    db.collection(COL.policies).where("ownerId", "==", uid).orderBy("createdAt", "desc").limit(200).get(),
    db.collection(COL.servers).where("ownerId", "==", uid).select("name").get(),
  ]);
  const names = new Map(servers.docs.map((s) => [s.id, String(s.get("name"))]));
  return policies.docs.map((p) => toRow(p.id, p.data(), names.get(String(p.get("serverScope"))) ?? null));
}

export async function createPolicy(uid: string, v: PolicyInput): Promise<Record<string, unknown>> {
  const ref = db.collection(COL.policies).doc();
  const doc = {
    ownerId: uid,
    serverScope: v.serverId ?? ALL,
    agentId: v.agentId,
    projectRoot: null,
    action: v.action,
    executable: v.executable,
    argumentPattern: null,
    decision: v.decision,
    priority: v.priority,
    version: 1,
    enabled: true,
    expiresAt: v.expiresAt,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.runTransaction(async (tx) => {
    tx.create(ref, doc);
    writeAudit({
      ownerId: uid, actorId: uid, serverId: v.serverId, action: "policy.created",
      detail: { policy_id: ref.id, action_rule: v.action, decision: v.decision },
    }, tx);
  });
  return toRow(ref.id, (await ref.get()).data() ?? doc);
}

export type PolicyPatch = { enabled?: boolean; decision?: string };

/**
 * PATCH (enable/disable, change decision) or DELETE (soft: disabled and
 * expired). Every change bumps `version`, so approvals bound to the old
 * version die. Returns false when the policy is missing or not uid's.
 */
export async function changePolicy(uid: string, id: string, change: PolicyPatch | "delete"): Promise<boolean> {
  const ref = db.collection(COL.policies).doc(id);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || d.ownerId !== uid) return false;
    const serverId = d.serverScope === ALL ? null : String(d.serverScope);
    const update = change === "delete"
      ? { enabled: false, expiresAt: Timestamp.now() }
      : { ...change };
    tx.update(ref, { ...update, version: Number(d.version ?? 1) + 1, updatedAt: FieldValue.serverTimestamp() });
    writeAudit({
      ownerId: uid, actorId: uid, serverId,
      action: change === "delete" ? "policy.revoked" : "policy.updated",
      detail: change === "delete" ? { policy_id: id } : { policy_id: id, patch: change },
    }, tx);
    return true;
  });
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
 * Effective rules for one server: the owner's rules scoped to that server
 * plus owner-wide ones, enabled and unexpired. The connector evaluates these
 * immediately before every execution (fail closed if unreachable).
 */
export async function syncRulesFor(serverId: string, ownerId: string): Promise<SyncRule[]> {
  const snap = await db.collection(COL.policies)
    .where("ownerId", "==", ownerId)
    .where("serverScope", "in", [serverId, ALL])
    .where("enabled", "==", true)
    .limit(500)
    .get();
  const now = Date.now();
  return snap.docs
    .map((p) => p.data())
    .filter((d) => {
      const exp = millis(d.expiresAt);
      return exp === null || exp > now;
    })
    .map((d) => ({
      action: d.action,
      decision: d.decision,
      agent_id: d.agentId ?? null,
      project_root: d.projectRoot ?? null,
      executable: d.executable ?? null,
      priority: Number(d.priority ?? 100),
      expires_at: iso(d.expiresAt),
    }));
}
