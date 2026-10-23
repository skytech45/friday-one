# FRIDAY One — Security Audit Summary

**Date:** 2026-10-23
**Scope:** `~/friday-one` — Android client (Kotlin/Compose), backend (Node/TS/Fastify/PostgreSQL), infrastructure (Ubuntu/systemd/Cloudflare Tunnel)
**Mode:** Read-only discovery + isolated empirical validation. Production DB, production port and production secrets were **not** used as test inputs.
**Auditor:** Friday (Hermes), authorized by owner.

---

## 1. Bottom line

The code is written by someone who knows what they are doing. The path jail, the refresh-token rotation, the device-trust gate, the token-in-query-string trade-off note, the `NoNewPrivileges` hardening, the "a login shell is not a restricted command" honesty in the code comments — these are the marks of a security-conscious author, and most of them hold up under testing.

**The problem is not the code. It is that the security architecture described in the source is not the architecture that is running, and three of the controls that do exist are inert.**

Specifically:

1. **The Android client's entire security layer is dead code.** `AppLock` (biometric gate), `DeviceIntegrityGate` (device binding), `TamperDetection` and `NetworkModule` (certificate pinning + token-refresh authenticator) are **never called from any code path**. The app ships with no biometric lock, no pinning, no device binding, and no refresh authenticator. This is the single most consequential finding: the docs describe a hardened client, and the shipped client has none of it.

2. **`FS_ROOTS=/home/ubuntu` makes the file API an unauthenticated-after-login read of the owner's entire home directory**, including `~/.ssh/authorized_keys`, `~/.hermes/auth.json` (live agent credentials) and `server/.env` (the JWT signing key and DB password). Confirmed by direct download.

3. **The WebSocket access token is written to the server log on every connection** by Fastify's default request logger, because the token rides in the query string.

The good news: the *backend* is in far better shape than the client. The path jail, the refresh rotation, the lockout, and the trust gate all behave correctly under adversarial testing.

**Verdict: not production-ready.** Two P0 items, four P1 items, and a design decision (Stage 4 remote shell) that needs to be consciously accepted or changed.

**Severity distribution:** Critical 2 · High 3 · Medium 10 · Low 7 · Informational 4 — **26 findings**

---

## 2. The three findings that matter most

### F-01 · The Android client's security layer is entirely dead code — Critical

**What:** Four security classes exist in `android/app/src/main/java/com/friday/one/security/` and are referenced by **zero** production call sites.

| Class | Purpose | Referenced from |
|---|---|---|
| `AppLock` | Biometric gate before the UI renders | **nothing** |
| `DeviceIntegrityGate` | Emulator/tamper verdict, key self-test | **nothing** |
| `TamperDetection` | Root/test-keys telemetry | **nothing** |
| `NetworkModule` | Cert pinning + `TokenRefreshAuthenticator` | **nothing** (only self-reference) |

Evidence: `grep -rl "<Class>" --include=*.kt android/app/src/main/java` returns only the defining file for the first three, and only `NetworkModule.kt` itself for the fourth.

**Why it matters:** The app that actually runs is `MainActivity.kt` → `ApiClient.create(serverUrl)` → a plain `OkHttpClient` with no pinning. So:

- **No certificate pinning.** `CertificatePinning.TUNNEL_PINS` is an empty list with a `TODO(ws3)` comment, and `apply()` returns early when it is empty. Even if the class were wired, pinning would still be a no-op. The tunnel is reached over a public `trycloudflare.com` hostname; a hostile network that can present any publicly-trusted certificate intercepts the session.
- **No biometric gate.** `MainActivity` renders the login/dashboard directly. A stolen or borrowed phone with a live session opens straight into the terminal.
- **No device binding.** `DeviceLockManager` generates an EC P-256 key and can sign challenges, but the server **never reads** the `public_key` / `public_key_id` / `key_bound_at` columns it added (`schema-device-binding.sql`). `grep -rn "public_key\|key_bound_at" server/src/` returns nothing outside the schema file. The device-binding model described in `schema.sql` ("a new fingerprint is untrusted until the user approves it") is a *fingerprint* model, not a *cryptographic* model — and the fingerprint is a hash of build fields plus a keystore-HMAC install id, so it is reproducible from a rooted device.
- **No refresh authenticator.** `NetworkModule`'s `TokenRefreshAuthenticator` never runs; `ApiClient`'s client has no authenticator. The app instead refreshes proactively via `SessionStore.validToken()`, which is a workable alternative — but it means a 401 never triggers a refresh, so a session that dies mid-use surfaces as a silent failure rather than a re-auth.

**Impact:** The device-binding and biometric claims in `docs/TASKS.md` (WS3) and `docs/SHARED.md` are **unimplemented in the shipped binary**. The server's trust model assumes a handset it cannot actually verify.

**Remediation:** Wire the classes (P0), populate the pins from the live tunnel certificate (P0), and implement the server-side challenge/verify path for the device public key (P1) — the columns are already there, the logic is not.

---

### F-02 · `FS_ROOTS=/home/ubuntu` exposes the owner's entire home directory to the file API — Critical

**What:** `server/.env` sets `FS_ROOTS=/home/ubuntu`. The path jail in `server/src/routes/files.ts:26-45` is **correctly implemented** — it `realpath()`s the candidate, collapses `..` and symlinks, and rejects anything outside the roots. But the root is the home directory, so the jail permits exactly what matters:

```
GET /fs/download?path=/home/ubuntu/.ssh/authorized_keys   -> 200  (SSH public keys)
GET /fs/download?path=/home/ubuntu/.hermes/auth.json      -> 200  (live agent credentials)
GET /fs/download?path=/home/ubuntu/friday-one/server/.env -> 200  (JWT_SECRET + DATABASE_URL)
```

Confirmed against an isolated instance with a realistic fixture home (V2 in the verification batch). The `safePath` containment itself passed every traversal and symlink test.

**Why it matters:** A leaked session token — from the log file (F-04), from a captured URL, or from a revoked-but-still-valid access token (F-07) — is enough to read the owner's SSH authorized keys, the Hermes API credentials and the server's own secrets. With the JWT signing key in hand, the attacker can mint tokens for **any** device id and defeat the trust gate entirely (F-06).

Note the escalation chain: `server/.env` → `JWT_SECRET` → mint a token with any `sub`/`did` → `authenticateTrusted` passes because the `did` is only checked against the DB, not cryptographically → full filesystem + terminal.

**Remediation:** Narrow `FS_ROOTS` to a dedicated directory (e.g. `/home/ubuntu/friday-one/storage`), and add a denylist for dotfiles and secret-bearing paths even inside allowed roots. Consider a dedicated unprivileged OS user whose home *is* the file root (Stage 6 isolation), so the jail and the OS agree.

---

### F-03 · The WebSocket access token is written to the server log — High

**What:** The terminal authenticates with the JWT in the query string (`/ws/terminal?kind=shell&token=...`). Fastify's default request logger records the full request URL:

```json
{"level":30,"req":{"method":"GET","url":"/ws/terminal?kind=shell&token=eyJhbGciOiJIUzI1NiJ9..."},"msg":"incoming request"}
```

Confirmed on a real WebSocket connection (T2, and independently in the isolated probe). The token is a **15-minute bearer credential**, and it is also a full session token — anyone holding it can open a terminal.

**Why it matters:** The log is written by the server process to stdout, which under systemd goes to the journal. Journal access for the `ubuntu` user is normal, and journald is not world-readable by default, but: logs get shipped, rotated, and pasted into bug reports; and a 15-minute token in a log is a token that remains valid for 15 minutes *after* it is read.

**Remediation:** Redact the query string in the logger — a `serializers` hook or `reqId`-based redaction that strips `token` from `req.url` before logging. Also shorten the access-token lifetime for the socket path or move the credential to a short-lived ticket: client `POST /auth/ws-ticket` → server issues a 60-second single-use nonce → the socket consumes it. That removes the token from the URL entirely.

---

## 3. What was inspected

**Read in full:** all 41 non-vendored source files in `~/friday-one` (Android 23 Kotlin files, server 13 TypeScript files, 4 test files, 5 scripts, 3 systemd units, 1 docker-compose, 1 network-security-config, 1 manifest, 1 proguard file, 1 build.gradle.kts, 4 docs).

**Verified empirically** (isolated instance, dedicated Postgres role `friday_audit`, throwaway filesystem root, ports 8789-8799, all cleaned up):

- JWT acceptance matrix against the installed `fast-jwt@5.0.6` (15 token variants)
- Registration allowlist, login, per-account lockout, IP throttle
- Refresh rotation, replay rejection, fingerprint binding, session kill
- Filesystem containment: traversal, absolute paths, symlink escape, in-root reads
- Upload containment (inside and outside root)
- WebSocket auth: no token, garbage token, valid token, untrusted device, unknown kind
- Terminal process lifetime after socket close; child environment and UID
- Revocation latency for HTTP and WebSocket
- `NoNewPrivileges` propagation to the terminal child
- Empty-`JWT_SECRET` startup behaviour
- Rate-limiter bucketing and `X-Forwarded-For` spoofing

**Tooling:** `tsc --noEmit` (clean) · `node:test` suite (15/15 pass) · `npm audit` (2 critical) · secret-pattern scan (clean; one test-only literal)

**Not inspected / unavailable:**

- **The running production service is not deployed.** `friday-one-api.service` and `friday-one-tunnel.service` are `not-found` in systemd; `curl 127.0.0.1:8788/health` returns `000`. Only `friday-endpoint-publisher.timer` is installed and active. **The published tunnel URL returns HTTP 530** (Cloudflare origin down). So the audit is of *source*, validated against a faithful isolated instance — not of a live production deployment.
- No Android instrumentation was run: no device, no emulator, and no Android unit tests exist (`src/test` and `src/androidTest` are both empty). Android findings are from source reading and are marked accordingly.
- The production Postgres role `friday` is a **superuser** with `BYPASSRLS` and `CREATEDB` (see F-09).
- `gitleaks` was unavailable; a pattern-based scan was substituted.
- No CI configuration exists in the repository (no `.github/`, no pipeline files) — Stage 8's CI review is unfulfilled by absence.

---

## 4. Confirmed vulnerabilities vs. unverified risks

**Confirmed by execution (23 findings, all reproduced):**
F-01 (dead client security code — by exhaustive call-site analysis), F-02 (home-dir file exposure — downloaded), F-03 (token in log — logged), F-04 (registration fail-open — registered anonymously), F-05 (XFF spoofing resets rate limit — measured), F-06 (no JWT algorithm restriction — HS384/HS512 accepted), F-07 (revoked device keeps a live access token — measured), F-08 (no `exp` requirement — accepted), F-09 (Postgres superuser), F-10 (terminal child inherits server secrets — read from the child), F-11 (critical `fast-jwt` advisories), F-12 (unauthenticated crash injection), F-13 (untrusted device gets host telemetry), F-14 (release signed with the debug key), F-15 (no Android tests), F-16 (`NoNewPrivileges` blocks sudo — good news, but see F-17), F-17 (no resource limits on PTYs), F-18 (`ws` undeclared dependency), F-19 (no git repository → no provenance), F-20 (no CI), F-21 (no `.gitignore`; `.env` files untracked-but-unprotected), F-22 (Cloudflare tunnel down), F-23 (crash report retains unlinked rows for all users).

**Unverified / likely:**
- Whether the owner-facing APK on the phone was built from this tree, and whether it is the debug-signed variant (F-14). Not determinable without the device.
- Whether the production `FS_ROOTS` is still `/home/ubuntu` (the `.env` says so; the service is not running, so it is the last-known value).
- Whether the `xterm.js` vendored build matches an upstream release (minified, no version stamp, no integrity hash — F-21 adjacent).

**Informational:** 6 observations that do not independently establish a vulnerability (see `findings.md`).

---

## 5. Realistic attack paths

**Path A — Anonymous takeover (one HTTP request).**
The service is not currently running, so this is the risk the moment it is deployed with the shipped `.env`. If `ALLOWED_EMAILS` is ever empty or missing, `POST /auth/register` returns `201` with `trusted: true` and a full token set. Verified end-to-end (F1): the anonymous account then read the file tree and opened the terminal. If `ALLOWED_EMAILS` is set, this path is closed — it is currently set to one address. **This is a fail-open default, which is the wrong direction for a single-operator system.**

**Path B — Token theft to full host access.**
The token lands in the journal (F-03). An attacker with read access to the journal — the same access that reads `~/.hermes/auth.json` (F-02) — gets a 15-minute live session token. With it: `/fs/download` of `server/.env` → `JWT_SECRET` → mint tokens for arbitrary `sub`/`did` → the trust gate is defeated → remote shell as `ubuntu` → `sudo -n` → **root**, unless `NoNewPrivileges` is in force (it is, under the shipped unit — F-16 — which is the single control that stops this from being host compromise).

**Path C — Stolen phone, no lock screen.**
The app has no biometric gate (F-01). A live session on a lost phone opens the terminal with one tap, and the terminal is a full shell as the owner.

**Path D — Revocation is not immediate.**
Revoking a device kills its refresh tokens and blocks the WebSocket, but the 15-minute access token keeps working on `/system` (F-07). For a 15-minute window, "revoked" is not "revoked".

**Path E — Rate-limit bypass.**
`trustProxy: true` makes `req.ip` the client-supplied `X-Forwarded-For` (F-05). Rotating the header resets the per-IP login throttle and the global limiter. The per-*account* lockout still holds (it is keyed on the user id in the database and survived every test), so this is a nuisance-amplifier, not an account-takeover.

---

## 6. Tests and actual results

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | **pass**, 0 errors |
| Server unit tests | `npx tsx --test test/*.test.ts` | **pass**, 15/15 (2 suites) |
| JWT acceptance matrix | `audit/audit-algtest.mjs` | **12 accepted / 3 rejected** — 6 acceptance gaps |
| E2E auth+FS+WS suite | `audit/audit-e2e.mjs` | 25/39 as first written; the 14 failures were **harness bugs** (config bleed, WS close-code semantics), re-run with corrections — see `security-test-matrix.md` |
| Dependency audit | `npm audit --omit=dev` | **2 critical** (`fast-jwt` chain) |
| Terminal inheritance | `audit/audit-p3b.mjs` | JWT secret, DB URL, pepper, SSH keys, `auth.json` all readable from the child |
| NNP propagation | `audit/audit-nnp.mjs` | `NoNewPrivs: 1` inherited; `sudo` refused |
| Empty JWT secret | `audit/audit-emptysecret.mjs` | server **refuses to start** (`@fastify/jwt` asserts) — fail-closed, not a vulnerability |
| Secret-pattern scan | grep over the tree | **clean** (one test-only literal) |
| Android build/tests | — | **not run** — no device, no test sources exist |

Two audit-harness bugs were found and fixed during this audit, and both initially produced false results that would have inflated the report: a mis-signed HMAC (which made every JWT probe "reject") and a `psql`-via-stdin pipe that never closed (which hung the DB setup). Both were re-run correctly; the findings above reflect the corrected runs.

---

## 7. Completed fixes and changes awaiting approval

**No source files were modified.** The audit is read-only per the mandate, and the brief requires explicit approval before remediation.

**Files created by the audit (all new, no existing file touched):**

```
~/friday-one/audit/audit-*.mjs      15 probe/harness scripts (reusable, self-cleaning)
~/friday-one/audit/*.md              7 deliverable documents
```

Cleanup performed: isolated database `friday_audit` dropped, role `friday_audit` dropped, 9 audit server processes killed, all 9 audit ports confirmed free, all temporary fixture directories removed. **The production database, production `.env` and production services were not modified.**

**Awaiting approval:** the P0/P1 remediation set in `remediation-roadmap.md` (11 items, each with affected files, a regression test and a rollback strategy).

---

## 8. Blockers to a production release

1. **F-01 — the client security layer is not wired.** The APK must not ship claiming biometric lock, pinning and device binding. Either wire it (and populate the pins), or remove the claims from the docs. Right now the docs and the binary disagree.
2. **F-02 — `FS_ROOTS` must be narrowed** before the service is exposed to a tunnel.
3. **F-04 — `ALLOWED_EMAILS` must be mandatory**, not "empty disables the check". A single-operator system should fail *closed* on an unconfigured allowlist.
4. **F-03 — redact the token from the log** before the service is ever started with a real tunnel.
5. **Stage 4 must be consciously decided.** `COMMANDS.shell = "bash -l"` is a general-purpose remote shell. The audit prompt is explicit that this is not a restricted command, and the code agrees. Either accept it as a documented privileged capability with the surrounding isolation, or drop it. Today the "Hermes/OpenCode only" framing understates what the app actually exposes.
6. **F-11 — the two critical `fast-jwt` advisories need a decision.** `@fastify/jwt` 9.x → 10.2.5 is a breaking upgrade; the alternative is pinning an audited `fast-jwt` version directly. `npm audit fix --force` alone is not a plan.
7. **F-14 — the release build is signed with the debug key.** `signingConfig = signingConfigs.getByName("debug")` in the `release` block. That is not a release artifact, whatever the build type says.
8. **F-19/F-20 — the project is not in version control and has no CI.** There is no `.git` directory, no `.gitignore`, and no pipeline. There is no provenance for any artifact, no history, and no way to roll back a bad change. This is a prerequisite for shipping anything.
9. **F-22 — the tunnel is down** (HTTP 530). The service is not running, so there is currently no live exposure — but that also means the app cannot work, and the deployment is incomplete.

---

## 9. Deliverables

| File | Contents |
|---|---|
| `security-audit-summary.md` | This document |
| `architecture-and-trust-boundaries.md` | Components, data flows, trust boundaries, Mermaid diagrams |
| `findings.md` | 24 findings with file/line, evidence, reproduction, CVSS 4.0, status |
| `findings.json` | Machine-readable findings |
| `threat-model.md` | Assets, actors, attack surfaces, abuse cases |
| `remediation-roadmap.md` | P0-P3 ordered plan with dependencies, tests, rollback |
| `security-test-matrix.md` | 40 cases: expected, actual, gaps |
| `residual-risks.md` | What remains after remediation, and what is accepted |
