import type { FastifyReply } from "fastify";
import { config } from "./config.js";
import { query } from "./db.js";

/**
 * Brute-force protection for the login endpoint.
 *
 * Two independent limits, because they stop different attacks:
 *
 *  - **Per-account lockout**, persisted in Postgres. Survives a server restart,
 *    which matters: an in-memory counter is reset by bouncing the process, and
 *    an attacker who can trigger a restart would get unlimited attempts.
 *    It also stops a distributed attack (many IPs, one account), which per-IP
 *    limiting alone cannot.
 *
 *  - **Per-IP throttle**, in memory. Stopped by spraying one guess across many
 *    accounts from a single host. Kept in memory deliberately: this is a
 *    high-volume, low-value check where a DB round-trip per attempt would be
 *    the thing that hurts.
 *
 * Lockout is applied *before* password verification and the response is always
 * the same generic failure, so the endpoint does not reveal whether an account
 * exists, is locked, or merely had a bad password.
 */

const MAX_FAILED_BEFORE_LOCK = config.loginMaxFailures;

/** Lockout grows with repeated lockouts: 1m, 5m, 15m, 60m, then 24h. */
const LOCK_STEPS_MINUTES = [1, 5, 15, 60, 60 * 24];

/** Per-IP sliding window. */
const IP_MAX_ATTEMPTS = config.loginIpMax;
const IP_WINDOW_MS = 15 * 60 * 1000;

type IpRecord = { count: number; firstAt: number };
const ipAttempts = new Map<string, IpRecord>();

/** Opportunistic cleanup so the map cannot grow without bound. */
function sweepIp(now: number): void {
  if (ipAttempts.size < 5000) return;
  for (const [key, rec] of ipAttempts) {
    if (now - rec.firstAt > IP_WINDOW_MS) ipAttempts.delete(key);
  }
}

export type GuardVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/** Check the per-IP window. Call before doing any DB work. */
export function checkIpThrottle(ip: string): GuardVerdict {
  const now = Date.now();
  sweepIp(now);

  const rec = ipAttempts.get(ip);
  if (!rec || now - rec.firstAt > IP_WINDOW_MS) {
    ipAttempts.set(ip, { count: 1, firstAt: now });
    return { allowed: true };
  }

  rec.count += 1;
  if (rec.count > IP_MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((rec.firstAt + IP_WINDOW_MS - now) / 1000),
    };
  }
  return { allowed: true };
}

/** Clear the per-IP window after a successful login. */
export function clearIpThrottle(ip: string): void {
  ipAttempts.delete(ip);
}

export type AccountLockState = {
  locked: boolean;
  retryAfterSeconds: number;
};

/**
 * Read the persisted lock state for an account without mutating it.
 * Returns `locked: false` for an unknown user so the caller cannot use this as
 * an account-existence oracle.
 */
export async function accountLockState(userId: string | null): Promise<AccountLockState> {
  if (!userId) return { locked: false, retryAfterSeconds: 0 };

  const res = await query<{ locked_until: Date | null }>(
    "SELECT locked_until FROM users WHERE id = $1",
    [userId],
  );
  const until = res.rows[0]?.locked_until;
  if (!until) return { locked: false, retryAfterSeconds: 0 };

  const remaining = new Date(until).getTime() - Date.now();
  if (remaining <= 0) return { locked: false, retryAfterSeconds: 0 };
  return { locked: true, retryAfterSeconds: Math.ceil(remaining / 1000) };
}

/**
 * Register a failed attempt and lock the account if the threshold is crossed.
 * @returns the lock duration applied, in seconds, or 0 if not yet locked.
 */
export async function recordFailure(userId: string | null): Promise<number> {
  if (!userId) return 0;

  const res = await query<{ failed_attempts: number; lock_count: number }>(
    `UPDATE users
        SET failed_attempts = failed_attempts + 1
      WHERE id = $1
      RETURNING failed_attempts, lock_count`,
    [userId],
  );
  const row = res.rows[0];
  if (!row || row.failed_attempts < MAX_FAILED_BEFORE_LOCK) return 0;

  const step = Math.min(row.lock_count, LOCK_STEPS_MINUTES.length - 1);
  const minutes = LOCK_STEPS_MINUTES[step]!;

  await query(
    `UPDATE users
        SET locked_until    = now() + ($2 || ' minutes')::interval,
            failed_attempts = 0,
            lock_count      = lock_count + 1
      WHERE id = $1`,
    [userId, String(minutes)],
  );

  return minutes * 60;
}

/** Clear the failure counters after a successful login. */
export async function recordSuccess(userId: string): Promise<void> {
  await query(
    `UPDATE users
        SET failed_attempts = 0, lock_count = 0, locked_until = NULL,
            last_login_at = now()
      WHERE id = $1`,
    [userId],
  );
}

/** Standard response for a throttled attempt. */
export function sendThrottled(reply: FastifyReply, retryAfterSeconds: number) {
  reply.header("Retry-After", String(retryAfterSeconds));
  return reply.code(429).send({
    error: "too_many_attempts",
    retryAfterSeconds,
  });
}
