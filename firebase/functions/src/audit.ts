/**
 * Audit trail (auditEvents). Written only here and by the gateway; clients
 * can read their own events and never write them (firestore.rules R-8).
 *
 * Redaction is by construction: callers pass small detail maps, and any key
 * that looks like a secret is dropped before the write.
 */
import type { Transaction } from "firebase-admin/firestore";
import { COL, FieldValue, db, inDays, iso } from "./db.js";

const SECRET_KEY = /token|credential|secret|password|code|key|authorization/i;
const AUDIT_RETENTION_DAYS = 365;

export interface AuditInput {
  /** The user who owns the affected resource (drives read access). */
  ownerId: string;
  /** uid of the acting user, or "connector:<credentialId>". */
  actorId: string;
  serverId: string | null;
  action: string;
  detail?: Record<string, unknown>;
}

export function redact(detail: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(detail).filter(([k]) => !SECRET_KEY.test(k)));
}

export function writeAudit(e: AuditInput, tx?: Transaction): void | Promise<unknown> {
  const ref = db.collection(COL.audit).doc();
  const doc = {
    ownerId: e.ownerId,
    actorId: e.actorId,
    serverId: e.serverId,
    action: e.action.slice(0, 120),
    decision: null,
    correlationId: null,
    detail: redact(e.detail ?? {}),
    createdAt: FieldValue.serverTimestamp(),
    expireAt: inDays(AUDIT_RETENTION_DAYS),
  };
  return tx ? void tx.create(ref, doc) : ref.create(doc);
}

export async function listAudit(ownerId: string, limit: number): Promise<unknown[]> {
  const snap = await db.collection(COL.audit)
    .where("ownerId", "==", ownerId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => ({
    id: d.id,
    action: d.get("action"),
    server_id: d.get("serverId") ?? null,
    created_at: iso(d.get("createdAt")),
    detail: d.get("detail") ?? {},
  }));
}
