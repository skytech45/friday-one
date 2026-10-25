/**
 * Per-IP rate limiting for pairing endpoints (P0 fix, plan v2 security).
 *
 * Storage: Supabase Postgres fixed-window counter via the atomic
 * consume_rate_limit RPC — shared across all serverless instances and
 * restart-safe (see infra/supabase/migrations/0004_rate_limits.sql).
 *
 * IP derivation: ONLY deployment-provided Vercel headers are trusted
 * (x-vercel-forwarded-for / x-real-ip). Client-supplied x-forwarded-for is
 * ignored — spoofing it cannot bypass or shift the bucket.
 *
 * Fail safe: if the limiter is unreachable, pairing requests fail CLOSED
 * (503) rather than proceeding unthrottled.
 *
 * Thresholds (defaults; env-overridable) — chosen against the existing
 * controls: display codes are 16-20 CSPRNG digits with a 10-minute expiry and
 * a 5-attempt budget per enrollment, so the limiter's job is to stop bulk
 * enrollment spam and cross-enrollment code guessing, not to be the only
 * defense:
 *   enroll create   : 10 / hour   per IP   (+ user-authenticated)
 *   session open    : 10 / hour   per IP   (needs a valid 30-min token)
 *   session poll    : 300 / 10min per IP   (connector polls every 3 s ≈ 200/enrollment)
 *   claim           : 30 / hour   per IP; failed claims consume 5 (strict)
 *   revoke          : 30 / hour   per IP   (+ user-authenticated)
 */
import { env } from "./env.js";

const REST = `${env.supabaseUrl}/rest/v1/rpc/consume_rate_limit`;

export const LIMITS = {
  enrollCreate: { window: 3600, max: Number(process.env.RL_ENROLL_CREATE ?? 10) },
  sessionOpen: { window: 3600, max: Number(process.env.RL_SESSION_OPEN ?? 10) },
  sessionPoll: { window: 600, max: Number(process.env.RL_SESSION_POLL ?? 300) },
  claim: { window: 3600, max: Number(process.env.RL_CLAIM ?? 30) },
  claimFail: { window: 3600, max: Number(process.env.RL_CLAIM_FAIL ?? 6) }, // failures weigh 5x
  revoke: { window: 3600, max: Number(process.env.RL_REVOKE ?? 30) },
} as const;

export type LimitName = keyof typeof LIMITS;

/** Client IP from trusted Vercel edge headers only. */
export function clientIp(req: { headers: Record<string, string | string[] | undefined> }): string {
  const vff = req.headers["x-vercel-forwarded-for"];
  if (typeof vff === "string" && vff.trim()) {
    return vff.split(",")[0]!.trim();
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  return "unknown"; // non-Vercel invocation (e.g. local test): shared bucket
}

export interface LimitResult {
  ok: boolean;
  retryAfter?: number;
}

export async function consumeLimit(
  name: LimitName,
  ip: string,
  weight = 1,
): Promise<LimitResult> {
  const { window, max } = LIMITS[name];
  const effectiveMax = Math.max(1, Math.floor(max / Math.max(1, weight)));
  const key = `${name}:${ip}`;
  try {
    const res = await fetch(REST, {
      method: "POST",
      headers: {
        apikey: env.supabaseSecretKey,
        authorization: `Bearer ${env.supabaseSecretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_key: key, p_window_seconds: window, p_max: effectiveMax }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, retryAfter: 60 }; // fail closed
    const rows = (await res.json()) as Array<{ allowed: boolean; retry_after_s: number }>;
    const row = rows[0];
    if (!row) return { ok: false, retryAfter: 60 };
    return row.allowed
      ? { ok: true }
      : { ok: false, retryAfter: Math.max(1, row.retry_after_s) };
  } catch {
    return { ok: false, retryAfter: 60 }; // fail closed on limiter failure
  }
}

/** Uniform 429 (or 503 when the limiter itself is down) with Retry-After. */
export function limitResponse(
  res: import("@vercel/node").VercelResponse,
  result: LimitResult,
): void {
  const status = result.retryAfter === undefined ? 503 : 429;
  res
    .status(status)
    .setHeader("Retry-After", String(result.retryAfter ?? 60))
    .setHeader("content-type", "application/json")
    .end(JSON.stringify({ error: status === 429 ? "rate_limited" : "temporarily_unavailable" }));
}
