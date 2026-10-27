/**
 * Durable state for the gateway on Cloud Firestore (replaces supabase.ts).
 * Data model: docs/FIREBASE_DATA_MODEL.md.
 *
 * SECURITY: the Admin SDK bypasses Firestore rules. Every call here is
 * scoped by IDs the gateway derived from an authenticated principal (the
 * connector's credential hash → its server; the app's verified uid), never
 * by IDs taken from a message payload alone.
 *
 * Credentials come from the runtime service account (Cloud Run) or ADC. No
 * key file is read by this code.
 */
import { createHash } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore, type DocumentReference } from "firebase-admin/firestore";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
if (getApps().length === 0) initializeApp(PROJECT_ID ? { projectId: PROJECT_ID } : undefined);

export const projectId = PROJECT_ID;
const db = getFirestore();
const auth = getAuth();

export const sha256hex = (v: string): string => createHash("sha256").update(v).digest("hex");
const millis = (v: unknown): number | null => (v instanceof Timestamp ? v.toMillis() : null);
const iso = (v: unknown): string | null => (v instanceof Timestamp ? v.toDate().toISOString() : null);

const JOB_RETENTION_MS = 90 * 86_400_000;
const REQUEST_RETENTION_MS = 30 * 86_400_000;
const MAX_SUMMARY_BYTES = 4096;

const serverRef = (serverId: string): DocumentReference => db.collection("servers").doc(serverId);

// ---- app identity ------------------------------------------------------------
const ALLOWED_PROVIDERS = new Set(
  (process.env.ALLOWED_SIGN_IN_PROVIDERS ?? "google.com").split(",").map((s) => s.trim()).filter(Boolean),
);

/**
 * Firebase ID token → uid, or null. Checks signature, expiry, issuer and
 * audience, revocation (once per connection), and the sign-in provider
 * (decision D2: Google only).
 */
export async function verifyAppToken(token: string): Promise<{ uid: string; expiresAtMs: number } | null> {
  try {
    const t = await auth.verifyIdToken(token, true);
    if (!ALLOWED_PROVIDERS.has(t.firebase?.sign_in_provider ?? "")) return null;
    return { uid: t.uid, expiresAtMs: t.exp * 1000 };
  } catch {
    return null;
  }
}

// ---- connector identity --------------------------------------------------------
export interface CredentialRow {
  /** credentialId (stable, non-secret) */
  id: string;
  hash: string;
  server_id: string;
}

function liveCredential(d: FirebaseFirestore.DocumentData | undefined): boolean {
  if (!d || d.revokedAt) return false;
  const exp = millis(d.expiresAt);
  return exp === null || exp > Date.now();
}

/** Credential auth (SYSTEM_DESIGN §7): hash lookup, revocation, expiry. */
export async function findLiveCredential(credential: string): Promise<CredentialRow | null> {
  const hash = sha256hex(credential);
  const d = (await db.collection("connectorCredentials").doc(hash).get()).data();
  if (!liveCredential(d)) return null;
  return { id: String(d!.credentialId), hash, server_id: String(d!.serverId) };
}

export interface ServerRow {
  id: string;
  owner_id: string;
  enrollment_state: string;
}

/** The connector's server must be ACTIVE and belong to a real owner. */
export async function getServerForCredential(cred: CredentialRow): Promise<ServerRow | null> {
  const d = (await serverRef(cred.server_id).get()).data();
  if (!d || d.enrollmentState !== "active" || typeof d.ownerId !== "string") return null;
  return { id: cred.server_id, owner_id: d.ownerId, enrollment_state: d.enrollmentState };
}

/**
 * Revocation propagation: listens to the credential and its server and calls
 * `onInvalid` once the credential is revoked, deleted or expired, or the
 * server leaves `active`. Typical latency: the Firestore listener delay
 * (about a second). Expiry is also enforced by a timer. Returns an unsubscribe.
 */
export function watchConnectorAuthorization(cred: CredentialRow, onInvalid: (reason: string) => void): () => void {
  let fired = false;
  let timer: NodeJS.Timeout | undefined;
  const fire = (reason: string): void => {
    if (fired) return;
    fired = true;
    onInvalid(reason);
  };
  const unsubCred = db.collection("connectorCredentials").doc(cred.hash).onSnapshot((snap) => {
    const d = snap.data();
    if (!liveCredential(d)) return fire("credential_revoked");
    const exp = millis(d!.expiresAt);
    if (timer) clearTimeout(timer);
    if (exp !== null) timer = setTimeout(() => fire("credential_expired"), Math.max(0, exp - Date.now()));
  }, () => fire("authorization_unavailable")); // fail closed if the listener breaks
  const unsubServer = serverRef(cred.server_id).onSnapshot((snap) => {
    if (snap.get("enrollmentState") !== "active") fire("server_not_active");
  }, () => fire("authorization_unavailable"));
  return () => {
    unsubCred();
    unsubServer();
    if (timer) clearTimeout(timer);
  };
}

// ---- heartbeat ------------------------------------------------------------------
const lastSeenWrite = new Map<string, number>();
const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * Throttled to one write per minute PER SERVER. (The Supabase version used
 * one process-wide timestamp, so with several connectors only one server's
 * heartbeat was written per minute and the others could look offline: F-M13.)
 */
export async function touchLastSeen(serverId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastSeenWrite.get(serverId) ?? 0) < LAST_SEEN_THROTTLE_MS) return;
  lastSeenWrite.set(serverId, now);
  await serverRef(serverId).update({ lastSeenAt: FieldValue.serverTimestamp() }).catch(() => undefined);
}

export function forgetServer(serverId: string): void {
  lastSeenWrite.delete(serverId);
}

// ---- jobs ------------------------------------------------------------------------
export interface CommandJobRow {
  id: string;
  server_id: string;
  state: string;
}

const jobRef = (serverId: string, jobId: string): DocumentReference => serverRef(serverId).collection("jobs").doc(jobId);
export const jobIdFor = (serverId: string, idempotencyKey: string): string => sha256hex(`${serverId}:${idempotencyKey}`);

/**
 * Persist BEFORE dispatch (§16 invariant 6). The job ID is derived from
 * (server, idempotency key), so a repeated submit maps to the same job.
 * `created` is false for a repeat, and the caller must NOT dispatch again:
 * the Supabase version reset a repeated job to `queued` and re-dispatched it,
 * which re-executed the prompt (F-M15).
 */
export async function createQueuedJob(input: {
  serverId: string; ownerId: string; idempotencyKey: string; operation: string; agentId: string | null;
}): Promise<{ job: CommandJobRow; created: boolean }> {
  const id = jobIdFor(input.serverId, input.idempotencyKey);
  const ref = jobRef(input.serverId, id);
  try {
    await ref.create({
      jobId: id,
      ownerId: input.ownerId,
      serverId: input.serverId,
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
      agentId: input.agentId,
      state: "queued",
      resultSummary: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + JOB_RETENTION_MS),
    });
    return { job: { id, server_id: input.serverId, state: "queued" }, created: true };
  } catch (e) {
    if ((e as { code?: number }).code !== 6) throw e; // 6 = ALREADY_EXISTS
    const d = (await ref.get()).data();
    return { job: { id, server_id: input.serverId, state: String(d?.state ?? "unknown") }, created: false };
  }
}

/** Job lookup, always within a server the caller is bound to. */
export async function findJob(serverId: string, jobId: string): Promise<CommandJobRow | null> {
  if (!/^[a-f0-9]{64}$/.test(jobId)) return null;
  const d = (await jobRef(serverId, jobId).get()).data();
  return d ? { id: jobId, server_id: serverId, state: String(d.state) } : null;
}

/** Bounded summary: anything over 4 KiB is replaced by a truncation marker. */
function boundedSummary(summary: unknown): unknown {
  if (summary === undefined) return undefined;
  const text = JSON.stringify(summary ?? null);
  return Buffer.byteLength(text) <= MAX_SUMMARY_BYTES ? summary ?? null : { truncated: true, bytes: Buffer.byteLength(text) };
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * Connector-reported progress. A terminal job is never moved again, so a
 * late `command.completed` cannot overwrite `cancelled`.
 */
export async function setJobState(serverId: string, jobId: string, state: string, resultSummary?: unknown): Promise<boolean> {
  const ref = jobRef(serverId, jobId);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || TERMINAL.has(String(d.state))) return false;
    const summary = boundedSummary(resultSummary);
    tx.update(ref, {
      state,
      ...(summary === undefined ? {} : { resultSummary: summary }),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

/** Job states a cancel may still interrupt; everything else is terminal. */
export const CANCELLABLE_JOB_STATES = ["queued", "dispatched", "accepted", "started"] as const;

/** Atomically cancel a job that is still in flight; false if terminal or unknown. */
export async function cancelJobIfInFlight(serverId: string, jobId: string): Promise<boolean> {
  const ref = jobRef(serverId, jobId);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || !(CANCELLABLE_JOB_STATES as readonly string[]).includes(String(d.state))) return false;
    tx.update(ref, { state: "cancelled", updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

// ---- capabilities -------------------------------------------------------------------
export interface AgentRow {
  id: string;
  server_id: string;
  adapter: string;
}

/**
 * Stable agent UUID (RFC 9562 version 8, name-based) for (server, adapter).
 * Envelopes require agent_id to be a UUID, while documents are keyed by
 * adapter name so re-reports upsert in place.
 */
export function agentUuid(serverId: string, adapter: string): string {
  const h = sha256hex(`agent:${serverId}:${adapter}`).slice(0, 32).split("");
  h[12] = "8"; // version 8
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16); // RFC variant
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * Upsert discovered agents under the connector's own server (never a
 * payload-supplied server). `agentId` is set only on first discovery, so a
 * UUID carried over by the data migration is kept.
 */
export async function upsertAgents(
  serverId: string, ownerId: string,
  agents: Array<{ adapter: string; version: string | null; health: string }>,
): Promise<void> {
  await Promise.all(agents.map(async (a) => {
    const ref = serverRef(serverId).collection("agents").doc(a.adapter);
    const fields = {
      ownerId, serverId, adapter: a.adapter, adapterVersion: a.version, health: a.health,
      updatedAt: FieldValue.serverTimestamp(),
    };
    try {
      await ref.create({
        ...fields, agentId: agentUuid(serverId, a.adapter), capabilities: {}, discoveredAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 6) throw e; // 6 = ALREADY_EXISTS
      await ref.update(fields);
    }
  }));
}

/** Resolve an adapter name to its agent (protocol UUID) for THIS server. */
export async function findAgent(serverId: string, adapter: string): Promise<AgentRow | null> {
  const snap = await serverRef(serverId).collection("agents").doc(adapter).get();
  if (!snap.exists) return null;
  const id = snap.get("agentId");
  return { id: typeof id === "string" ? id : agentUuid(serverId, adapter), server_id: serverId, adapter };
}

/** Descriptive record of the connector's allowed roots (it still enforces them locally). */
export async function upsertProjects(
  serverId: string, ownerId: string, projects: Array<{ root: string; label: string | null }>,
): Promise<void> {
  if (projects.length === 0) return;
  const batch = db.batch();
  for (const p of projects) {
    batch.set(serverRef(serverId).collection("projects").doc(sha256hex(p.root)), {
      ownerId, serverId, canonicalRoot: p.root, label: p.label, createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
}

// ---- permission requests --------------------------------------------------------------
export interface PermissionRequestRow {
  id: string;
  server_id: string;
  status: string;
  payload_hash: string;
  policy_version: number | null;
  expires_at: string;
}

export async function persistPermissionRequest(input: {
  serverId: string; ownerId: string; connectorId: string | null; agentId: string | null; sessionId: string | null;
  operation: string; payloadHash: string; policyVersion: number | null; ttlSeconds: number;
}): Promise<PermissionRequestRow> {
  const ref = serverRef(input.serverId).collection("permissionRequests").doc();
  const expiresAt = Timestamp.fromMillis(Date.now() + input.ttlSeconds * 1000);
  await ref.create({
    ownerId: input.ownerId,
    serverId: input.serverId,
    connectorId: input.connectorId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    operation: input.operation.slice(0, 200),
    payloadHash: input.payloadHash.slice(0, 128),
    policyVersion: input.policyVersion,
    status: "pending",
    requestedAt: FieldValue.serverTimestamp(),
    expiresAt,
    decidedBy: null,
    decidedAt: null,
    outcome: null,
    expireAt: Timestamp.fromMillis(expiresAt.toMillis() + REQUEST_RETENTION_MS),
  });
  return {
    id: ref.id, server_id: input.serverId, status: "pending", payload_hash: input.payloadHash,
    policy_version: input.policyVersion, expires_at: expiresAt.toDate().toISOString(),
  };
}

/**
 * Records a decision only if the request belongs to `ownerId`'s server, is
 * still pending and has not expired. (The Supabase version matched on ID and
 * status alone, so any signed-in user holding a request ID could decide
 * another user's request: F-M14.) Repeats are no-ops (null).
 */
export async function decidePermissionRequest(
  serverId: string, requestId: string, ownerId: string, decision: "approved" | "denied",
): Promise<PermissionRequestRow | null> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(requestId)) return null;
  const ref = serverRef(serverId).collection("permissionRequests").doc(requestId);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || d.ownerId !== ownerId || d.status !== "pending") return null;
    const exp = millis(d.expiresAt);
    if (exp === null || exp <= Date.now()) {
      tx.update(ref, { status: "expired" });
      return null;
    }
    tx.update(ref, { status: decision, decidedBy: ownerId, decidedAt: FieldValue.serverTimestamp() });
    return {
      id: requestId, server_id: serverId, status: decision, payload_hash: String(d.payloadHash),
      policy_version: typeof d.policyVersion === "number" ? d.policyVersion : null, expires_at: iso(d.expiresAt) ?? "",
    };
  });
}
