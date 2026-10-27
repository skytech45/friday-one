/**
 * Caller identity: Firebase ID tokens for app users, credential hashes for
 * connectors. Identity always comes from these verified sources, never from
 * the request body.
 */
import { COL, auth, db, millis, sha256hex } from "./db.js";
import type { ApiRequest } from "./http.js";

/** Sign-in providers accepted (decision D2: Google only). */
const ALLOWED_PROVIDERS = new Set(
  (process.env.ALLOWED_SIGN_IN_PROVIDERS ?? "google.com").split(",").map((s) => s.trim()).filter(Boolean),
);

export interface AuthUser {
  uid: string;
  email: string | null;
}

/**
 * Verifies `Authorization: Bearer <Firebase ID token>`: signature, expiry,
 * issuer and audience (this project), plus the sign-in provider. With
 * `checkRevoked`, a token issued before a revoke/disable is rejected too;
 * it costs an Auth lookup, so it is used on state-changing routes.
 */
export async function verifyUser(req: ApiRequest, opts: { checkRevoked?: boolean } = {}): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  if (!match?.[1]) return null;
  try {
    const token = await auth.verifyIdToken(match[1], opts.checkRevoked ?? false);
    if (!ALLOWED_PROVIDERS.has(token.firebase?.sign_in_provider ?? "")) return null;
    return { uid: token.uid, email: typeof token.email === "string" ? token.email : null };
  } catch {
    return null;
  }
}

export interface LiveCredential {
  hash: string;
  credentialId: string;
  serverId: string;
  ownerId: string;
}

/**
 * Connector credential from `x-connector-credential`: must exist, not be
 * revoked and not be expired. (The Vercel API checked only revocation, so
 * a rotated-out credential kept working past its grace window: F-M3.)
 */
export async function verifyConnector(req: ApiRequest): Promise<LiveCredential | null> {
  const credential = req.headers["x-connector-credential"];
  if (!credential) return null;
  const hash = sha256hex(credential);
  const snap = await db.collection(COL.credentials).doc(hash).get();
  const d = snap.data();
  if (!d || d.revokedAt) return null;
  const exp = millis(d.expiresAt);
  if (exp !== null && exp <= Date.now()) return null;
  return { hash, credentialId: String(d.credentialId), serverId: String(d.serverId), ownerId: String(d.ownerId) };
}
