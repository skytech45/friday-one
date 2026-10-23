# FRIDAY One — Remediation Roadmap

**Date:** 2026-10-23
**Status:** PROPOSED — awaiting owner approval. No source file has been modified.
**Rule:** each fix is small, reviewable, on a dedicated branch, with a regression test and a rollback path. Controls are never weakened to make a test pass.

---

## Priority definitions

| Priority | Meaning |
|---|---|
| **P0** | Contain a confirmed critical exposure. Ship before the service is exposed to the internet again. |
| **P1** | Security-boundary fixes. A control that does not exist or does not work. |
| **P2** | High-priority hardening. Reduces real risk and removes footguns. |
| **P3** | Lower-priority improvements: hygiene, provenance, operability. |

---

## P0 — Containment (do first; the service is currently not running, so this is a free window)

### R-01 · Narrow `FS_ROOTS` and deny secret paths inside roots
**Addresses:** F-02 · **Effort:** S · **Risk of change:** low (config) / low (code)

**Change**
- `server/.env`: `FS_ROOTS=/home/ubuntu` → `FS_ROOTS=/home/ubuntu/friday-one/storage`
- `server/src/routes/files.ts` — add a denylist to `safePath()`:
```ts
const DENY_SEGMENTS = new Set([
  ".ssh", ".aws", ".gnupg", ".hermes", ".kube", ".docker",
  ".config", ".local/share/keyrings",
]);
const DENY_BASENAMES = /^(id_rsa|id_ed25519|\.env|\.env\..*|.*\.pem|.*\.key|credentials)$/;

function isDenied(relPath: string): boolean {
  const segs = relPath.split(sep);
  if (segs.some((s) => DENY_SEGMENTS.has(s))) return true;
  return DENY_BASENAMES.test(basename(relPath));
}
```
and reject inside `safePath()` when the resolved path is under a root but hits the denylist.

**Files:** `server/.env`, `server/src/routes/files.ts`
**Regression test:** extend `server/test/pathjail.test.ts` — assert `<root>/.ssh/authorized_keys` and `<root>/.env` are rejected while `<root>/notes.txt` is allowed; add an integration case that `GET /fs/download?path=<root>/.env` returns 403.
**Rollback:** revert the two-file commit; the old value is in the git history once F-19 is fixed.
**Dependency:** R-09 (version control) is strongly preferred first, but this can ship without it.

---

### R-02 · Make the registration allowlist mandatory (fail closed)
**Addresses:** F-04 · **Effort:** S · **Risk of change:** low

**Change** — `server/src/routes/auth.ts`:
```ts
const allowed = allowedEmails();
if (allowed.length === 0) {
  // Fail closed: a single-operator control plane must never accept an
  // anonymous account because a variable was left unset.
  req.log.error("ALLOWED_EMAILS is not configured; refusing registration");
  return reply.code(503).send({ error: "registration_not_configured" });
}
if (!allowed.includes(email)) {
  await audit(null, null, "auth.register_rejected", clientIp(req), { email });
  return reply.code(403).send({ error: "registration_closed" });
}
```
Plus a startup check in `server/src/index.ts` that logs an error at boot when the allowlist is empty.

**Files:** `server/src/routes/auth.ts`, `server/src/index.ts`
**Regression test:** boot with `ALLOWED_EMAILS=""` → `/auth/register` returns 503; boot with a configured allowlist → a non-allowlisted email returns 403, an allowlisted one returns 201.
**Rollback:** single-file revert.
**Note:** the owner should also consider the stronger option — remove `/auth/register` from the running service entirely and provision only through `seed-owner.ts`. That would also let the Android client drop its "Create account" mode. **This is a product decision, flagged for the owner.**

---

### R-03 · Redact the access token from the server log
**Addresses:** F-03 · **Effort:** S · **Risk of change:** low

**Change** — `server/src/index.ts`, replace the plain logger with a redacting serializer:
```ts
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    serializers: {
      req(req) {
        const url = req.url.replace(/([?&]token=)[^&]*/i, "$1<redacted>");
        return { method: req.method, url, hostname: req.hostname, remoteAddress: req.remoteAddress };
      },
    },
  },
  …
});
```
Apply the same redaction to any `req.log` call that includes a URL.

**Files:** `server/src/index.ts`
**Regression test:** connect a WebSocket with a known token, capture the log output, assert the token string does **not** appear. `audit/audit-probes.mjs` (probe C) already does exactly this — invert its assertion.
**Rollback:** single-file revert.
**Operational note:** after deploying, rotate `JWT_SECRET` if the journal may have been collected. The audit log showed the token being written on every connection, and the journal is readable by the `ubuntu` user.

---

### R-04 · Wire the Android client's security layer
**Addresses:** F-01 · **Effort:** M · **Risk of change:** medium (UI behaviour changes)

**Change**
- `MainActivity.kt` — before rendering the dashboard when a session exists, call `AppLock.authenticate(this)`; on `Denied`/`Error`, show the lock screen and do not render the dashboard.
- `MainActivity.kt` — call `DeviceIntegrityGate().evaluate()` at startup and send the verdict with registration/login (`integrity_verdict`, `key_security_level` — the database columns already exist).
- `NetworkModule.kt` — populate `TUNNEL_PINS` with the real SPKI pins of the live tunnel certificate. The rotation procedure is already documented in the class comment (add the new pin before removing the old).
- Replace every `ApiClient.create(...)` call site with `NetworkModule.createApi(context, baseUrl, sessionStore)`.
- `Api.kt` — register `TokenRefreshAuthenticator` on the shared OkHttp client (move it out of `NetworkModule` so both clients share it).

**Files:** `MainActivity.kt`, `data/NetworkModule.kt`, `data/Api.kt`, `security/CertificatePinning.kt`
**Regression test:** instrumented tests — (a) a biometric prompt is required before the dashboard renders; (b) a non-loopback host with an untrusted certificate fails the handshake; (c) `MainActivity.kt` contains no `ApiClient.create` call.
**Rollback:** the change is behind a `BuildConfig` flag (`SECURITY_ENFORCED`); flipping it off restores current behaviour without a rebuild of the server.
**Dependency:** the pins must come from the **final** tunnel hostname. If the named tunnel at `friday.knistudio.in` is used (R-12), pin that instead — otherwise the pins change on every quick-tunnel restart, which makes pinning impractical. **R-12 should therefore be done before R-04.**
**Owner decision:** if the client hardening is not going to be done, the *docs* must be corrected to remove the pinning/biometric/binding claims. A doc that lies about the shipped binary is its own finding.

---

## P1 — Security-boundary fixes

### R-05 · Pin the JWT algorithm, require `exp`, reject array payloads and `crit`
**Addresses:** F-06, F-08, F-11 · **Effort:** S · **Risk of change:** low

**Change** — `server/src/index.ts`:
```ts
await app.register(jwt, {
  secret: process.env.JWT_SECRET ?? (() => { throw new Error("JWT_SECRET is not set"); })(),
  algorithms: ["HS256"],
  verify: {
    allowedIss: undefined,
    allowedAud: undefined,
    checkIss: false,
  },
});
```
Add an explicit claim validator:
```ts
app.decorateRequest("assertSessionClaims", null);
app.addHook("onRequest", async (req) => {
  // runs after jwtVerify for protected routes
});
```
Concretely, the cleanest place is a `preHandler` used by both decorators:
```ts
async function assertClaims(payload: unknown): Promise<void> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("token_payload_must_be_an_object");
  }
  if (typeof (payload as { exp?: unknown }).exp !== "number") {
    throw new Error("token_missing_exp");
  }
  if (typeof (payload as { sub?: unknown }).sub !== "string" || (payload as { sub: string }).sub.length === 0) {
    throw new Error("token_missing_sub");
  }
}
```

**Files:** `server/src/index.ts`
**Regression test:** reuse `audit/audit-algtest.mjs` — after the fix, **all 15 variants must be rejected**. Add cases for `exp` missing, payload as an array, and `crit` present.
**Rollback:** single-file revert.
**Dependency:** coordinate with R-06 — if `@fastify/jwt` 10.x is taken, its `verify` option shape differs.

---

### R-06 · Upgrade the JWT chain and pin `fast-jwt`
**Addresses:** F-11 · **Effort:** S–M · **Risk of change:** medium (breaking major)

**Change** — `server/package.json`:
```json
"dependencies": { "@fastify/jwt": "^10.2.5" }
```
or, if the 10.x API change is not acceptable right now:
```json
"overrides": { "fast-jwt": "^6.3.4" }
```
Then re-run the acceptance matrix and the server test suite.

**Files:** `server/package.json`, `server/package-lock.json`
**Regression test:** `npm audit --omit=dev` reports 0 critical; the acceptance matrix passes; `npx tsx --test test/*.test.ts` passes.
**Rollback:** restore the previous `package.json` + `package-lock.json` and `npm ci`.
**Note:** `npm audit fix --force` is **not** a plan — it is a starting point. The 10.x upgrade changes the `verify`/`sign` option shapes, so R-05 and R-06 must be sequenced together, and the acceptance matrix is the safety net.

---

### R-07 · Stop trusting client-supplied `X-Forwarded-For`
**Addresses:** F-05 · **Effort:** S · **Risk of change:** medium (IP attribution changes)

**Change** — `server/src/index.ts`:
```ts
const app = Fastify({
  trustProxy: "127.0.0.1",   // the tunnel is the only trusted peer
  …
});
```
and resolve the client IP from Cloudflare's verified header:
```ts
function clientIp(req: FastifyRequest): string {
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.length > 0) return cfIp;
  return req.ip ?? "unknown";
}
```
`CF-Connecting-IP` is set by Cloudflare and overwritten by it, so the client cannot forge it — **provided the connection genuinely came through the tunnel**. Since the API binds to `127.0.0.1`, that holds. Verify the header is present by checking a real request through the tunnel before relying on it; fall back to `req.ip` if absent.

**Files:** `server/src/index.ts`, `server/src/loginGuard.ts` (the `clientIp` helper), `server/src/routes/auth.ts` (its own copy)
**Regression test:** send a forged `X-Forwarded-For` and assert the throttle bucket does not reset; assert a forged `CF-Connecting-IP` is ignored.
**Rollback:** single-file revert (but the bypass returns with it).
**Operational note:** the `audit_log.ip` column will start showing real client addresses. The current values are attacker-controlled and are of no forensic value — consider purging historical rows.

---

### R-08 · Make revocation take effect immediately
**Addresses:** F-07 · **Effort:** S–M · **Risk of change:** medium

**Change** — add a revocation cache and consult it in `authenticate`:
```ts
// server/src/revocation.ts
const revoked = new Map<string, number>();   // key -> expiry epoch ms
export function revokeKey(key: string, ttlMs: number): void { revoked.set(key, Date.now() + ttlMs); }
export function isRevoked(key: string): boolean {
  const exp = revoked.get(key);
  if (!exp) return false;
  if (exp < Date.now()) { revoked.delete(key); return false; }
  return true;
}
```
On `DELETE /auth/devices/:id` and on `POST /auth/logout`, call `revokeKey(deviceId, ACCESS_TTL)` / `revokeKey(sessionId, ACCESS_TTL)`. In `authenticate`, after `jwtVerify()`, check `isRevoked(req.user.did)`.

**Files:** `server/src/index.ts`, `server/src/revocation.ts` (new), `server/src/routes/auth.ts`
**Regression test:** revoke a device, then assert `/system` with the old token returns 401; assert the WebSocket is refused (already true).
**Rollback:** the cache is additive; reverting removes the check.
**Alternative (simpler):** shorten the access token to 5 minutes. `SessionStore.validToken()` already refreshes proactively, so the client needs no change. This shrinks the window from 15 to 5 minutes but does not eliminate it. **The cache is the real fix; the shorter TTL is a useful belt-and-braces change.**

---

### R-09 · Move the DB credential out of the process environment
**Addresses:** F-10, F-02 · **Effort:** S · **Risk of change:** medium

**Change**
- `server/src/env.ts` — after `process.loadEnvFile(path)`, read the values into a typed config object and **delete the secrets from `process.env`**:
```ts
export const config = { databaseUrl: process.env.DATABASE_URL!, jwtSecret: process.env.JWT_SECRET!, … };
delete process.env.DATABASE_URL;
delete process.env.JWT_SECRET;
delete process.env.FINGERPRINT_PEPPER;
```
- `server/src/db.ts` — take the connection string from `config`, not `process.env`.
- Provide the DB password to `pg` via a `~/.pgpass` file (0600) rather than in the URL, so it is not in the URL, the process environment, or an error message.
- `server/src/routes/terminal.ts` — build an explicit allowlist environment for the child (see R-11).

**Files:** `server/src/env.ts`, `server/src/db.ts`, `server/src/routes/terminal.ts`
**Regression test:** assert that from inside a terminal session, `env` contains no variable matching `SECRET|TOKEN|PASSWORD|PEPPER|DATABASE_URL`; assert `process.env.JWT_SECRET` is undefined inside the server process after startup.
**Rollback:** revert the three files.
**Note:** this is the single highest-value change for AC-6 (prompt injection). An agent that reads the environment can no longer find the signing key.

---

## P2 — High-priority hardening

### R-10 · Give the terminal and the file API their own unprivileged accounts
**Addresses:** F-10, F-16, AC-6, AC-8 · **Effort:** L · **Risk of change:** high (operational)

**Change**
- Create `friday-agent` (no login shell beyond a restricted one, no sudo, no supplementary groups) and `friday-file`.
- Run the terminal child via `setpriv --reuid=… --regid=… --clear-groups` with a minimal environment.
- Move the agents (Hermes, OpenCode) under `friday-agent` with their own `HOME`.
- Remove `ubuntu` from the `docker` group — group membership is root-equivalent and `NoNewPrivileges` does not block it (the Docker socket is reachable by any member).
- Set `FS_ROOTS` to a directory owned by `friday-file`.

**Files:** `server/src/routes/terminal.ts`, `infra/systemd/friday-one-api.service`, `infra/docker-compose.yml`
**Regression test:** from inside a terminal session, assert `id -u` is the agent uid, `sudo -n id` fails, `docker ps` fails, and `~/.hermes/auth.json` is not readable.
**Rollback:** revert the spawn and unit changes; re-run `scripts/run-server.sh` by hand.
**Owner decision required:** this changes where the agents keep their state (Hermes config, MCP servers, skills). **It will move the owner's agent setup** — plan the migration.

---

### R-11 · Give the terminal child a minimal environment
**Addresses:** F-10 · **Effort:** S · **Risk of change:** low
*(If R-10 is done, this is subsumed; do it either way as defence in depth.)*

**Change** — `server/src/routes/terminal.ts`:
```ts
env: {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: spec.cwd,
  LANG: process.env.LANG ?? "C.UTF-8",
  TERM: "xterm-256color",
  COLUMNS: String(cols), LINES: String(rows),
  COLORTERM: "truecolor", FORCE_COLOR: "1",
},
```
**Regression test:** assert the child environment contains exactly the allowlisted keys.
**Rollback:** single-file revert.

---

### R-12 · Replace the quick tunnel with the named tunnel, and drop gist discovery
**Addresses:** F-22, and unblocks R-04 · **Effort:** S–M · **Risk of change:** medium

**Change**
- Complete `scripts/setup-named-tunnel.sh`: delegate `knistudio.in` to Cloudflare, authenticate, create the named tunnel `friday-one`, route `friday.knistudio.in`, install the unit.
- Bake `https://friday.knistudio.in` into the APK as `FRIDAY_BASE_URL`.
- Remove the `EndpointDiscovery` call from `MainActivity` (or keep it as a *fallback only*, with a pinned host allowlist and a signed document).
- `CertificatePinning` then pins a stable hostname, so R-04's pins survive a tunnel restart.

**Files:** `scripts/setup-named-tunnel.sh`, `infra/systemd/friday-one-tunnel.service`, `android/.../MainActivity.kt`, `android/.../EndpointDiscovery.kt`
**Regression test:** assert the app reaches the server with no discovery fetch; assert a non-allowlisted discovery document is ignored.
**Rollback:** re-run the quick-tunnel unit; the `FRIDAY_BASE_URL` build flag makes a rebuild trivial.
**Prerequisite:** DNS delegation of `knistudio.in` to Cloudflare — **an owner action, outside my reach.** The script detects and reports it.

---

### R-13 · Fix the release signing, the DB role, the trust gate on `/system`, and the crash-report read scope
**Addresses:** F-09, F-12, F-13, F-14 · **Effort:** S each · **Risk of change:** low each

- **F-14:** create a release keystore; reference it through Gradle properties; assert in CI that the release APK's certificate is not the debug certificate. **Do this before distributing any APK.**
- **F-09:** create a dedicated `friday_app` role with only the privileges the app needs; the container's bootstrap superuser stays for bootstrap. The audit harness proved this works with a role that owns only its own tables.
- **F-13:** change `/system` to `app.authenticateTrusted`; add a minimal `/system/summary` for untrusted devices; drop `proc.pid` and `proc.rss` from the response.
- **F-12:** change the crash read query so unlinked reports are not surfaced to the owner, and add a retention policy.

**Files:** `android/app/build.gradle.kts`, `infra/docker-compose.yml`, `infra/.env`, `server/src/routes/system.ts`, `server/src/routes/crash.ts`
**Regression test:** one per item, as listed in `findings.md`.
**Rollback:** each is an independent commit.

---

## P3 — Lower-priority improvements

| ID | Finding | Change | Effort |
|---|---|---|---|
| R-14 | F-15 | Add Android unit + instrumented tests; wire into CI | M |
| R-15 | F-17 | Cap concurrent terminal sessions; cap output; add backpressure; add `MemoryMax=`/`TasksMax=` to the unit | M |
| R-16 | F-19 | `git init`, `.gitignore`, initial commit, tag `pre-audit`; move `infra/endpoint.json` to runtime state | S |
| R-17 | F-20 | CI workflow: `npm ci`, `npm audit`, `tsc --noEmit`, `node --test`, `gitleaks`, Android lint + tests, `apksigner` check | M |
| R-18 | F-18 | `npm install --save-exact ws@8.22.0`; commit the lockfile | S |
| R-19 | F-21 | Record the xterm.js version + SHA-256 in `THIRD-PARTY.md`; add a CI hash check; ship or strip the source map | S |
| R-20 | F-23 | Crash-report retention policy + a delete endpoint | S |
| R-21 | F-24 | Derive `platform` from the verified device key; render `name` as user-supplied | S |
| R-22 | F-25 | Keep `CORS_ORIGINS` explicit; never `*`; document that the API is not browser-facing | S |
| R-23 | F-26 | Stop storing the owner email in the audit `detail`; drop the hardcoded personal name | S |
| R-24 | — | Replace the JWT query parameter with a single-use 60-second ws-ticket | M |
| R-25 | — | Remove the registration endpoint from the running service; provision only via `seed-owner.ts` | S |

---

## Dependency graph

```
R-16 (git) ──┬─→ everything (rollback safety)
              │
R-12 (named tunnel) ──→ R-04 (pins need a stable host)
                            │
R-05 (algorithm+exp) ──→ R-06 (jwt 10.x)   ← do together
                            │
R-01 (FS_ROOTS) ──────────→ R-03? no, independent
R-02 (allowlist) ──────────→ independent
R-09 (env scrub) ──────────→ R-11 (minimal env) → R-10 (separate users)
R-07 (XFF) ────────────────→ independent
R-08 (revocation) ─────────→ independent
R-13 (signing/db/trust) ───→ independent
R-14/R-17 (tests/CI) ──────→ gate every future change
```

**Suggested sequence**

| Batch | Items | Why together |
|---|---|---|
| 1 | R-16, R-01, R-02, R-03, R-18 | Config and containment; no behavioural risk; establishes version control first |
| 2 | R-05 + R-06, R-07, R-08, R-09 + R-11 | The server hardening set; the acceptance matrix is the safety net |
| 3 | R-12, then R-04 | The named tunnel must land before the pins can be meaningful |
| 4 | R-13 | Signing, DB role, trust gate, crash scope |
| 5 | R-10, R-15, R-14, R-17, R-19…R-25 | Isolation, resource caps, and the long tail |

---

## What is deliberately NOT proposed

- **Not weakening the lockout.** The per-account lockout is a DoS risk against the owner, but removing it opens account brute-force. R-07 fixes the *IP* throttle; the account lockout stays.
- **Not removing the `bash -l` terminal silently.** It is a real product decision (see the threat model, §8). Options: (a) keep it and document it as a privileged capability with the R-10 isolation around it; (b) remove `shell` from `COMMANDS` and keep only `hermes` and `opencode`; (c) keep it but require a second factor for that specific terminal kind. **This is the owner's call and it is the one decision in this audit that needs a human.**
- **Not adding a WAF or a CAPTCHA.** Overkill for a single-operator service; the allowlist and the lockout are the right controls.
- **Not "fixing" the fact that the tunnel hostname is public.** It must be discoverable by the app. The fix is pinning and a named host (R-04, R-12), not secrecy.
