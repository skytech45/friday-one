/**
 * Reject token shapes that fast-jwt historically accepted but that this app
 * must never trust (audit findings F-06, F-08, F-11):
 *
 *  - a payload that is not a plain object (a JSON array or null decodes to a
 *    non-object payload and was accepted);
 *  - a missing or non-numeric `exp` (a correctly-signed token with no expiry
 *    would otherwise live forever);
 *  - a missing or empty `sub`.
 *
 * Call this immediately after signature verification succeeds. Any throw is
 * turned into a 401 by the HTTP decorators and a 4401 by the WebSocket path.
 * The signature is still verified first — this only tightens the accepted
 * claim set, it does not replace verification.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reject a `crit` header extension.
 *
 * RFC 7515 says a recipient MUST reject a token whose `crit` header lists an
 * extension it does not understand. fast-jwt 5.x has no `crit` handling at
 * all, so a token carrying `crit: ["exp"]` was accepted (F-11). Since this
 * app understands no extensions, ANY `crit` header is refused.
 */
export function assertNoCritHeader(header: unknown): void {
  if (typeof header !== "object" || header === null) return;
  const crit = (header as Record<string, unknown>).crit;
  if (crit === undefined || crit === null) return;
  throw new Error("token_crit_not_supported");
}

export function assertTokenClaims(payload: unknown): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("token_payload_must_be_object");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) {
    throw new Error("token_missing_exp");
  }
  if (typeof p.sub !== "string" || p.sub.length === 0) {
    throw new Error("token_missing_sub");
  }
  // `users.id` and `devices.id` are uuid columns. A non-UUID value made
  // Postgres raise, and the raw database error was returned to the caller in
  // the 500 body (F-04) — so the claim is rejected here, at the boundary.
  if (!UUID_RE.test(p.sub)) {
    throw new Error("token_sub_must_be_uuid");
  }
  // `did` is optional, but when present it is used as a uuid column value.
  if (p.did !== undefined && p.did !== null) {
    if (typeof p.did !== "string" || !UUID_RE.test(p.did)) {
      throw new Error("token_did_must_be_uuid");
    }
  }
}
