/**
 * Immediate revocation for access tokens.
 *
 * The problem this solves (audit finding F-07): revoking a device killed its
 * sessions — so the refresh token and the WebSocket both stopped working — but
 * the 15-minute access token stayed valid and could still reach /system.
 * A stolen access token therefore remained usable for up to 15 minutes after
 * the owner revoked the device.
 *
 * The fix is a short-lived in-memory denylist keyed on the device id. The
 * access token is only 15 minutes long, so the denylist only needs to live
 * for that long: after the token's own expiry, revoking it is a no-op anyway.
 * A DB round-trip per request would be the thing that hurts here, and a
 * persistent table would add a write on every revocation for no benefit.
 *
 * Limitation (documented, not hidden): the denylist is per-process. If the
 * server restarts, revoked devices' access tokens are valid again until they
 * expire on their own. The session rows in Postgres are still revoked, so the
 * refresh token and the WebSocket stay dead across a restart.
 */

const ACCESS_TTL_MS = 15 * 60 * 1000;

/** key -> epoch ms at which the entry may be discarded */
const revoked = new Map<string, number>();

/** Mark a key (a device id or a session id) as revoked for the access-token lifetime. */
export function revokeKey(key: string, ttlMs: number = ACCESS_TTL_MS): void {
  if (!key) return;
  revoked.set(key, Date.now() + ttlMs);
}

/** True if the key has been revoked and the revocation has not yet lapsed. */
export function isRevoked(key: string | null | undefined): boolean {
  if (!key) return false;
  const expiry = revoked.get(key);
  if (expiry === undefined) return false;
  if (expiry <= Date.now()) {
    revoked.delete(key);
    return false;
  }
  return true;
}

/** Drop expired entries. Called opportunistically, like the login-guard sweep. */
export function sweepRevocations(): void {
  if (revoked.size < 1000) return;
  const now = Date.now();
  for (const [key, expiry] of revoked) {
    if (expiry <= now) revoked.delete(key);
  }
}

/** Test hook: forget every revocation. */
export function clearRevocations(): void {
  revoked.clear();
}
