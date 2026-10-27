/**
 * Enrollment state machine (port of control-plane/lib/enrollments.ts).
 *
 *   created ──open──▶ pending_connector ──claim──▶ claim_requested ──pickup──▶ paired
 *        (token, 30 min)        (display code, 10 min,       (credential held
 *                                5 attempts)                  until pickup)
 *
 * Each transition is one Firestore transaction, so concurrent requests
 * cannot both pass a check. That fixes two races in the Vercel version: the
 * attempt counter could be bypassed by parallel claims, and a claim that
 * lost the race left an issued, unrevoked credential behind.
 *
 * Owner identity always comes from the verified token. Raw tokens, codes
 * and credentials are never logged; only their SHA-256 is stored, except
 * the one-time credential pickup (see FIREBASE_DATA_MODEL.md, principle 6).
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { COL, FieldValue, Timestamp, db, hashEquals, inDays, inMs, millis, sha256hex } from "./db.js";
import { writeAudit } from "./audit.js";

const ENROLL_TOKEN_TTL_MS = 30 * 60_000;
const DISPLAY_CODE_TTL_MS = 10 * 60_000;
const MAX_CLAIM_ATTEMPTS = 5;

/** 16–20 digit CSPRNG numeric code (shown on the terminal and in the QR). */
function newDisplayCode(): string {
  const digits = 16 + randomInt(0, 5);
  let code = "";
  for (let i = 0; i < digits; i++) code += String(randomInt(0, 10));
  return code;
}

async function enrollmentForToken(token: string): Promise<FirebaseFirestore.DocumentReference | null> {
  const t = await db.collection(COL.enrollmentTokens).doc(sha256hex(token)).get();
  const id = t.get("enrollmentId");
  return typeof id === "string" ? db.collection(COL.enrollments).doc(id) : null;
}

/** POST /api/v1/enrollments: the app creates a pending server + enrollment. */
export async function createEnrollment(ownerId: string, name: string): Promise<{
  enrollmentId: string; serverId: string; enrollmentToken: string; expiresAt: string;
}> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = inMs(ENROLL_TOKEN_TTL_MS);
  // Server IDs must be UUIDs: the realtime protocol's envelope schema
  // (gateway + connector) requires server_id to be one.
  const server = db.collection(COL.servers).doc(randomUUID());
  const enrollment = db.collection(COL.enrollments).doc();
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.create(server, {
    ownerId, name, hostLabel: null, enrollmentState: "pending", connectorId: null,
    lastSeenAt: null, createdAt: now, updatedAt: now,
  });
  batch.create(enrollment, {
    serverId: server.id, ownerId, state: "created", tokenExpiresAt: expiresAt,
    displayCodeHash: null, displayCodeExpiresAt: null, claimAttempts: 0,
    credentialPickup: null, credentialPickedUpAt: null, createdAt: now, updatedAt: now,
    expireAt: inDays(1),
  });
  batch.create(db.collection(COL.enrollmentTokens).doc(sha256hex(token)), {
    enrollmentId: enrollment.id, expiresAt, expireAt: inDays(1),
  });
  await batch.commit();
  return {
    enrollmentId: enrollment.id,
    serverId: server.id,
    enrollmentToken: token,
    expiresAt: expiresAt.toDate().toISOString(),
  };
}

/**
 * Connector: exchange the enrollment token for the display code. Returns
 * the raw code exactly once; only its hash is stored.
 */
export async function openEnrollmentSession(token: string): Promise<{
  enrollmentId: string; serverId: string; displayCode: string; displayCodeExpiresAt: string;
} | null> {
  const ref = await enrollmentForToken(token);
  if (!ref) return null;
  const code = newDisplayCode();
  const codeExp = inMs(DISPLAY_CODE_TTL_MS);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    const tokenExp = millis(d?.tokenExpiresAt);
    if (!d || d.state !== "created" || tokenExp === null || tokenExp <= Date.now()) return null;
    tx.update(ref, {
      state: "pending_connector",
      displayCodeHash: sha256hex(code),
      displayCodeExpiresAt: codeExp,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      enrollmentId: ref.id,
      serverId: String(d.serverId),
      displayCode: code,
      displayCodeExpiresAt: codeExp.toDate().toISOString(),
    };
  });
}

export type ClaimFailure = "not_found" | "not_owner" | "expired" | "too_many_attempts" | "bad_code" | "not_pending";

/**
 * App: claim with the code from the terminal. Burns an attempt on every
 * try; on success issues the connector credential, binds it to the server
 * (so the first policy sync does not report a spurious rotation, F-M10) and
 * parks it for one-time pickup.
 */
export async function claimEnrollment(
  enrollmentId: string, uid: string, code: string,
): Promise<{ ok: true; serverId: string } | { ok: false; reason: ClaimFailure }> {
  const ref = db.collection(COL.enrollments).doc(enrollmentId);
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d) return { ok: false, reason: "not_found" } as const;
    if (d.ownerId !== uid) return { ok: false, reason: "not_owner" } as const;
    if (d.state !== "pending_connector") return { ok: false, reason: "not_pending" } as const;
    const attempts = Number(d.claimAttempts ?? 0);
    if (attempts >= MAX_CLAIM_ATTEMPTS) return { ok: false, reason: "too_many_attempts" } as const;
    const codeExp = millis(d.displayCodeExpiresAt);
    if (codeExp === null || codeExp <= Date.now()) return { ok: false, reason: "expired" } as const;

    if (typeof d.displayCodeHash !== "string" || !hashEquals(d.displayCodeHash, sha256hex(code))) {
      tx.update(ref, { claimAttempts: attempts + 1, updatedAt: FieldValue.serverTimestamp() });
      return { ok: false, reason: "bad_code" } as const;
    }

    const credential = randomBytes(32).toString("base64url");
    const credentialId = randomUUID();
    const serverId = String(d.serverId);
    tx.create(db.collection(COL.credentials).doc(sha256hex(credential)), {
      credentialId, serverId, ownerId: uid,
      createdAt: FieldValue.serverTimestamp(), expiresAt: null, revokedAt: null, rotatedFrom: null,
    });
    tx.update(db.collection(COL.servers).doc(serverId), {
      connectorId: credentialId, updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(ref, {
      state: "claim_requested",
      claimAttempts: attempts + 1,
      credentialPickup: credential,
      updatedAt: FieldValue.serverTimestamp(),
    });
    writeAudit({ ownerId: uid, actorId: uid, serverId, action: "enrollment.claimed" }, tx);
    return { ok: true, serverId } as const;
  });
}

/**
 * Connector: collect the credential once. The pickup is cleared in the same
 * transaction that marks the enrollment paired and the server active.
 */
export async function pickupCredential(token: string): Promise<{
  credential: string; serverId: string; enrollmentId: string;
} | null> {
  const ref = await enrollmentForToken(token);
  if (!ref) return null;
  return db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || d.state !== "claim_requested" || typeof d.credentialPickup !== "string") return null;
    const serverId = String(d.serverId);
    tx.update(ref, {
      state: "paired",
      credentialPickup: FieldValue.delete(),
      credentialPickedUpAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(db.collection(COL.servers).doc(serverId), {
      enrollmentState: "active", updatedAt: FieldValue.serverTimestamp(),
    });
    writeAudit({ ownerId: String(d.ownerId), actorId: "connector:enrollment", serverId, action: "enrollment.paired" }, tx);
    return { credential: d.credentialPickup as string, serverId, enrollmentId: ref.id };
  });
}

const LIVE_ENROLLMENT_STATES = ["created", "pending_connector", "claim_requested", "paired", "online"];

/** Owner revocation: server revoked, every credential dead, enrollments closed. */
export async function revokeServer(serverId: string, uid: string): Promise<boolean> {
  const server = db.collection(COL.servers).doc(serverId);
  return db.runTransaction(async (tx) => {
    const s = (await tx.get(server)).data();
    if (!s || s.ownerId !== uid || s.enrollmentState !== "active") return false;
    const creds = await tx.get(db.collection(COL.credentials).where("serverId", "==", serverId));
    const enrollments = await tx.get(db.collection(COL.enrollments).where("serverId", "==", serverId));
    const now = Timestamp.now();
    tx.update(server, { enrollmentState: "revoked", connectorId: null, updatedAt: FieldValue.serverTimestamp() });
    for (const c of creds.docs) if (!c.get("revokedAt")) tx.update(c.ref, { revokedAt: now });
    for (const e of enrollments.docs) {
      if (LIVE_ENROLLMENT_STATES.includes(String(e.get("state")))) {
        tx.update(e.ref, { state: "revoked", credentialPickup: FieldValue.delete(), updatedAt: now });
      }
    }
    writeAudit({ ownerId: uid, actorId: uid, serverId, action: "server.revoked" }, tx);
    return true;
  });
}
