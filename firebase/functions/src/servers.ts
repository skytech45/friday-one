/**
 * Server list, credential-rotation trigger, job history and profile init.
 * Every query is scoped by the verified uid.
 */
import { COL, FieldValue, db, iso, millis } from "./db.js";
import { writeAudit } from "./audit.js";
import type { AuthUser } from "./auth.js";

const ONLINE_WINDOW_MS = 120_000; // heartbeat within 2 minutes (unchanged)

/** Creates users/{uid} on first contact; a no-op afterwards. */
export async function ensureProfile(user: AuthUser): Promise<void> {
  const now = FieldValue.serverTimestamp();
  try {
    await db.collection(COL.users).doc(user.uid).create({
      displayName: (user.email?.split("@")[0] ?? "FRIDAY user").slice(0, 120) || "FRIDAY user",
      email: user.email,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    if ((e as { code?: number }).code !== 6) throw e; // 6 = ALREADY_EXISTS
  }
}

/** GET /api/v1/servers: same response shape as the Vercel route. */
export async function listServers(uid: string): Promise<unknown[]> {
  const servers = await db.collection(COL.servers)
    .where("ownerId", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  return Promise.all(servers.docs.map(async (s) => {
    const [agents, projects] = await Promise.all([
      s.ref.collection(COL.agents).orderBy("adapter").limit(50).get(),
      s.ref.collection(COL.projects).orderBy("canonicalRoot").limit(50).get(),
    ]);
    const lastSeen = millis(s.get("lastSeenAt"));
    return {
      id: s.id,
      name: s.get("name"),
      enrollment_state: s.get("enrollmentState"),
      online: lastSeen !== null && Date.now() - lastSeen < ONLINE_WINDOW_MS,
      last_seen_at: iso(s.get("lastSeenAt")),
      agents: agents.docs.map((a) => ({
        // The protocol-level agent ID (a UUID); documents are keyed by adapter.
        id: a.get("agentId") ?? a.id,
        adapter: a.get("adapter"),
        version: a.get("adapterVersion") ?? null,
        health: a.get("health") ?? "unknown",
        capabilities: a.get("capabilities") ?? {},
      })),
      projects: projects.docs.map((p) => ({ id: p.id, root: p.get("canonicalRoot"), label: p.get("label") ?? null })),
    };
  }));
}

/**
 * POST /api/v1/servers/{id}/rotate: clearing connectorId makes the
 * connector's next policy sync report rotation_due; the connector then
 * submits a new credential hash (only the hash ever travels).
 */
export async function requestRotation(serverId: string, uid: string): Promise<boolean> {
  const ref = db.collection(COL.servers).doc(serverId);
  return db.runTransaction(async (tx) => {
    const s = (await tx.get(ref)).data();
    if (!s || s.ownerId !== uid || s.enrollmentState !== "active") return false;
    tx.update(ref, { connectorId: null, updatedAt: FieldValue.serverTimestamp() });
    writeAudit({ ownerId: uid, actorId: uid, serverId, action: "credential.rotation_requested" }, tx);
    return true;
  });
}

/** True only if the server exists and belongs to uid. */
export async function ownsServer(serverId: string, uid: string): Promise<boolean> {
  const s = await db.collection(COL.servers).doc(serverId).get();
  return s.exists && s.get("ownerId") === uid;
}

/**
 * GET /api/v1/jobs[?server_id=]: the Vercel route listed ANY server's jobs
 * when server_id was given (F-M9, cross-user read). Ownership is checked here.
 */
export async function listJobs(uid: string, serverId: string | undefined, limit: number): Promise<unknown[] | null> {
  let q: FirebaseFirestore.Query;
  if (serverId) {
    if (!(await ownsServer(serverId, uid))) return null;
    q = db.collection(COL.servers).doc(serverId).collection(COL.jobs);
  } else {
    q = db.collectionGroup(COL.jobs).where("ownerId", "==", uid);
  }
  const snap = await q.orderBy("updatedAt", "desc").limit(limit).get();
  return snap.docs.map((j) => ({
    id: j.id,
    server_id: j.get("serverId"),
    operation: j.get("operation"),
    state: j.get("state"),
    updated_at: iso(j.get("updatedAt")),
  }));
}
