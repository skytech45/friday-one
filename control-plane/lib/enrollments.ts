/**
 * Plan v2.0 §4/§7 enrollment state machine, server side.
 * All state transitions are atomic (UPDATE ... WHERE state=expected) and
 * owner identity ALWAYS comes from the verified JWT, never the body.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { rest, sha256hex } from "./supabase.js";

const ENROLL_TOKEN_TTL_S = 30 * 60; // install window
const DISPLAY_CODE_TTL_S = 10 * 60; // plan target: 5–10 minutes
const MAX_CLAIM_ATTEMPTS = 5;

export interface EnrollmentRow {
  id: string;
  server_id: string;
  owner_id: string;
  state: string;
  display_code_hash: string | null;
  display_code_expires_at: string | null;
  claim_attempts: number;
  credential_pickup: string | null;
  token_expires_at: string | null;
}

/** 16–20 digit CSPRNG numeric code (plan: display on terminal + QR). */
function newDisplayCode(): string {
  const digits = 16 + randomInt(0, 5); // 16..20
  let code = "";
  for (let i = 0; i < digits; i++) code += String(randomInt(0, 10));
  return code;
}

/** POST /api/v1/enrollments — app creates enrollment; token returned ONCE. */
export async function createEnrollment(ownerId: string, name: string): Promise<{
  enrollmentId: string;
  serverId: string;
  enrollmentToken: string;
  expiresAt: string;
}> {
  const server = await rest<{ id: string }>("POST", "servers", {
    body: { owner_id: ownerId, name, enrollment_state: "pending" },
    prefer: "return=representation",
  });
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ENROLL_TOKEN_TTL_S * 1000).toISOString();
  const row = await rest<EnrollmentRow>("POST", "enrollments", {
    body: {
      server_id: server[0]!.id,
      owner_id: ownerId,
      state: "created",
      enrollment_token_hash: sha256hex(token),
      token_expires_at: expiresAt,
    },
    prefer: "return=representation",
  });
  return { enrollmentId: row[0]!.id, serverId: server[0]!.id, enrollmentToken: token, expiresAt };
}

/**
 * Connector-side: exchange the enrollment token for a display session.
 * Marks pending_connector and mints the one-time numeric code. Returns the
 * RAW code exactly once — it exists in plaintext only in this response and
 * on the terminal (plan: never logged, never stored raw).
 */
export async function openEnrollmentSession(token: string): Promise<{
  enrollmentId: string;
  serverId: string;
  displayCode: string;
  displayCodeExpiresAt: string;
} | null> {
  const now = new Date().toISOString();
  const rows = await rest<EnrollmentRow>("PATCH", "enrollments", {
    body: { state: "pending_connector", updated_at: now },
    prefer: "return=representation",
    query: {
      enrollment_token_hash: `eq.${sha256hex(token)}`,
      state: "eq.created",
      token_expires_at: `gt.${now}`,
    },
  });
  const row = rows[0];
  if (!row) return null;
  const code = newDisplayCode();
  const codeExp = new Date(Date.now() + DISPLAY_CODE_TTL_S * 1000).toISOString();
  await rest("PATCH", "enrollments", {
    body: { display_code_hash: sha256hex(code), display_code_expires_at: codeExp, updated_at: now },
    query: { id: `eq.${row.id}` },
  });
  return { enrollmentId: row.id, serverId: row.server_id, displayCode: code, displayCodeExpiresAt: codeExp };
}

/**
 * App-side claim: verifies owner binding, code hash, expiry and attempt
 * budget ATOMICALLY, then issues the connector credential for pickup.
 * Wrong code burns an attempt; a second successful claim is impossible.
 */
export type ClaimFailure =
  | "not_found" | "not_owner" | "expired" | "too_many_attempts" | "bad_code" | "not_pending";

export async function claimEnrollment(
  enrollmentId: string,
  claimingOwnerId: string,
  code: string,
): Promise<{ ok: true; serverId: string } | { ok: false; reason: ClaimFailure }> {
  const now = new Date().toISOString();
  const rows = await rest<EnrollmentRow>("GET", "enrollments", { query: { id: `eq.${enrollmentId}` } });
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.owner_id !== claimingOwnerId) return { ok: false, reason: "not_owner" };
  if (row.state !== "pending_connector") return { ok: false, reason: "not_pending" };
  if (row.claim_attempts >= MAX_CLAIM_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };
  if (!row.display_code_expires_at || row.display_code_expires_at < now) {
    return { ok: false, reason: "expired" };
  }
  // Burn an attempt on every try (also under concurrency: atomic increment).
  await rest("PATCH", "enrollments", {
    body: { claim_attempts: row.claim_attempts + 1, updated_at: now },
    query: { id: `eq.${enrollmentId}`, claim_attempts: `eq.${row.claim_attempts}` },
  });
  if (row.display_code_hash !== sha256hex(code)) return { ok: false, reason: "bad_code" };

  // Issue the connector credential; plaintext goes to credential_pickup for
  // the connector's session to read exactly once.
  const credential = randomBytes(32).toString("base64url");
  const cred = await rest<{ id: string }>("POST", "connector_credentials", {
    body: { server_id: row.server_id, credential_hash: sha256hex(credential) },
    prefer: "return=representation",
  });
  const claim = await rest<EnrollmentRow>("PATCH", "enrollments", {
    body: {
      state: "claim_requested",
      credential_pickup: credential,
      updated_at: now,
    },
    prefer: "return=representation",
    query: { id: `eq.${enrollmentId}`, state: "eq.pending_connector" },
  });
  if (!claim[0]) return { ok: false, reason: "not_pending" }; // lost the race
  return { ok: true, serverId: row.server_id };
}

/**
 * Connector-side pickup: once the app has claimed, the enrollment session
 * reads the credential ONCE (pickup cleared atomically) and the enrollment
 * becomes paired. Server flips to active.
 */
export async function pickupCredential(
  token: string,
): Promise<{ credential: string; serverId: string; enrollmentId: string } | null> {
  const now = new Date().toISOString();
  // claim_requested -> paired, handing over the credential one time.
  const rows = await rest<EnrollmentRow>("PATCH", "enrollments", {
    body: { state: "paired", credential_picked_up_at: now, updated_at: now },
    prefer: "return=representation",
    query: {
      enrollment_token_hash: `eq.${sha256hex(token)}`,
      state: "eq.claim_requested",
    },
  });
  const row = rows[0];
  if (!row || !row.credential_pickup) return null;
  await rest("PATCH", "enrollments", {
    body: { credential_pickup: null, updated_at: now },
    query: { id: `eq.${row.id}` },
  });
  await rest("PATCH", "servers", {
    body: { enrollment_state: "active", updated_at: now },
    query: { id: `eq.${row.server_id}` },
  });
  return { credential: row.credential_pickup, serverId: row.server_id, enrollmentId: row.id };
}

/** Owner revocation: server revoked + credential dead + enrollment revoked. */
export async function revokeServer(serverId: string, ownerId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const servers = await rest<{ id: string }>("PATCH", "servers", {
    body: { enrollment_state: "revoked", connector_id: null, updated_at: now },
    prefer: "return=representation",
    query: { id: `eq.${serverId}`, owner_id: `eq.${ownerId}`, enrollment_state: "eq.active" },
  });
  if (!servers[0]) return false;
  await rest("PATCH", "connector_credentials", {
    body: { revoked_at: now },
    query: { server_id: `eq.${serverId}`, revoked_at: "is.null" },
  });
  await rest("PATCH", "enrollments", {
    body: { state: "revoked", updated_at: now },
    query: { server_id: `eq.${serverId}`, state: "in.(created,pending_connector,claim_requested,paired,online)" },
  });
  return true;
}
