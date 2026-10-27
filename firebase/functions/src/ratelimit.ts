/**
 * Fixed-window rate limits shared across all function instances: one
 * Firestore document per (limit, client IP) bucket, updated in a
 * transaction, so a restart or a second instance does not reset it.
 *
 * Thresholds are unchanged from the Vercel API (env-overridable). If the
 * limiter cannot be reached, requests fail CLOSED with 503.
 *
 * Client IP: Google's front end appends the address it saw to
 * X-Forwarded-For, so the LAST entry is the one a client cannot forge
 * (earlier entries are client-supplied). Verify in staging: acceptance A-3b.
 * The bucket key is hashed so no raw IP is stored.
 */
import { COL, Timestamp, db, sha256hex } from "./db.js";
import { fail, type ApiRequest, type ApiResponse } from "./http.js";

const env = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const LIMITS = {
  enrollCreate: { window: 3600, max: env("RL_ENROLL_CREATE", 10) },
  sessionOpen: { window: 3600, max: env("RL_SESSION_OPEN", 10) },
  sessionPoll: { window: 600, max: env("RL_SESSION_POLL", 300) },
  claim: { window: 3600, max: env("RL_CLAIM", 30) },
  claimFail: { window: 3600, max: env("RL_CLAIM_FAIL", 6) }, // failures weigh 5x
  revoke: { window: 3600, max: env("RL_REVOKE", 30) },
} as const;

export type LimitName = keyof typeof LIMITS;

export function clientIp(req: ApiRequest): string {
  const xff = req.headers["x-forwarded-for"];
  const parts = (xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? "unknown";
}

export type LimitResult = { ok: true } | { ok: false; retryAfter: number; unavailable?: boolean };

export async function consumeLimit(name: LimitName, ip: string, weight = 1): Promise<LimitResult> {
  const { window, max } = LIMITS[name];
  const effectiveMax = Math.max(1, Math.floor(max / Math.max(1, weight)));
  const ref = db.collection(COL.rateLimits).doc(sha256hex(`${name}:${ip}`));
  const windowMs = window * 1000;
  try {
    return await db.runTransaction(async (tx): Promise<LimitResult> => {
      const now = Date.now();
      const d = (await tx.get(ref)).data();
      const start = d?.windowStart instanceof Timestamp ? d.windowStart.toMillis() : 0;
      if (!d || now - start >= windowMs) {
        tx.set(ref, {
          limit: name,
          windowStart: Timestamp.fromMillis(now),
          count: 1,
          expireAt: Timestamp.fromMillis(now + windowMs + 3_600_000),
        });
        return { ok: true };
      }
      if (Number(d.count) >= effectiveMax) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
      }
      tx.update(ref, { count: Number(d.count) + 1 });
      return { ok: true };
    });
  } catch {
    return { ok: false, retryAfter: 60, unavailable: true };
  }
}

/** 429 with Retry-After, or 503 when the limiter itself is down. */
export function limitResponse(r: Extract<LimitResult, { ok: false }>): ApiResponse {
  return r.unavailable
    ? fail(503, "temporarily_unavailable", { "retry-after": String(r.retryAfter) })
    : fail(429, "rate_limited", { "retry-after": String(r.retryAfter) });
}
