/**
 * Connector-authenticated endpoints: policy sync and credential rotation.
 * The caller is identified ONLY by its credential hash (auth.ts).
 */
import { randomUUID } from "node:crypto";
import { COL, FieldValue, Timestamp, db } from "./db.js";
import { writeAudit } from "./audit.js";
import { syncRulesFor, type SyncRule } from "./policies.js";
import type { LiveCredential } from "./auth.js";

const GRACE_SECONDS = Number(process.env.ROTATE_GRACE_SECONDS ?? 600);

/** Returns null when the credential's server is not active (403 server_not_active). */
export async function policySync(cred: LiveCredential): Promise<{
  version: number; server_id: string; rules: SyncRule[]; rotation_due: boolean;
} | null> {
  const server = (await db.collection(COL.servers).doc(cred.serverId).get()).data();
  if (!server || server.enrollmentState !== "active") return null;
  const rules = await syncRulesFor(cred.serverId, String(server.ownerId));
  return {
    version: Date.now(),
    server_id: cred.serverId,
    rules,
    // A cleared or different pointer means the owner asked for rotation.
    rotation_due: server.connectorId !== cred.credentialId,
  };
}

export type RotateResult = { ok: true; graceSeconds: number } | { ok: false; status: number; error: string };

/**
 * POST /api/v1/connector/rotate-credential { new_credential_hash }.
 * Idempotent: replaying the same hash re-points to the same credential.
 * Every other unexpired credential of the server gets a grace expiry.
 */
export async function rotateCredential(cred: LiveCredential, newHash: string): Promise<RotateResult> {
  const serverRef = db.collection(COL.servers).doc(cred.serverId);
  const newRef = db.collection(COL.credentials).doc(newHash);
  return db.runTransaction(async (tx): Promise<RotateResult> => {
    const server = (await tx.get(serverRef)).data();
    if (!server || server.enrollmentState !== "active") return { ok: false, status: 403, error: "server_not_active" };
    const existing = (await tx.get(newRef)).data();
    if (existing && existing.serverId !== cred.serverId) return { ok: false, status: 409, error: "hash_conflict" };
    if (existing?.revokedAt) return { ok: false, status: 403, error: "credential_revoked" };
    const others = await tx.get(db.collection(COL.credentials).where("serverId", "==", cred.serverId));

    const newId = existing ? String(existing.credentialId) : randomUUID();
    if (!existing) {
      tx.create(newRef, {
        credentialId: newId, serverId: cred.serverId, ownerId: cred.ownerId,
        createdAt: FieldValue.serverTimestamp(), expiresAt: null, revokedAt: null, rotatedFrom: cred.credentialId,
      });
    }
    tx.update(serverRef, { connectorId: newId, updatedAt: FieldValue.serverTimestamp() });
    const graceUntil = Timestamp.fromMillis(Date.now() + GRACE_SECONDS * 1000);
    for (const c of others.docs) {
      if (c.id !== newHash && !c.get("expiresAt") && !c.get("revokedAt")) tx.update(c.ref, { expiresAt: graceUntil });
    }
    writeAudit({
      ownerId: cred.ownerId, actorId: `connector:${cred.credentialId}`, serverId: cred.serverId,
      action: "credential.rotated", detail: { grace_seconds: GRACE_SECONDS },
    }, tx);
    return { ok: true, graceSeconds: GRACE_SECONDS };
  });
}
