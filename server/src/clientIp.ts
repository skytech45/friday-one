import type { FastifyRequest } from "fastify";

/**
 * Resolve the real client IP for rate limiting and audit logging.
 *
 * The problem this solves (audit finding F-05): Fastify's `req.ip` is derived
 * from the client-supplied `X-Forwarded-For` header when `trustProxy` is
 * enabled, and this app had `trustProxy: true`. That let any caller rotate the
 * header to get a fresh rate-limit bucket per request, which defeated the
 * per-IP login throttle.
 *
 * The fix has two parts:
 *
 *  1. `trustProxy` is narrowed to `127.0.0.1`. The API binds to loopback and
 *     the Cloudflare tunnel is the only thing that connects to it, so the
 *     immediate peer is always the local tunnel and a client-supplied
 *     `X-Forwarded-For` is never trusted.
 *  2. The client IP comes from `CF-Connecting-IP`, which the Cloudflare edge
 *     sets and overwrites on every proxied request. A remote caller cannot
 *     forge it: the edge replaces whatever it received.
 *
 * `X-Forwarded-For` is deliberately NOT consulted. It is client-supplied, so
 * using it would let a caller rotate it and mint a fresh bucket per request —
 * the exact hole this function exists to close.
 *
 * KNOWN LIMITATION (accepted, documented): a *local* process can forge
 * `CF-Connecting-IP`, because the API is reachable on loopback from the host.
 * That is not an escalation — a local process runs as `ubuntu` and can read
 * `server/.env` (including JWT_SECRET) directly, so forging a header to dodge
 * a rate limiter is strictly less useful than reading the key.
 *
 * The actual guarantee against brute force is NOT this function: it is the
 * per-account lockout in loginGuard.ts, which is keyed on the user id in
 * Postgres and cannot be influenced by any request header. This IP resolution
 * is a speed bump on top of it. A restart also resets this bucket (it is
 * in-memory); the Postgres lockout survives restarts.
 */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) {
    return cf.trim();
  }
  // No tunnel in front: the peer address is the honest answer. The API binds
  // to loopback, so such a request genuinely came from the local host.
  return req.socket?.remoteAddress ?? "unknown";
}
