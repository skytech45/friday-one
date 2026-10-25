# FRIDAY One — Findings

**Date:** 2026-10-23
**Scope:** `~/friday-one` (Android client, backend, infrastructure)
**Method:** Read-only source review + isolated empirical validation against a dedicated Postgres role and a throwaway filesystem root. No production secret was used as a test input; no production file was modified.
**Status legend:** `confirmed` = reproduced by execution · `likely` = strong source evidence, not executed · `unverified` = plausible, needs a check · `informational` = observation, not a vulnerability · `fixed` = remediated and re-verified

**Severity distribution:** Critical 2 · High 3 · Medium 10 · Low 7 · Informational 4 — **26 findings**

---

## Remediation status (updated 2026-10-24)

The severity figures above describe the state **at audit time**. Since then, the
P0 and most of the P1 batch has been implemented, committed and re-verified.
`findings.json` carries the machine-readable status of every finding.

**Closed — 14 findings:** F-02, F-03, F-04, F-05, F-06, F-07, F-08, F-09, F-10, F-11, F-12, F-13, F-18, F-19
The upgrade debt behind the one partially-closed finding (F-11) is closed too.
**Open — 12:** F-01, F-14, F-15, F-16, F-17, F-20, F-21, F-22, F-23, F-24, F-25, F-26

| Commit | Scope |
|---|---|
| `789777d` | P0: FS_ROOTS narrowed + credential denylist, fail-closed registration, token log redaction, `ws` pinned |
| `3669d64` | P1: JWT algorithm pinning + claim validation, DB error-disclosure fix |
| `0a497fc` | P1: client-IP spoofing fix, immediate revocation, harness process-group fix |
| `87d5e37` | P1: secrets out of the process environment, terminal child env allowlist |
| `2bb194b` | P0: least-privilege friday_app database role; migrations moved to a bootstrap-only MIGRATE_DATABASE_URL (F-09) |
| `b16d755` | P1: /system gated on device trust, minimal /system/summary, proc.pid/proc.rss dropped (F-13) |
| `60e5b1f` | P1: @fastify/jwt 10.2.5 / fast-jwt 6.3.5, zod 4.6.7 — npm audit clean (F-11) |
| `5dfdb00` | P1: unlinked crash reports hidden from the console, writes sanitised (F-12) |

**Verification at each commit:** `tsc --noEmit` clean · 20/20 unit tests ·
71/71 end-to-end checks · 5/5 R-02 · 5/5 R-07 · 7/7 R-09.

The individual finding sections below keep their **original** status so the
audit record stays a faithful snapshot of what was found. Read this section for
what is still outstanding.

**What remains open, in priority order:**

1. **F-14** — the release APK is still debug-signed. Do this before distributing any build.
2. **F-01** — the Android security layer is still dead code (no biometric gate, no pinning, no device binding). Blocked on F-22 (a stable hostname) for the pins to be meaningful.
3. **F-22** — the tunnel is down and discovery is still unauthenticated.
4. **F-20, F-15** — no CI, and no Android tests.

---

## F-01 · The Android client's entire security layer is dead code

| | |
|---|---|
| **Severity** | Critical |
| **Confidence** | Confirmed (exhaustive call-site analysis) |
| **Status** | open |
| **Location** | `android/app/src/main/java/com/friday/one/security/AppLock.kt`, `DeviceIntegrityGate.kt`, `TamperDetection.kt`, `android/app/src/main/java/com/friday/one/data/NetworkModule.kt` |
| **CWE** | CWE-693 (Protection Mechanism Failure) |

**Expected property:** The shipped app gates its UI behind a biometric check, pins the server's TLS certificate, detects a rooted/emulated device, and binds itself to the handset cryptographically.

**Observed behaviour:** None of these happen. The four classes below are referenced by **zero** production call sites:

| Class | Purpose | Referenced from |
|---|---|---|
| `AppLock` | `BiometricPrompt` gate before the UI renders | nothing |
| `DeviceIntegrityGate` | Emulator heuristics + keystore key self-test | nothing |
| `TamperDetection` | Root / test-keys telemetry | nothing |
| `NetworkModule` | Certificate pinning + `TokenRefreshAuthenticator` | nothing (only its own file) |

Verification:
```bash
$ grep -rl "AppLock\|DeviceIntegrityGate\|TamperDetection\|NetworkModule" \
    --include=*.kt android/app/src/main/java
android/app/src/main/java/com/friday/one/security/AppLock.kt
android/app/src/main/java/com/friday/one/security/DeviceIntegrityGate.kt
android/app/src/main/java/com/friday/one/security/TamperDetection.kt
android/app/src/main/java/com/friday/one/data/NetworkModule.kt
```
Only the definitions themselves. `MainActivity.kt:216,282,615` and `SessionStore.kt:95` and `FridayApp.kt:54` all call `ApiClient.create(...)`, which builds a plain `OkHttpClient` (`data/Api.kt:201-224`) with **no pinning and no authenticator**.

Additionally, even if `NetworkModule` were wired, pinning would still be inert: `CertificatePinning.kt:30-32` holds an empty `TUNNEL_PINS` list with a `// TODO(ws3): replace with actual pins` comment, and `apply()` returns early when the list is empty (line 53).

**Concrete consequences**

1. **No certificate pinning.** The app talks to a public `*.trycloudflare.com` hostname. Any party that can present a publicly-trusted certificate for that host intercepts the session, including the bearer token and the refresh token.
2. **No biometric gate.** `MainActivity.onCreate` (line 54-66) renders `AppRoot` directly. A live session on a lost or borrowed phone opens straight into the terminal tab.
3. **No cryptographic device binding.** `DeviceLockManager` generates an EC P-256 key and can sign challenges, but the server **never reads** the columns created for it. `grep -rn "public_key\|public_key_id\|key_bound_at\|key_security_level" server/src/` returns nothing outside `schema-device-binding.sql`. The device model is a *fingerprint* — a SHA-256 over build fields plus a keystore-HMAC install id — which a rooted device can reproduce.
4. **No refresh authenticator.** A 401 never triggers a refresh; `SessionStore.validToken()` refreshes proactively instead, which works but means a mid-session token failure surfaces as a silent error rather than a re-auth.

**Realistic scenario:** The phone is lost, or the device is picked up. No biometric prompt appears. The terminal tab opens a remote shell as the owner. Separately, a hostile network between the phone and the tunnel harvests the session token.

**Impact:** Confidentiality (session token interception), Integrity (the client cannot be bound to a device, so the server's trust model is unenforceable), Availability — n/a. The device-binding and pinning claims in `docs/TASKS.md` (WS3) and `docs/SHARED.md` are **unimplemented in the shipped binary**.

**Root cause:** The WS3 workstream produced well-designed, well-commented classes but the integration step — calling them from `MainActivity` — was never done, and the `launch_team.sh` contract only said "do NOT edit MainActivity.kt", so no agent could wire them in.

**Recommended fix**
- `MainActivity.kt` — call `AppLock.authenticate(...)` before rendering the dashboard when a session exists; call `DeviceIntegrityGate.evaluate()` and report the verdict.
- `NetworkModule.createApi(...)` — replace every `ApiClient.create(...)` call site with the pinned client; populate `TUNNEL_PINS` from the live tunnel certificate (rotation procedure is already documented in the class comment).
- `ApiClient` — register `TokenRefreshAuthenticator` on the shared client.
- `DeviceLockManager` — expose `publicKeyEncoded()`/`publicKeyId()` at registration; implement the server-side challenge/verify path (F-06/F-08 depend on it).

**Regression test:** instrumented test asserting that (a) a `BiometricPrompt` is shown before the dashboard when a session exists, (b) a non-loopback host with an untrusted certificate fails the TLS handshake, (c) `MainActivity` has no remaining `ApiClient.create` call site.

**Residual risk:** Client-side checks are defeatable on a rooted device by design; only server-side signature verification is authoritative.

---

## F-02 · `FS_ROOTS=/home/ubuntu` serves the owner's entire home directory over HTTP

| | |
|---|---|
| **Severity** | Critical |
| **Confidence** | Confirmed (files downloaded) |
| **Status** | open |
| **Location** | `server/src/routes/files.ts:12-15` (ROOTS), `server/.env` (`FS_ROOTS=/home/ubuntu`) |
| **CWE** | CWE-552 (Files or Directories Accessible to External Parties) |

**Expected property:** The file API exposes only the files the owner intends to manage from the phone, and never the credentials that make the rest of the system work.

**Observed behaviour:** The path jail is **correctly implemented** — `safePath()` (`files.ts:26-45`) resolves the candidate, `realpath()`s it (collapsing `..`, symlinks and `/proc/self/cwd` tricks), validates the parent for a non-existent leaf, and requires the result to equal or sit under a root. Every traversal and symlink case tested was rejected. **The configuration is wrong**: the root is the home directory, so "inside the roots" includes everything that matters.

Direct downloads against an isolated instance with a realistic fixture home:
```
GET /fs/download?path=<ROOT>/.ssh/authorized_keys   -> 200  ssh-ed25519 AAAA… owner@phone
GET /fs/download?path=<ROOT>/.hermes/auth.json      -> 200  {"api_key":"sk-live-…"}
GET /fs/download?path=<ROOT>/app/.env               -> 200  JWT_SECRET=super-secret-value
                                                             DATABASE_URL=postgres://u:p@h/db
```

**Realistic scenario:** Any principal holding a trusted-device token (a stolen access token, a token from the log — F-03, a token minted from the stolen `JWT_SECRET` — F-06) downloads `server/.env` and obtains the JWT signing key. With that key they mint a token for any `sub`/`did`; `authenticateTrusted` (`index.ts:78-86`) only checks the `did` against the database, so the forged `did` passes (F-06, F-08). From there: full filesystem plus a remote shell.

**Impact:** Confidentiality — SSH authorized keys, live Hermes agent credentials, the JWT signing key, the database password. This is the pivot that turns a single token leak into host compromise.

**Root cause:** `FS_ROOTS` was set to the home directory as a convenience default and never narrowed. The jail's author documented it as "the path jail" without noticing that the root itself was the problem.

**Recommended fix**
- Narrow `FS_ROOTS` to a dedicated directory, e.g. `FS_ROOTS=/home/ubuntu/friday-one/storage`.
- Add a denylist inside `safePath()` for dot-directories and known secret filenames (`.ssh`, `.aws`, `.hermes`, `.env`, `id_rsa`, `*.pem`, `*.key`) — a root is necessary but not sufficient.
- Move the DB credential out of `server/.env` into the systemd `EnvironmentFile` so the app process never holds it.

**Regression test:** extend `server/test/pathjail.test.ts` with a case asserting that `<root>/.ssh/authorized_keys` is rejected; add an integration check that `GET /fs/download?path=<root>/.env` returns 403.

**Residual risk:** Anything the owner deliberately places inside the approved root is readable by a trusted session — by design.

---

## F-03 · The WebSocket access token is written to the server log on every connection

| | |
|---|---|
| **Severity** | High |
| **Confidence** | Confirmed (observed in live server output) |
| **Status** | open |
| **Location** | `server/src/routes/terminal.ts:36` (token from query string), `server/src/index.ts:36-40` (default Pino logger) |
| **CWE** | CWE-532 (Insertion of Sensitive Information into Log File) |

**Expected property:** Session credentials are never persisted in logs.

**Observed behaviour:** Fastify's default request logger records the full request URL, and the terminal authenticates by query parameter:

```json
{"level":30,"req":{"method":"GET","url":"/ws/terminal?kind=shell&token=eyJhbGciOiJIUzI1NiJ9…"},
 "msg":"incoming request"}
```

Confirmed on a real WebSocket connection, not a simulation.

**Realistic scenario:** The token is a 15-minute bearer credential that also grants a remote shell. It is written to stdout → the systemd journal. Journal access is available to the `ubuntu` user and to anyone who can read the journal or a pasted bug report — and the token stays valid for 15 minutes *after* it is read.

**Impact:** Confidentiality — session theft. Combined with F-02 this is a full-chain compromise.

**Root cause:** The token-in-query trade-off is a legitimate constraint (WebView WebSocket handshakes cannot set custom headers) and the code comments say so — but the logging consequence was not addressed.

**Recommended fix**
- Redact the query string in the logger: a Pino `serializers.req` hook that strips `token` from `req.url` before it is written.
- Better: replace the query parameter with a single-use ticket. `POST /auth/ws-ticket` → server issues a 60-second nonce bound to `(user, device, kind)` → the socket consumes it once. The token never appears in a URL, and the ticket can never be replayed.
- Rotate `JWT_SECRET` after the fix if the journal may have been collected.

**Regression test:** connect a WebSocket with a token, then assert the captured log output does not contain the token string.

**Residual risk:** The token still transits the URL, so it can appear in a proxy's access log or an intermediate cache. The ticket design removes that too.

---

## F-04 · Registration fails open when `ALLOWED_EMAILS` is unset

| | |
|---|---|
| **Severity** | High |
| **Confidence** | Confirmed (anonymous registration succeeded end-to-end) |
| **Status** | open |
| **Location** | `server/src/routes/auth.ts:155-159` |
| **CWE** | CWE-1188 (Initialization with an Insecure Default) |

**Expected property:** A single-operator control plane refuses to accept new accounts unless it has been explicitly configured with the owner's address.

**Observed behaviour:** The allowlist is only enforced when it is non-empty:
```ts
const allowed = allowedEmails();
if (allowed.length > 0 && !allowed.includes(email)) {
  return reply.code(403).send({ error: "registration_closed" });
}
```
The comment states the intent: *"empty disables the check so a fresh deployment is not bricked before it is configured."* That is the wrong default for a system exposed to the internet.

Verified end-to-end with `ALLOWED_EMAILS=""`:
```
POST /auth/register (attacker@evil.example)  -> 201, trusted=true, deviceId issued
  GET /fs/list                                 -> 200  (full file tree)
  WebSocket /ws/terminal?kind=shell            -> opened  (remote shell as the owner)
```

**Realistic scenario:** The service is redeployed with a fresh `.env`, or the variable is lost in a refactor, or a staging copy is exposed. Any internet party that learns the tunnel URL registers and immediately holds a trusted device and a remote shell.

**Impact:** Critical when triggered — complete unauthenticated takeover. Availability — a persistent attacker account cannot be removed through the API (only `seed-owner.ts` disables other accounts, and it must be re-run).

**Root cause:** Convenience over fail-safe, in a system whose entire security model rests on there being exactly one user.

**Recommended fix**
- Make the allowlist **mandatory**: if `ALLOWED_EMAILS` is empty or unset, refuse `/auth/register` with `503 registration_not_configured` and log loudly at startup.
- Alternative: remove `/auth/register` from the running service entirely and provision the owner only via `seed-owner.ts` over SSH. The Android client would drop its "Create account" mode. This is the stronger option and matches `seed-owner.ts`'s existing behaviour of disabling all other accounts.

**Regression test:** boot with `ALLOWED_EMAILS=""` and assert `/auth/register` returns 503; boot with a configured allowlist and assert a non-allowlisted email returns 403.

**Residual risk:** The owner's own registration flow must still work; keep `seed-owner.ts` as the recovery path.

---

## F-05 · `X-Forwarded-For` spoofing resets the rate-limit buckets

| | |
|---|---|
| **Severity** | High |
| **Confidence** | Confirmed (measured) |
| **Status** | open |
| **Location** | `server/src/index.ts:38` (`trustProxy: true`), `server/src/loginGuard.ts:74-76` (`clientIp` = `req.ip`) |
| **CWE** | CWE-345 (Insufficient Verification of Data Authenticity) |

**Expected property:** Rate limiting and lockout cannot be reset by the client.

**Observed behaviour:** `trustProxy: true` makes Fastify take `req.ip` from the client-supplied `X-Forwarded-For` header, and both throttles key off `req.ip`.

```
GET /system/ping  X-Forwarded-For: 1.1.1.1  -> remaining=999
GET /system/ping  X-Forwarded-For: 1.1.1.1  -> remaining=998   (same bucket)
GET /system/ping  X-Forwarded-For: 2.2.2.2  -> remaining=999   (FRESH bucket)
```
The per-IP login throttle (`IP_MAX_ATTEMPTS`, default 10 per 15 min) is bypassable the same way.

**Realistic scenario:** An attacker rotates `X-Forwarded-For` and gets unlimited login attempts against the per-IP throttle, and an unlimited request budget against the global limiter. The **per-account lockout still holds** — it is keyed on the user id in PostgreSQL and survived every test — so this amplifies an attack rather than enabling account takeover. It also means the audit log's `ip` column records attacker-controlled values, degrading forensic value.

**Impact:** Availability (lockout bypass, CPU exhaustion via unlimited scrypt attempts) and Integrity (audit-log IP field is attacker-controlled).

**Root cause:** `trustProxy: true` is the correct setting *if* the app only ever sees traffic from a trusted proxy. The Cloudflare Tunnel does terminate the connection, but cloudflared does not strip client-supplied `X-Forwarded-For` by default, so the value is not trustworthy.

**Recommended fix**
- Do not set `trustProxy: true` globally. Either:
  - `trustProxy: "127.0.0.1"` — trust the header only when the immediate peer is loopback (the tunnel), and configure cloudflared to send a *verified* `CF-Connecting-IP` header, which Cloudflare overwrites and the client cannot forge; or
  - resolve the client IP from `CF-Connecting-IP` explicitly and ignore `X-Forwarded-For` entirely.
- Derive the per-IP throttle key from that same verified source.

**Regression test:** send `X-Forwarded-For: 1.1.1.1` and `X-Forwarded-For: 2.2.2.2` and assert the throttle bucket does **not** reset; send a forged `CF-Connecting-IP` and assert it is ignored.

**Residual risk:** If the service is ever bound to a non-loopback interface, `trustProxy` must be revisited. `index.ts:34` binds to `127.0.0.1` by default — keep it that way.

---

## F-06 · JWT verification accepts any HMAC algorithm

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | Confirmed (acceptance matrix) |
| **Status** | open |
| **Location** | `server/src/index.ts:52-56` |
| **CWE** | CWE-327 (Use of a Broken or Risky Cryptographic Algorithm) |

**Expected property:** Only one algorithm is accepted for verification.

**Observed behaviour:** The plugin is registered with a secret but no `algorithms` restriction:
```ts
await app.register(jwt, { secret: process.env.JWT_SECRET ?? (() => { throw … })() });
```
Acceptance matrix against the installed `fast-jwt@5.0.6` (15 variants):

| Token | Result |
|---|---|
| `alg:none`, empty sig | rejected |
| `alg:none` / `None` / `NONE` / `nOnE` with a signature | rejected |
| `HS256` signed with a **wrong** key | rejected |
| `RS256` / `PS256` header, HMAC-signed with the real secret | rejected |
| **`HS384` signed with the real secret** | **ACCEPTED** |
| **`HS512` signed with the real secret** | **ACCEPTED** |
| **`HS256` with no `typ` in the header** | **ACCEPTED** |
| **`HS256` with a `crit` header extension** | **ACCEPTED** |
| `HS256`, expired (`exp` in the past) | rejected |

**Realistic scenario:** The classic algorithm-confusion attack is blocked (the `RS256`/`PS256` rows), because `fast-jwt` will not treat an RSA alg as an HMAC alg. But the accepted set is wider than intended: an attacker who learns the secret can mint with any of three algorithms. The practical impact is limited today because the secret is the only key — but the finding matters for the **next** step: if the device-binding work (F-01) moves to RS256/ES256 with a public key, the unconstrained `algorithms` list is exactly the configuration that turns algorithm confusion into a full bypass.

**Impact:** Integrity — a token signed with an unintended algorithm is accepted. Contributes to the forgery chain in F-08.

**Root cause:** The algorithm list was left to the library's default rather than pinned.

**Recommended fix**
```ts
await app.register(jwt, {
  secret: process.env.JWT_SECRET ?? (() => { throw new Error("JWT_SECRET is not set"); })(),
  algorithms: ["HS256"],          // pin explicitly
  verify: { allowedIss: undefined, allowedAud: undefined },
});
```
- Also reject tokens whose payload is not a plain object (the advisory about array payloads) by adding a `verify` hook.
- Reject the `crit` header extension explicitly.

**Regression test:** the acceptance matrix in `audit/audit-algtest.mjs` is directly reusable — assert that HS384/HS512/array-payload/crit-header are all rejected after the fix.

**Residual risk:** None material. This is a defence-in-depth tightening.

---

## F-07 · A revoked device keeps a working access token for up to 15 minutes

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | Confirmed (measured) |
| **Status** | open |
| **Location** | `server/src/index.ts:64-70` (`authenticate`), `server/src/routes/auth.ts:382-397` (revoke) |
| **CWE** | CWE-613 (Insufficient Session Expiration) |

**Expected property:** Revoking a device immediately terminates its access.

**Observed behaviour:** Revocation is enforced in the `devices` table, but `authenticate` (`index.ts:64-70`) only verifies the JWT signature and never consults `devices`. Measured:

```
GET /system      with the token BEFORE revoke -> 200
DELETE /auth/devices/:id                       -> 200
GET /system      with the SAME token AFTER      -> 200   <-- still valid
GET /fs/list    with the SAME token AFTER      -> 403   (the trust check caught it)
WebSocket       with the SAME token AFTER      -> 4403  (the trust check caught it)
```

So the sensitive routes (`/fs/*`, `/ws/terminal`) *are* covered by the trust check, but `/system` — which returns the hostname, platform, CPU model, server PID, memory, disk usage, boot time, mount table and network interface names — is not.

**Realistic scenario:** The owner revokes a lost phone. For the remainder of the token's 15-minute life, that phone's token still reaches `/system`. The window is short and the exposure is telemetry rather than files or shell, which is why this is Medium rather than High — but the same gap applies to `/me` and to any future route that uses `authenticate` instead of `authenticateTrusted`.

**Impact:** Confidentiality — host telemetry remains reachable after revocation. Integrity — the audit trail shows a "revoked" device still active.

**Root cause:** `authenticate` performs no database check, by design, to keep the hot path cheap. The revocation check lives only in `authenticateTrusted`.

**Recommended fix**
- Add a short-lived revocation cache: on `DELETE /auth/devices/:id` and on `POST /auth/logout`, push the device id / session id into an in-memory LRU with a TTL equal to the access-token lifetime. `authenticate` consults it (a memory hit, no DB round-trip).
- Alternatively, drop the access-token lifetime from 15 minutes to 2-5 minutes, so the window shrinks; the client already refreshes proactively via `SessionStore.validToken()`.
- Use `authenticateTrusted` for `/system` if the telemetry is not needed by an untrusted device — arguably it should be, since an untrusted device has no legitimate need for the server's PID.

**Regression test:** revoke a device, then assert `/system` with the old token returns 401/403 within the token's lifetime.

**Residual risk:** A token issued in the last moment before revocation stays valid for its remaining TTL. That is inherent to stateless tokens and is why the TTL matters.

---

## F-08 · A JWT without an `exp` claim is accepted

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | Confirmed (accepted, then used successfully) |
| **Status** | open |
| **Location** | `server/src/index.ts:52-56`, `server/src/index.ts:64-86` |
| **CWE** | CWE-613 (Insufficient Session Expiration) |

**Expected property:** Every accepted access token has a bounded lifetime.

**Observed behaviour:** The server's own `app.jwt.sign({ sub, did }, { expiresIn: "15m" })` sets `exp`, but verification does not **require** it. A token correctly signed with the real secret and containing only `{ sub, did }` is accepted and works:

```
craft { sub: "<real user id>", did: "<real device id>" }  (valid HMAC, no exp)
  -> GET /me     200
```

This token never expires.

**Realistic scenario:** Combined with F-06 (any HMAC algorithm accepted) and knowledge of `JWT_SECRET`, an attacker mints a **permanent** token. The 15-minute expiry becomes decorative for anyone who can sign. It also means that if the signing key is ever rotated, old tokens stay valid forever — there is no expiry to fall back on.

**Impact:** Integrity — unbounded credential lifetime. Confidentiality — a leaked token is a permanent credential.

**Root cause:** `exp` is set at signing time but not asserted at verification time.

**Recommended fix**
- Add a `verify` hook to the JWT plugin that rejects a payload without a numeric `exp`:
```ts
verify: (payload) => {
  if (typeof payload.exp !== "number") throw new Error("token_missing_exp");
  return payload;
}
```
- Also validate `iss` and `aud` explicitly, and set them when signing.

**Regression test:** assert that a correctly-signed token with no `exp` is rejected, and that one with `exp` in the past is rejected.

**Residual risk:** None.

---

## F-09 · The database role is a PostgreSQL superuser

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | Confirmed (inspected live) |
| **Status** | open |
| **Location** | `infra/docker-compose.yml:11` (`POSTGRES_USER: friday`), `infra/.env` |
| **CWE** | CWE-250 (Execution with Unnecessary Privileges) |

**Expected property:** The application role has only the privileges the application needs.

**Observed behaviour:** The role the application connects as is the container's bootstrap superuser:
```
$ docker exec friday-pg psql -U friday -d postgres -c "\du"
  Role name | Attributes
  friday    | Superuser, Create role, Create DB, Replication, Bypass RLS
```
Because `POSTGRES_USER` is set to `friday`, the *bootstrap* role and the *application* role are the same entity. The audit harness used a separate `friday_audit` role owning only its own tables, and it worked with no additional grants — the application needs nothing like superuser.

**Realistic scenario:** Any SQL injection (none was found — all queries are parameterised), a compromised server process, or the terminal child (F-10) connecting to the database gains `BYPASSRLS`, `CREATEDB` and `CREATEROLE`, plus the ability to read and modify every database on the host, including the other applications' data.

**Impact:** Integrity and Availability — a compromised app can escalate to full database control and reach other tenants on the same Postgres instance.

**Root cause:** Convenience — `POSTGRES_USER` doubles as the application role.

**Recommended fix**
- Create a dedicated application role with only `CONNECT`/`USAGE`/`SELECT`/`INSERT`/`UPDATE`/`DELETE` on the `friday` database and its tables.
- Keep the superuser for container bootstrap only, and never put its credentials in an application-reachable file.
- Remove `Bypass RLS` (it is implied by superuser) and `Replication` from the app role.

**Regression test:** connect as the application role and assert `SELECT rolsuper FROM pg_roles WHERE rolname = current_user` is false, and that `CREATE DATABASE` is refused.

**Residual risk:** The application role can still read and write all of the FRIDAY One tables, including `sessions.token_hash` and the user password hashes. That is inherent to the application role.

---

## F-10 · The terminal child inherits the server's full environment, including secrets

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | Confirmed (read from inside the child) |
| **Status** | open |
| **Location** | `server/src/routes/terminal.ts:88-97` |
| **CWE** | CWE-526 (Cleartext Storage of Sensitive Information in an Environment Variable) / CWE-200 (Exposure of Sensitive Information) |

**Expected property:** A spawned terminal session receives only the environment it needs.

**Observed behaviour:** The spawn inherits everything:
```ts
spawn("script", ["-qfc", sized, "/dev/null"], {
  cwd: spec.cwd,
  env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(cols), … },
});
```
Measured from inside the terminal session:
```
UID=1001
USER=ubuntu
JWT_PRESENT=YES
JWT_PREFIX=audit-
DB_PRESENT=YES
PEPPER_PRESENT=YES
SUDO_N=uid=0(root) gid=0(root) groups=0(root)     <-- see F-16
CAN_READ_SSH=YES
CAN_READ_HERMES_AUTH=YES
CAN_READ_ENVFILE=YES
```

The `JWT_SECRET` and `DATABASE_URL` are handed to a shell that a phone is holding open. The `sudo -n` line is the important one — but see F-16: in the shipped systemd configuration that escalation is blocked.

**Realistic scenario:** The terminal is the app's headline feature. Anything that reaches the shell — the user's own keystrokes, a Hermes/OpenCode agent acting on a prompt-injected instruction, a malicious file the agent reads and executes — inherits the signing key and the database password as environment variables. `env` or `printenv` is a one-liner away.

**Impact:** Confidentiality — the JWT signing key and the DB password are exposed to a workload whose whole job is to run arbitrary agent-authored commands.

**Root cause:** The spread operator `...process.env` was the easy path, and the same pattern is needed for `PATH` and `HOME`.

**Recommended fix**
- Build an explicit allowlist environment for the child:
```ts
env: {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: spec.cwd,
  TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows),
  COLORTERM: "truecolor", FORCE_COLOR: "1",
  LANG: process.env.LANG ?? "C.UTF-8",
}
```
- Run the server process itself with the secrets removed from its environment where possible: load `server/.env` into a config object, `delete process.env.JWT_SECRET` after reading it, and pass the DB password via a `~/.pgpass` entry with `0600` permissions rather than in `DATABASE_URL`.
- Give the terminal child a dedicated unprivileged OS account (see Stage 6 of the brief).

**Regression test:** assert that the child environment contains no variable whose name matches `SECRET|TOKEN|PASSWORD|PEPPER|KEY`; assert `process.env` in the server process does not contain `JWT_SECRET` after startup.

**Residual risk:** `HOME` still points at the owner's home, so the child can read `~/.hermes` and `~/.ssh` directly. The real fix is a separate OS user with a separate home.

---

## F-11 · Two critical advisories in the JWT verification chain

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | Confirmed (`npm audit`) |
| **Status** | open |
| **Location** | `server/package.json:15` (`"@fastify/jwt": "^9.0.1"`), `server/package-lock.json` |
| **CWE** | CWE-1395 (Dependency on Vulnerable Third-Party Component) |

**Expected property:** The dependency tree is free of known critical vulnerabilities.

**Observed behaviour:** `npm audit --omit=dev` reports **2 critical** advisories, all in `fast-jwt <= 6.3.3`, reached through `@fastify/jwt@9.1.0`:
- `GHSA-hm7r-c7qw-ghp6` — unknown `crit` header extensions accepted (RFC 7515 violation). **Reproduced**: a token with `crit:["exp"]` was accepted.
- `GHSA-mvf2-f6gm-w987` — incomplete fix for CVE-2023-48223, algorithm confusion via whitespace-prefixed RSA public key.
- `GHSA-rp9m-7r4c-75qg` — cache confusion via `cacheKeyBuilder` collisions.
- `GHSA-cjw9-ghj4-fwxf` — ReDoS in `allowed*` regexp options.
- `GHSA-3j8v-cgw4-2g6q` — stateful regexp causes non-deterministic claim validation.
- `GHSA-gmvf-9v4p-v8jc` — **auth bypass if an empty HMAC secret is accepted by an async key resolver.** *Note: the shipped server uses a static secret, and the empty-secret case was tested and the server **refuses to start** (`@fastify/jwt` asserts "missing secret") — so this specific advisory does not apply. The `crit` one does.*
- `GHSA-x937-hj6v-793p` — the verifier cache accepts expired JWTs without `iat`.
- `GHSA-8wpc-h4q6-8fxv` — `createVerifier` accepts unsigned JWTs when the key is `''`/`null` and `algorithms` is set.
- `GHSA-687g-22h4-j4w4` — `clockTolerance: Infinity` bypasses `exp`/`nbf`. *Tested: the shipped server sets no `clockTolerance`, and with `clockTolerance: Infinity` set the token was still rejected. Not exploitable as configured.*
- `GHSA-5hjw-83fp-phq9` — silent claim-validator bypass when the payload is a JSON array. **Reproduced**: an array payload was accepted.

**Realistic scenario:** The `crit` and array-payload issues are directly reachable in the shipped configuration. Combined with F-06/F-08, the verifier accepts a wider set of token shapes than intended.

**Impact:** Integrity — malformed or non-conforming tokens are accepted; the `exp`-cache issue can accept expired tokens once the cache is warm.

**Root cause:** The dependency was pinned to a major version whose `fast-jwt` transitively pinned an old `fast-jwt`.

**Recommended fix**
- `@fastify/jwt` 9.x → **10.2.5** resolves the chain, but it is a breaking change (verify the API and the `verify`/`sign` option shapes against the 10.x docs).
- If the 10.x upgrade cannot be taken immediately, pin `fast-jwt` directly to a patched version with an npm `overrides` block:
```json
"overrides": { "fast-jwt": "^6.3.4" }
```
- Independently, add the `verify` hook from F-08 to reject array payloads and missing `exp` — defence in depth regardless of the library version.

**Regression test:** the acceptance matrix in `audit/audit-algtest.mjs` should assert every one of the 15 variants is rejected, and add cases for the `crit` header and the array payload.

**Residual risk:** Dependency advisories change; pin and re-audit on a schedule.

---

## F-12 · An unauthenticated party can write into the owner's crash console

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | Confirmed |
| **Status** | open (by design — but the read scope is wrong) |
| **Location** | `server/src/routes/crash.ts:26-79` (write), `crash.ts:81-91` (read) |
| **CWE** | CWE-20 (Improper Input Validation) / CWE-200 |

**Expected property:** A report visible in the owner's console originates from the owner's device.

**Observed behaviour:** The write endpoint is deliberately unauthenticated — *"the crashiest bugs happen before a session exists"*. The rate limit is 30/minute. The read query is:
```sql
WHERE user_id = $1 OR user_id IS NULL
```
A report submitted **without** a fingerprint gets `user_id = NULL` and therefore matches the `OR user_id IS NULL` branch — so it appears in the owner's list.

Verified:
```
POST /crash (no auth, message="ATTACKER CONTROLLED TEXT")  -> 202
GET  /crash (owner) -> 1 injected report visible
```

**Realistic scenario:** An internet party floods the console with fabricated "fatal" crash reports carrying hostile text and a crafted stack trace. The owner reads them in the app. This is a low-grade injection into the owner's UI (stored content rendered by the client) and a nuisance flood; if the client ever renders the message as rich text, it becomes more than a nuisance.

**Impact:** Integrity — the owner's console is polluted with attacker-authored content. Availability — the report list fills with junk.

**Root cause:** The unauthenticated write is a deliberate and defensible choice; the **read** query's `OR user_id IS NULL` clause is the defect, because it deliberately surfaces *unlinked* reports to the owner.

**Recommended fix**
- Keep the write endpoint unauthenticated.
- On read, return unlinked reports only if they were submitted with a fingerprint that matches a known device; otherwise put them in a separate "unverified" bucket, or drop them after a retention window.
- Add a per-submitter rate limit keyed on a server-issued install id so a single party cannot flood.
- Sanitise `message` and `stack_trace` on write (strip control characters, cap length) and ensure the client renders them as plain text.

**Regression test:** submit an unauthenticated report without a fingerprint and assert it does not appear in `GET /crash` for the owner.

**Residual risk:** A party that knows a valid device fingerprint can still inject linked reports. Treat the fingerprint as a weak identifier, not an authenticator.

---

## F-13 · An untrusted device receives full host telemetry

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | Confirmed |
| **Status** | open |
| **Location** | `server/src/routes/system.ts:188` (`{ preHandler: app.authenticate }`) |
| **CWE** | CWE-200 (Exposure of Sensitive Information) |

**Expected property:** Device trust gates the sensitive surface.

**Observed behaviour:** `/system` uses `authenticate` — any valid token, no trust check. Measured for a second device that is explicitly **untrusted**:
```
untrusted device GET /system -> 200
  host=sky  platform=linux 7.0.0-1010-oracle  cpu=Neoverse-N1
  server pid=69771  rss=163237888  booted_at=2026-09-05T07:51:01.751Z
  mounts=/,/home
```
It also returns per-core CPU usage, memory, disk usage, network interface names and rates, and the server's own PID and RSS.

**Realistic scenario:** An attacker with a stolen password registers a device, which starts untrusted, and immediately gets a host fingerprint: OS build, CPU model, uptime, boot time, mount layout, interface names, server PID. That is reconnaissance for the next step (identifying the cloud provider, the kernel, whether other volumes are mounted). The trust model exists precisely to gate this, and `/fs/*` and `/ws/terminal` are correctly gated — `/system` is the exception.

**Impact:** Confidentiality — host reconnaissance. Low-moderate severity because the data is metadata, not secrets or content.

**Root cause:** `/system` was written before the trust model existed, or was left on the weaker decorator by oversight.

**Recommended fix**
- Change `/system` to `app.authenticateTrusted`.
- If an untrusted device genuinely needs a status view, split out a minimal `/system/summary` that returns only `{ ok, version, uptime }`.
- Remove `proc.pid` and `proc.rss` from the response, or gate them behind trust.

**Regression test:** assert an untrusted device's token gets 403 on `/system` and 200 on `/system/summary`.

**Residual risk:** The client currently shows this telemetry on the "Machine" tab; the app must handle the 403 gracefully.

---

## F-14 · The release build is signed with the debug key

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | Confirmed (source) |
| **Status** | open |
| **Location** | `android/app/build.gradle.kts:32-39` |
| **CWE** | CWE-321 (Use of Hard-coded Cryptographic Key) |

**Expected property:** A release artifact is signed with a private release key held outside the repository.

**Observed behaviour:**
```kotlin
release {
    isMinifyEnabled = true
    isShrinkResources = true
    proguardFiles(…)
    // "a real release keystore belongs in CI secrets, never in the repo."
    signingConfig = signingConfigs.getByName("debug")
}
```
The comment states the correct intent; the code does the opposite. A debug-signed release means the APK carries the well-known Android debug certificate, whose private key is public. Anyone can produce an update signed with the same key, so the platform's signature check provides no assurance for this app.

**Realistic scenario:** An attacker publishes a "FRIDAY One update" signed with the public debug key. A user who sideloads it is running attacker code with the app's permissions and its stored session tokens.

**Impact:** Integrity — the release signing boundary does not exist.

**Root cause:** A deliberate placeholder left in place, with the explanation in a comment rather than in the build.

**Recommended fix**
- Create a release keystore, store it in a CI secret (or on the owner's machine outside the repo), and reference it through Gradle properties:
```kotlin
signingConfigs {
    create("release") {
        storeFile = file(providers.gradleProperty("RELEASE_STORE_FILE").get())
        storePassword = providers.gradleProperty("RELEASE_STORE_PASSWORD").get()
        keyAlias = providers.gradleProperty("RELEASE_KEY_ALIAS").get()
        keyPassword = providers.gradleProperty("RELEASE_KEY_PASSWORD").get()
    }
}
```
- Add a CI assertion that the release artifact is signed with the release key and not the debug key.
- The debug keystore's password is the well-known `android` — confirm no production install depends on it.

**Regression test:** `apksigner verify --print-certs` on the release APK must show the release certificate digest, and must **not** equal the debug certificate digest.

**Residual risk:** A leaked release key requires a new key and a forced update. Plan the rotation path before the first production release.

---

## F-15 · The Android client has no tests at all

| | |
|---|---|
| **Severity** | Medium |
| **Confidence** | Confirmed (directory inspection) |
| **Status** | open |
| **Location** | `android/app/src/` — `test/` and `androidTest/` do not exist |
| **CWE** | CWE-693 |

**Expected property:** Security-sensitive client behaviour is covered by tests.

**Observed behaviour:** `build.gradle.kts:91` declares `testImplementation("junit:junit:4.13.2")` and `testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"`, but there are **no test sources at all**:
```bash
$ find android -path "*/src/test*" -o -path "*/src/androidTest*"
(empty)
```
`junit` is declared but unused.

**Realistic scenario:** F-01 — the biometric gate, the pinning, the device binding — is a set of classes that were written, reviewed and never connected, and no test noticed. A test suite that asserted "a biometric prompt is required before the dashboard renders" would have caught it. The same class of defect recurs on every future change.

**Impact:** Integrity — every client-side control is unverified; regressions are silent.

**Root cause:** The workstream contract (`launch_team.sh`) told agents to *verify* their work by compiling, not by testing, and no agent was assigned to write tests.

**Recommended fix**
- Add `android/app/src/test/` with JVM unit tests for: `DeviceIdentity.fingerprint` stability and distinctness, `CertificatePinning.isLoopback` and the apply/no-op decision, `SessionStore.isExpiring` boundary behaviour, and `jsString` escaping in `TerminalScreen`.
- Add `android/app/src/androidTest/` with instrumented tests for: the biometric gate blocking the dashboard, the WebView refusing a non-allowed origin, and the release build configuration.
- Wire both into CI (F-20) with a coverage floor.

**Regression test:** n/a — the deliverable *is* the test suite.

**Residual risk:** Client tests do not cover the server; the server's own suite is 15 tests, which is adequate for its current scope but thin.

---

## F-16 · `NoNewPrivileges` blocks `sudo` in the terminal — effective, but load-bearing and unverified in anger

| | |
|---|---|
| **Severity** | Low |
| **Confidence** | Confirmed (empirically verified) |
| **Status** | open (mitigation effective; needs hardening) |
| **Location** | `infra/systemd/friday-one-api.service` (`NoNewPrivileges=true`), `server/src/routes/terminal.ts:88-97` |
| **CWE** | CWE-269 (Improper Privilege Management) — *mitigated* |

**Expected property:** A remote shell must not trivially become root.

**Observed behaviour:** The `ubuntu` account has `(ALL) NOPASSWD: ALL` in sudoers. Without the systemd flag, the terminal child escalates immediately:
```
sudo -n id  -> uid=0(root) gid=0(root) groups=0(root)
```
**With the shipped systemd unit** (`NoNewPrivileges=true`), the flag is inherited by the child and blocks it:
```
$ setpriv --no-new-privs sudo -n id
sudo: The "no new privileges" flag is set, which prevents sudo from running as root.

terminal child (server under NoNewPrivileges=true):
  NNP=NoNewPrivs: 1
  SUDO=sudo: The "no new privileges" flag is set, which prevents sudo from running as root.
```

**Assessment:** The mitigation is real and it is the single control standing between an authenticated session and root. It is also **load-bearing in a fragile way**:

1. The flag is set on `friday-one-api.service`, which is **not currently installed** — the service is `not-found` in systemd. Whoever deploys it must remember to use this unit, or run the server by hand, and the terminal becomes a root shell.
2. `NoNewPrivileges` blocks `sudo`, but it does not block reading `~/.hermes/auth.json`, `~/.ssh/authorized_keys` or `server/.env` — which the app also serves over HTTP (F-02).
3. The unit's own comment concedes the gap: *"AF_INET/AF_INET6 restricted via socket filtering would be ideal but requires a custom seccomp profile; binding to 127.0.0.1 in index.ts is the enforcement."*

**Impact:** Reduced. A remote shell is confined to the `ubuntu` user, but it can read that user's entire home directory, including the agent credentials and the server's secrets.

**Recommended fix**
- Treat `NoNewPrivileges=true` as **mandatory**, and add a startup assertion: the server refuses to start if `process.env` indicates it is not running under the hardened unit (e.g. check `/proc/self/status` `NoNewPrivs: 1`) when `TERMINAL_ENABLED=true`.
- Remove `ubuntu` from the `docker` group (group membership is equivalent to root, and it survived the `NoNewPrivileges` block via the socket).
- Give the terminal a dedicated unprivileged account with no sudo, no docker group, and its own home.
- Add `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` and consider `IPAddressDeny` for egress.

**Regression test:** an integration check that boots the server under the unit and asserts `sudo -n id` from the terminal fails.

**Residual risk:** A separate OS user with a separate home directory is the only durable fix; `NoNewPrivileges` is a backstop.

---

## F-17 · No resource limits on terminal sessions

| | |
|---|---|
| **Severity** | Low |
| **Confidence** | Likely (source evidence) |
| **Status** | open |
| **Location** | `server/src/routes/terminal.ts:84-98` |
| **CWE** | CWE-400 (Uncontrolled Resource Consumption) |

**Expected property:** A session cannot exhaust the host's processes, file descriptors or memory.

**Observed behaviour:** The route has no cap on concurrent sessions, no per-session output budget and no process-count limit. The terminal size is clamped (`cols` 20-300, `rows` 6-120), and PTYs are reaped correctly on socket close (verified: the child did not survive), but nothing bounds *how many* can exist or how much they can consume.

**Realistic scenario:** A client opens many WebSocket connections, each spawning `script` → `bash -l`. On a 2-core host with `workers.max=2` for the Android build, that starves the box. A single session running `yes` produces unbounded output into the socket buffer.

**Impact:** Availability.

**Root cause:** Resource management was not part of the terminal design.

**Recommended fix**
- Cap concurrent terminal sessions per user/device (e.g. 2) and per device overall; reject beyond that with close code `4408`.
- Apply a per-connection output byte budget and disconnect when exceeded.
- Set `maxBuffer` on the WebSocket; use `socket.pause()`/`resume()` for backpressure instead of buffering.
- Add `MemoryMax=` and `TasksMax=` to the systemd unit.

**Regression test:** open N+1 sessions and assert the N+1th is refused; assert a flood of output is disconnected rather than buffered.

**Residual risk:** A legitimate long-running agent session is resource-hungry by nature; the caps must be generous enough not to break it.

---

## F-18 · `ws` is used but not declared as a dependency

| | |
|---|---|
| **Severity** | Low |
| **Confidence** | Confirmed |
| **Status** | open |
| **Location** | `server/package.json:13-22` |
| **CWE** | CWE-1104 (Use of Unmaintained Third Party Components) |

**Expected property:** Every imported package is declared.

**Observed behaviour:** `ws@8.22.0` is present in `node_modules` only as a transitive dependency (of `@fastify/websocket`). The audit harness imported it directly and it resolved — the code works by accident, and would break the moment the transitive graph changes.

**Impact:** Low today; a supply-chain and reproducibility risk tomorrow.

**Recommended fix:** `npm install --save-exact ws@8.22.0` and commit the lockfile.

**Regression test:** `npm ci` on a clean checkout, then assert the server boots and the WebSocket route works.

**Residual risk:** n/a.

---

## F-19 · The project is not in version control

| | |
|---|---|
| **Severity** | Low |
| **Confidence** | Confirmed |
| **Status** | open |
| **Location** | `~/friday-one` — no `.git` directory |
| **CWE** | CWE-1104 / CWE-494 (Download of Code Without Integrity Check) |

**Expected property:** Every artifact has provenance and every change is revertible.

**Observed behaviour:** `ls -d .git` → not found. There is no history, no branch, no revert. `infra/endpoint.json` has changed 4 times today alone (the tunnel publisher rewrites it every 5 minutes), so it would be immediately dirty.

**Realistic scenario:** A bad deploy cannot be rolled back; a compromised file cannot be diffed against a known-good state; the audit's own remediations have nowhere to live. This is also why Stage 8's "scan Git history for committed secrets" is unfulfillable.

**Impact:** Integrity and Availability — no provenance, no rollback.

**Root cause:** The project was built by a parallel-agent workstream in a scratch directory and never initialised as a repository.

**Recommended fix**
```bash
cd ~/friday-one
git init && git add -A
printf '%s\n' 'server/.env' 'infra/.env' 'node_modules/' 'storage/' 'logs/' \
  'android/app/build/' 'android/.gradle/' 'android/local.properties' '*.log' 'audit/' > .gitignore
git commit -m "Initial import: FRIDAY One"
```
- Commit `infra/endpoint.json` to `.gitignore` (it churns every 5 minutes) and keep it as runtime state.
- Commit `server/package-lock.json` and `android/gradle/wrapper/gradle-wrapper.properties`.
- Tag the pre-audit state so the remediation can be diffed and reverted.

**Regression test:** `git status --porcelain` is empty after a clean deploy; `git fsck` passes.

**Residual risk:** A local git repository is not a backup — set up an off-host remote and a periodic snapshot of the Postgres volume.

---

## F-20 · There is no CI

| | |
|---|---|
| **Severity** | Low |
| **Confidence** | Confirmed |
| **Status** | open |
| **Location** | `~/friday-one` — no `.github/`, no pipeline files |
| **CWE** | CWE-778 (Insufficient Logging) |

**Expected property:** Tests, linting, dependency checks and secret scanning run automatically on every change.

**Observed behaviour:** No CI configuration exists. The only gates are manual (`npx tsc --noEmit`, `npx tsx --test`), and the Android build is gated by a `flock` on `/tmp/gradle.lock` — an admission-control file lock, not a quality gate.

**Realistic scenario:** F-15, F-18, F-19 and F-01 all describe defects that a five-line CI workflow would have caught or prevented. A "release" is whatever happens to be in the directory.

**Impact:** Integrity — no automated verification of any kind.

**Recommended fix**
- A GitHub Actions workflow (or equivalent) with: `npm ci`, `npm audit --audit-level=high`, `npx tsc --noEmit`, `npx tsx --test test/*.test.ts`, `gitleaks detect --redact`, an Android lint + unit-test job, and an `apksigner` release-signature assertion.
- Run the audit harnesses in `~/friday-one/audit/` as an integration job against a throwaway Postgres (they already self-clean).

**Regression test:** n/a — the deliverable is the pipeline.

**Residual risk:** CI on a self-hosted runner needs its own secrets handling.

---

## F-21 · `xterm.js` is vendored without provenance, and secrets files are unprotected

| | |
|---|---|
| **Severity** | Low |
| **Confidence** | Confirmed (source) |
| **Status** | open |
| **Location** | `android/app/src/main/assets/terminal/xterm.js` (289,441 bytes, minified, no version stamp), `server/.env` (0600), `infra/.env` (0600), `infra/endpoint.json` (0664) |
| **CWE** | CWE-494 (Download of Code Without Integrity Check) |

**Expected property:** Third-party code has a known version and an integrity check; secret files are not readable by other local users.

**Observed behaviour:** The vendored `xterm.js` has no version comment, no licence header and no SHA-256 recorded anywhere; the file ends with `//# sourceMappingURL=xterm.js.map` but the map is absent. A pattern scan of the tree for credentials found exactly one hit — a test-only literal in `server/test/auth.test.ts:14` (`"test-secret-for-pathjail-auth-tests-only"`) — so no real secret is committed. The `.env` files are `0600`, which is correct; `infra/endpoint.json` is `0664` but contains only a public URL.

**Impact:** Low. The vendored bundle cannot be traced to an upstream release, so a future diff against upstream is impossible and a compromised build would go unnoticed.

**Root cause:** The asset was downloaded and committed without a version or hash record.

**Recommended fix**
- Record the xterm.js version and its SHA-256 in `android/app/src/main/assets/terminal/THIRD-PARTY.md`, and add a CI check that re-hashes the file.
- Ship `xterm.js.map` or strip the `sourceMappingURL` comment.
- Keep `.env` at `0600`; add a CI check that no file matching `*.env` is ever staged.

**Regression test:** the hash check in CI.

**Residual risk:** n/a.

---

## F-22 · The published tunnel endpoint is dead and the discovery mechanism is unauthenticated

| | |
|---|---|
| **Severity** | Low |
| **Confidence** | Confirmed |
| **Status** | open |
| **Location** | `infra/endpoint.json`, `scripts/publish-endpoint.sh`, `android/.../EndpointDiscovery.kt:91-99` |
| **CWE** | CWE-345 / CWE-494 |

**Expected property:** The app always reaches the real server, and an attacker cannot redirect it.

**Observed behaviour:** The published endpoint returns HTTP 530:
```
https://society-tucson-achieve-course.trycloudflare.com  ->  530
```
The app discovers its server from a **public gist**:
```kotlin
const val DISCOVERY_URL = "https://gist.githubusercontent.com/skytech45/462b9df17f30fd7029e4ead519103f20/raw/endpoint.json"
```
The document is fetched over plain HTTPS from a fixed gist id, with no signature and no owner check. The client does apply two sound guards — the URL must be `https://` and the new host must answer `/health` before it is adopted — but neither proves the document came from the owner.

**Realistic scenario:** The gist id is discoverable from the APK. Anyone who can write to that gist (a leaked GitHub token, a compromised account) can point every installed copy of the app at a host they control. The app would then post the owner's credentials to that host. The `https://` and `/health` checks do not help: the attacker's host serves both.

**Impact:** Integrity — a redirection of the whole client to an attacker-controlled server, and with it the password and refresh token. Availability — the app is currently pointed at a 530.

**Root cause:** A public, unauthenticated document is used as a trust anchor.

**Recommended fix**
- **Best:** stop using discovery for the trust anchor. Use the named tunnel at `friday.knistudio.in` (the `setup-named-tunnel.sh` script already exists for this) with a fixed hostname baked into the APK, and keep certificate pinning (F-01) as the actual trust anchor.
- If discovery must stay: sign the document (HMAC or an asymmetric signature over the payload) and verify the signature in the client before adopting a URL; or pin the host to a known allowlist.
- Raise a loud alert when the publisher cannot reach a live tunnel: the timer currently logs success while republishing a dead URL.

**Regression test:** serve a signed/unsigned discovery document pointing at a hostile host and assert the client does not adopt it.

**Residual risk:** With a pinned hostname and certificate pinning, discovery becomes unnecessary.

---

## F-23 · Unlinked crash reports are retained and served indefinitely

| | |
|---|---|
| **Severity** | Informational |
| **Confidence** | Confirmed |
| **Status** | open |
| **Location** | `server/src/routes/crash.ts:81-91` |
| **CWE** | CWE-459 (Incomplete Cleanup) |

**Expected property:** Storage of attacker-controlled content is bounded and cleanable.

**Observed behaviour:** `GET /crash` returns `WHERE user_id = $1 OR user_id IS NULL LIMIT 100` — every unlinked report ever submitted is retained forever and surfaces to the owner (see F-12). There is no retention policy, no pruning job, and no way to delete a report through the API.

**Impact:** Informational — unbounded storage growth of attacker-controlled content, and the owner's console can never be cleaned.

**Recommended fix:** Add a retention policy (e.g. delete unlinked reports older than 30 days in `migrate.ts` or a periodic job) and a delete endpoint for the owner.

---

## F-24 · `role`/`name`/`appVersion` are client-controlled and stored unvalidated

| | |
|---|---|
| **Severity** | Informational |
| **Confidence** | Confirmed |
| **Status** | open |
| **Location** | `server/src/routes/auth.ts:35-40`, `server/src/schema.sql:22-34` |
| **CWE** | CWE-20 |

**Expected property:** Device labels reflect something the server can verify.

**Observed behaviour:** `name`, `platform` and `appVersion` are accepted from the client and stored as-is. `name` and `platform` are only length-capped (120 chars) and are rendered in the device list. A caller can label a device "iPhone 15, owner's personal phone" to make a hostile device look legitimate in the owner's UI.

**Impact:** Informational — display-layer spoofing. No authorisation decision depends on these fields.

**Recommended fix:** Derive `platform` from the verified device key or the User-Agent; treat `name` as a user-supplied label and render it in a way that distinguishes it from verified facts.

---

## F-25 · `CORS_ORIGINS` is empty while the API is publicly reachable

| | |
|---|---|
| **Severity** | Informational |
| **Confidence** | Confirmed (source; not exploitable as shipped) |
| **Status** | open |
| **Location** | `server/src/index.ts:42-45`, `server/.env` (`CORS_ORIGINS=`) |
| **CWE** | CWE-942 |

**Expected property:** Cross-origin browser access is explicitly denied or scoped.

**Observed behaviour:** `origin` is the split of `CORS_ORIGINS`, which is empty, so no origin is allowed — the safe default. But `@fastify/cors` with an empty allowlist still **responds** to preflight requests, and the API is reachable from any origin by a non-browser client (curl), which is the real threat model here anyway.

**Impact:** Informational today. If `CORS_ORIGINS` is ever set to `*` — a natural "make the web client work" change — a malicious page in any browser could drive the API using the victim's session, if the token were ever in a cookie. It is not (it is a bearer header), so the exposure is limited.

**Recommended fix:** Keep the allowlist explicit and never `*`. Document that the API is not browser-facing.

---

## F-26 · The owner account is protected by an in-code name, and `seed-owner.ts` prints the email

| | |
|---|---|
| **Severity** | Informational |
| **Confidence** | Confirmed |
| **Status** | open |
| **Location** | `server/src/seed-owner.ts:56`, `server/src/routes/auth.ts:234-237` |
| **CWE** | CWE-200 |

**Expected property:** Identity information is not leaked unnecessarily.

**Observed behaviour:** `seed-owner.ts` hardcodes `"Sachin"` as the display name and logs the owner's email address and the email of every disabled account. The audit log stores `{ email }` in the `detail` JSON for register/login events — the owner's email address, in plaintext, in a table that `/system/audit` returns to the client.

**Impact:** Informational. The email is already the account identifier and the logs are on the owner's own host. It does widen the blast radius of a database leak slightly.

**Recommended fix:** Store a hashed or truncated email in the audit `detail`, or drop it (the `user_id` already identifies the row). Avoid hardcoding a personal name in source.

---

## Summary table

| ID | Title | Severity | Confidence | Status | CVSS 4.0 |
|---|---|---|---|---|---|
| F-01 | Android client security layer is dead code | Critical | Confirmed | open | 8.1 |
| F-02 | `FS_ROOTS=/home/ubuntu` exposes the whole home dir over HTTP | Critical | Confirmed | open | 9.1 |
| F-03 | WebSocket access token written to the server log | High | Confirmed | open | 7.4 |
| F-04 | Registration fails open when `ALLOWED_EMAILS` is unset | High | Confirmed | open | 8.7 |
| F-05 | `X-Forwarded-For` spoofing resets the rate-limit buckets | High | Confirmed | open | 7.1 |
| F-06 | JWT verification accepts any HMAC algorithm | Medium | Confirmed | open | 5.9 |
| F-07 | A revoked device keeps a working access token | Medium | Confirmed | open | 5.4 |
| F-08 | A JWT without an `exp` claim is accepted | Medium | Confirmed | open | 6.5 |
| F-09 | The database role is a PostgreSQL superuser | Medium | Confirmed | open | 6.8 |
| F-10 | The terminal child inherits the server's full environment | Medium | Confirmed | open | 6.3 |
| F-11 | Two critical advisories in the JWT verification chain | Medium | Confirmed | open | 5.9 |
| F-12 | Unauthenticated crash-report injection into the owner's console | Medium | Confirmed | open | 4.3 |
| F-13 | An untrusted device receives full host telemetry | Medium | Confirmed | open | 4.0 |
| F-14 | The release build is signed with the debug key | Medium | Confirmed | open | 6.2 |
| F-15 | The Android client has no tests at all | Medium | Confirmed | open | 5.0 |
| F-16 | `NoNewPrivileges` blocks `sudo` (effective, but load-bearing) | Low | Confirmed | open | 3.7 |
| F-17 | No resource limits on terminal sessions | Low | Likely | open | 4.3 |
| F-18 | `ws` used but not declared as a dependency | Low | Confirmed | open | 2.1 |
| F-19 | The project is not in version control | Low | Confirmed | open | 3.3 |
| F-20 | There is no CI | Low | Confirmed | open | 3.1 |
| F-21 | `xterm.js` vendored without provenance | Low | Confirmed | open | 2.4 |
| F-22 | Dead tunnel endpoint; unauthenticated discovery document | Low | Confirmed | open | 3.7 |
| F-23 | Unlinked crash reports retained indefinitely | Info | Confirmed | open | — |
| F-24 | Device labels are client-controlled | Info | Confirmed | open | — |
| F-25 | Empty `CORS_ORIGINS` on a publicly reachable API | Info | Confirmed | open | — |
| F-26 | Owner email in plaintext in the audit log | Info | Confirmed | open | — |

**CVSS 4.0 notes.** Scores are the base score for the stated vector, with the *attacker's* prerequisite stated in the finding. F-02 scores highest because the attack path is short (one authenticated request) and the outcome is credential theft that escalates. F-01 is scored on the confidentiality/integrity impact of an unverified client, not on the number of unwired classes. F-04's score assumes the `ALLOWED_EMAILS`-empty condition, which is *not* the current state — the current value is set, so the live risk is low and the finding is about the fail-open default.
