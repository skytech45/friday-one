# FRIDAY One — Completed Work

**Last updated:** 2026-10-25
**Scope:** security remediation, P0 and P1 batches
**State:** 15 commits, 3 tags, working tree clean, all suites green

This file records what has actually been **built, executed and verified**.
Anything not listed here is still open — see [`todo.md`](todo.md).

---

## Verification at HEAD

Every number below comes from a real run, not an estimate.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **clean**, 0 errors |
| `npx tsx --test test/*.test.ts` | **20/20** pass (2 suites) |
| `audit/audit-e2e.mjs` | **71/71** checks pass |
| `audit/audit-f09.mjs` | **16/16** checks pass |
| `audit/audit-r02.mjs` | **5/5** pass |
| `audit/audit-r07.mjs` | **5/5** pass |
| `audit/audit-r09.mjs` | **7/7** pass |

---

## Commits

| Commit | Tag | Scope |
|---|---|---|
| `789777d` | `audit-p0-20261023` | Initial import + P0 security fixes |
| `3669d64` | — | JWT hardening, DB error-disclosure fix |
| `0a497fc` | `audit-p1-20261024` | Client-IP spoofing, immediate revocation, harness fixes |
| `87d5e37` | `audit-p1b-20261024` | Secrets out of the process environment |
| `1fd01a0` | — | Audit status recorded in the report set |
| `2bb194b` | — | Least-privilege database role (F-09) |
| `b16d755` | — | `/system` telemetry gated on device trust (F-13) |
| `60e5b1f` | — | `@fastify/jwt` 10.2.5 / `fast-jwt` 6.3.5, `zod` 4.6.7 (F-11 remainder) |
| `5dfdb00` | — | Unlinked crash reports hidden from the console, writes sanitised (F-12) |
| `a80cdf0` | — | Phase 0 baseline audit for the upgrade plan |
| `55afa21` | — | Pre-1 batch: deployment restored, off-host backups (RR-09), CI (F-20) |

---

## Findings batch 4 — F-14, F-15, F-17, F-21, F-24/F-25/F-26 (2026-10-25)

### F-14 · Release APK signed with the debug key — **fixed**

- A dedicated release keystore was generated **on the deployment host, outside
  the repo**: `~/.android-keys/friday-release.jks` (RSA-4096, 10 000-day
  validity, alias `friday`), with `key.properties` (0600) beside it. Gradle
  loads it and signs `release` builds with it; a cold checkout without the
  keystore still builds by falling back to the debug key (so CI stays green),
  and `.gitignore` covers `*.jks`.
- **Verified:** `FRIDAY-One-v0.7-release.apk` built from HEAD;
  `apksigner verify --print-certs` shows `CN=FRIDAY One Release, O=knistudio` —
  not the debug digest. The owner must back the keystore up off-host.

### F-15 · Android had no tests — **partially fixed (JVM layer)**

- New `android/app/src/test/` suite (pure JVM, no emulator): **22 tests**
  across three classes.
  - `CertificatePinningTest` — loopback exemption (incl. `[::1]`, casing, and
    the `127.0.0.1.evil.example` trap) and host extraction (scheme/port/path).
  - `TerminalUrlTest` — `jsString` escaping (`\`, `'`, `\n`, and the
    break-out-of-literal injection shape) and `wsUrlFor` scheme upgrade.
  - `JwtExpiryTest` — `isJwtExpiring` boundaries (skew window, no-`exp`,
    garbage tokens fail safe).
- Small testability refactors, behaviour-preserving: `isJwtExpiring` moved to a
  top-level function taking `nowSeconds` (was a Context-bound private using
  `android.util.Base64`; now `java.util.Base64`), `jsString`/`wsUrlFor`/
  `extractHost` made `internal`.
- **Verified:** `gradle :app:testReleaseUnitTest` — BUILD SUCCESSFUL. Still
  open: instrumented tests (biometric gate, WebView origin policy) need a
  device/emulator.

### F-17 · Terminal sessions were unbounded — **fixed**

- Server-wide cap of **5 concurrent terminals**; the 6th is refused with a
  dedicated close code `4529`.
- **Backpressure:** when the WebSocket send buffer exceeds 4 MB, the child's
  output streams pause until the buffer drains under 1 MB — `cat bigfile` can
  no longer buffer unbounded memory in the server.
- **Idle timeout:** a session with no client input for 30 minutes is killed.
- The session counter and idle timer are now released on the child-exit path
  too (previously only the socket-close path cleaned up).
- systemd: `MemoryMax=2G`, `TasksMax=256` on the API unit — terminal children
  share the service cgroup, so the whole tree is bounded.
- **Verified** (e2e §9a, now **74/74**): 5 open, 6th refused with 4529, and a
  fresh terminal opens after the slots free (no counter leak).

### F-21 · Vendored xterm.js without provenance — **fixed (as far as honestly possible)**

- `assets/terminal/THIRD-PARTY.md` records upstream, licence, and SHA-256 for
  every vendored file. **Recorded honestly: the exact upstream versions cannot
  be identified from the minified bundles** — the file says so and directs the
  next terminal change to re-vendor from a pinned tag.
- The dangling `//# sourceMappingURL=…` comments (the `.map` files were never
  vendored) are stripped.
- `scripts/check-vendor-hashes.sh` asserts the hashes; wired into
  `scripts/ci.sh` and the CI workflow.

### F-24 / F-25 / F-26 · Small informational findings — **fixed**

- F-24: device `name`/`platform`/`app_version` are sanitised on write (control
  characters stripped, trimmed) and documented as client-supplied labels that
  nothing authorises off.
- F-25: the server **refuses to boot** with `CORS_ORIGINS=*`.
- F-26: the owner's email is no longer duplicated into `audit_log.detail` on
  register/login-locked (the row's `user_id` identifies the account;
  `register_rejected` keeps the attempted address deliberately — there is no
  user id for a rejected attempt), and `seed-owner.ts` no longer hardcodes a
  personal display name.


---

## Findings closed

21 findings fixed, 1 partially fixed (F-15: JVM tests only — instrumented tests
need a device). Each entry names the evidence.

### F-02 · `FS_ROOTS` exposed the whole home directory — **fixed**

The path jail was already correct; the configured root was not.
- `server/.env`: `FS_ROOTS` narrowed from `/home/ubuntu` to `/home/ubuntu/friday-one/storage`.
- `server/src/routes/files.ts`: `safePath()` now also denies credential paths that
  sit *inside* a root — `.ssh`, `.aws`, `.gnupg`, `.hermes`, `.kube`, `.docker`,
  `.config`, `.local/share/keyrings` as path segments, and
  `id_rsa`, `id_ed25519`, `.env`, `*.pem`, `*.key`, `credentials` as basenames.
- **Verified:** `test/secretdeny.test.ts` imports the real `safePath` and asserts
  5 cases (2 allow, 3 deny). End-to-end: `.ssh/authorized_keys`, `.env`, `id_rsa`
  and `server.pem` each return **403** even though they are inside the root.

### F-03 · Access token written to the server log — **fixed**

- `server/src/index.ts`: a `req` serializer redacts `?token=…` before logging.
- **Verified:** a real WebSocket connection with a live token; the token value is
  absent from the captured server log, and the redacted marker is present.

### F-04 · Registration failed open — **fixed**

- `server/src/routes/auth.ts`: an empty `ALLOWED_EMAILS` now returns **503
  `registration_not_configured`** and writes an audit row. It no longer skips the
  check and hands out a trusted device.
- **Verified** (`audit/audit-r02.mjs`, 5/5): 503 status, no access token, no
  refresh token, `trusted !== true`, and the attacker account cannot log in
  afterwards (401).

### F-05 · Rate-limit buckets were keyed on a spoofable header — **fixed**

- `server/src/clientIp.ts` (new): resolves the client IP from `CF-Connecting-IP`,
  which the Cloudflare edge sets and overwrites, and **never** from
  `X-Forwarded-For`, which the client controls.
- `server/src/index.ts`: `trustProxy` narrowed from `true` to `"127.0.0.1"`, and
  the rate limiter now buckets on the resolved IP via an explicit `keyGenerator`.
- `server/src/routes/auth.ts` and `loginGuard.ts` use the shared resolver.
- **Verified** (`audit/audit-r07.mjs`, 5/5): rotating `X-Forwarded-For` no longer
  mints fresh buckets (`200,200,200,200,429,429,429,429,429,429`), and the
  per-account lockout engages on attempt 3 despite rotating IPs and headers.
- **Documented limitation:** a *local* process can still forge `CF-Connecting-IP`,
  because the API is on loopback. That is not an escalation — a local process runs
  as `ubuntu` and can read `server/.env` directly. The real brute-force guarantee
  is the per-account lockout in Postgres, which no header can influence.

### F-06 / F-08 · JWT verification too permissive — **fixed**

- `server/src/tokenClaims.ts` (new): `assertTokenClaims()` requires a plain-object
  payload, a numeric `exp`, a non-empty `sub`, and UUID-shaped `sub`/`did`;
  `assertNoCritHeader()` rejects any `crit` JOSE extension (fast-jwt 5.x has no
  `crit` handling at all).
- `server/src/index.ts`: algorithms pinned to `["HS256"]`; `decode.complete`
  enabled so the JOSE header is available for the `crit` check.
- Wired into all three auth paths: `authenticate`, `authenticateTrusted`, and the
  WebSocket handshake.
- **Verified:** HS384 and HS512 tokens signed with the real secret → 401;
  a correctly signed token with no `exp` → 401; an array payload → 401;
  a `crit` header → 401; a non-UUID `sub` → 401 (not the previous 500); a valid
  HS256 token with `exp` still works.

### F-07 · Revocation was not immediate — **fixed**

- `server/src/revocation.ts` (new): a short-lived in-memory denylist keyed on
  device id, living exactly as long as an access token (15m). `revokeKey()` is
  called on device revoke and on logout; `isRevoked()` is checked in
  `authenticate`, `authenticateTrusted` and the terminal handshake.
- **Verified:** access token works before revocation (200), then returns **401** on
  `/system` and `/fs/list` immediately after; the WebSocket closes **4403**.
- **Documented limitation:** the denylist is per-process, so a restart clears it.
  The Postgres session rows stay revoked, so refresh tokens and the WebSocket
  remain dead across a restart.

### F-10 · Terminal child inherited the server's secrets — **fixed**

- `server/src/config.ts` (new): captures configuration into a typed object, then
  **deletes** `DATABASE_URL`, `JWT_SECRET`, `FINGERPRINT_PEPPER` and
  `FRIDAY_OWNER_PASSWORD` from `process.env`. Exposes `childEnv()`, an explicit
  allowlist for spawned children.
- `server/src/routes/terminal.ts`: uses `childEnv()` instead of `...process.env`.
  The child's `HOME` is now `TERMINAL_CWD` (new variable), not the owner's home.
- `db.ts`, `security.ts`, `index.ts`, `loginGuard.ts`, `auth.ts`, `files.ts` read
  from `config` rather than the ambient environment.
- `seed-owner.ts`: reads the owner credential captured *before* the scrub, so the
  documented password-recovery path still works.
- **Verified** (`audit/audit-r09.mjs`, 7/7), measured **from inside a real
  terminal**: 15 environment variables, none of the three secrets present,
  `HOME` redirected, `uid=1001`.
- **Documented limitation:** `HOME` redirection is **not** a security boundary
  while the terminal runs as the owner's uid — an absolute path into
  `/home/ubuntu` is still readable, and the harness records that honestly
  (`READABLE`). A dedicated OS user (R-10) is the real fix and remains open.

### F-09 · The application ran as a PostgreSQL superuser — **fixed**

- New **`friday_app`** role on the live database: `CONNECT` + `USAGE` on schema
  `public` + `SELECT/INSERT/UPDATE/DELETE` on all tables + `USAGE/SELECT` on
  sequences. No `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or
  `BYPASSRLS`. `ALTER DEFAULT PRIVILEGES FOR ROLE friday` covers tables and
  sequences the bootstrap role creates in the future.
- `server/.env`: `DATABASE_URL` now authenticates as `friday_app`. The bootstrap
  URL moved to **`MIGRATE_DATABASE_URL`**, which only `migrate.ts` reads — it runs
  as a separate process before the server starts and exits, so the long-running
  server never holds the superuser credential.
- `server/src/migrate.ts`: builds its own single-connection pool from
  `MIGRATE_DATABASE_URL` (falls back to `DATABASE_URL` so the test harnesses keep
  working unchanged). `MIGRATE_DATABASE_URL` was added to the `config.ts` scrub
  list so it is deleted from the server process's environment.
- `infra/setup-app-role.sh` (new): idempotent role creation/rotation with the
  grants above, so the setup is reproducible on a fresh host.
- **Verified** (`audit/audit-f09.mjs`, 16/16, against the live `.env`): the app
  role reports `rolsuper/rolcreatedb/rolcreaterole/rolreplication/rolbypassrls`
  all false; a real `CREATE DATABASE` statement is refused; no `CREATE` privilege
  on the database or schema `public`; DML present on all six app tables; and
  `migrate.ts` still runs to completion as the bootstrap role.
- **Full e2e suite re-run on the new wiring:** 59/59 at the time of the commit
  (71/71 after the F-13/F-12 additions below).

### F-13 · An untrusted device received full host telemetry — **fixed**

- `server/src/routes/system.ts`: `/system` now requires
  **`authenticateTrusted`** — hostname, OS build, CPU model, load, mount layout,
  interface names/rates and temperatures are for trusted devices only.
- New minimal **`/system/summary`** (`{ ok, version, uptime_s }`) behind plain
  `authenticate`, so an authenticated untrusted device can still show "server
  reachable" without learning anything about the host.
- `proc.pid` and `proc.rss` **dropped** from the `/system` response — the
  server's own PID and memory footprint are reconnaissance, not telemetry.
- Android `MainActivity.kt`: the Machine tab maps an HTTP 403 to "This device
  isn't trusted — approve it from a trusted device to see machine telemetry"
  instead of a raw `HttpException` message.
- **Verified** in `audit/audit-e2e.mjs` (now 63/63): an untrusted device's token
  gets **403 `device_not_trusted`** on `/system` (body leaks nothing), **200**
  with exactly `ok`/`version`/`uptime_s` on `/system/summary`, 401 on summary
  without a token; and `/system` still returns full telemetry for the trusted
  owner device. The R-08 pre-revocation probe moved to `/system/summary`, since
  the test device there is deliberately untrusted.

### F-11 · `fast-jwt` advisories — **fixed**

The exploitable behaviours were closed at the application layer in the first
remediation batch (algorithms pinned, `crit` rejected, array payloads rejected,
`exp` required). The vulnerable dependency itself is now gone:

- `@fastify/jwt` **9.1.0 → 10.2.5**, pulling `fast-jwt` **5.0.6 → 6.3.5** —
  every critical fast-jwt advisory is closed. The v10 breaking change (claims in
  array format now fail verification) is a no-op here: `assertTokenClaims`
  already rejects array payloads and non-string `sub`/`did`.
- `zod` **3.23 → 4.6.7**, closing the high-severity memory-exhaustion advisory.
  Only code change required: `z.record(z.string(), z.unknown())` in `crash.ts`
  (zod 4 requires an explicit key schema).
- **Verified:** `npm audit --omit=dev` reports **0 vulnerabilities**;
  `tsc --noEmit` clean; 20/20 unit tests; 71/71 e2e checks including the JWT
  variant matrix (HS384/HS512 with the real secret → 401, `crit` header → 401).

### F-12 · Unauthenticated crash reports reached the owner's console — **fixed**

- `GET /crash` no longer serves unlinked reports: the query is `WHERE user_id =
  $1` only. A report with no fingerprint, or one whose fingerprint matches no
  known device, is still stored (it may be a real crash from a broken install)
  but is never handed to the console — previously anyone on the internet could
  inject content into it.
- Writes are sanitised at the boundary: `message` and `stack_trace` have control
  characters stripped (NUL, ANSI/C1 escape sequences) with `\n`/`\t` preserved,
  and are length-capped in the route, not just in the schema. The dedupe
  signature is computed from the sanitised text.
- **Verified** (8 new checks in `audit-e2e.mjs` §13b): an injected
  no-fingerprint report does **not** appear in the owner's `GET /crash`; a
  report carrying the owner's device fingerprint does; a report containing ANSI
  escapes and NULs is stored with them stripped.

### F-18 · `ws` was an undeclared dependency — **fixed**

- `server/package.json`: `ws` pinned to `8.22.0` as a direct dependency; lockfile
  updated.

### F-19 · No version control — **fixed**

- `git init`, a `.gitignore` covering `.env`, `endpoint.json`, build output,
  runtime state and one-off diagnostic probes, an initial commit, and three
  tagged remediation batches. The regression harnesses
  (`audit-e2e.mjs`, `audit-r02.mjs`, `audit-r07.mjs`, `audit-r09.mjs`, `audit/lib/harness.mjs`)
  are tracked.
- **Verified:** `git status --porcelain` is clean; no production secret is staged
  (checked by grepping the staged set for the real DB password and JWT secret).

---

## Pre-1 batch — deployment, backups, CI (2026-10-25)

Recorded because the upgrade plan's Phase 0 (`docs/BASELINE_AUDIT.md`, B-7)
identified them as blocking everything else.

### Deployment restored — **verified live**

- `friday-one-api.service` + `friday-one-tunnel.service` installed, enabled and
  healthy; the API answers through the Cloudflare quick tunnel, **verified from
  an external vantage point** (`GET /health` → `{"ok":true,"version":"0.1.0"}`).
- Three deployment defects found and fixed along the way:
  1. **Stale endpoint pipeline:** the tunnel unit never wrote
     `/tmp/cf-tunnel.log` (no redirect) *and* had `PrivateTmp=true`, so the
     endpoint publisher grepped a file left over from the Oct-23 manual run and
     published a dead URL to the gist. Fix: `tunnel.sh` redirects stderr to
     `logs/cf-tunnel.log`, the unit opens exactly that path via
     `ReadWritePaths` (note: `ProtectSystem=strict` makes `/tmp` read-only, and
     `PrivateTmp` would hide it — the log must live under the repo), and
     `publish-endpoint.sh` reads the same path.
  2. **`gh gist edit -f` is a rename flag, not a content flag** — the publisher
     had never actually been able to update the gist content that way.
  3. **`PORT=8788` in `server/.env`** disagreed with the tunnel target (8787) —
     and a stale process on 8787 had been answering health checks, masking it.
- **`hermes` terminal kind fixed:** the binary lives in `~/.local/bin`, outside
  the terminal child's PATH; the COMMANDS allowlist now uses an absolute path.
- Stray `</content>` artifact lines (a repeat of the incident documented in
  `docs/SHARED.md`) removed from `run-server.sh`, `friday-one-api.service`
  (line 39 was tripping the systemd parser) and two docs files.

### RR-09 · Off-host backups — **mitigated, restore drilled**

- Off-host git remote: private `github.com/skytech45/friday-one`, pushed via a
  write-scoped **deploy key** (only this repo, revocable from GitHub settings).
- Nightly database backup: `scripts/nightly-backup.sh` dumps with
  `pg_dump -Fc` inside the container and pushes to a second private repo
  (`skytech45/friday-one-backups`); every nightly dump is a commit (git history
  = retention), the working tree keeps the last 14.
- `friday-one-backup.timer` runs it daily at 04:35 (Persistent).
- **Restore drill PASSED:** the dump was restored into a scratch database —
  6 tables, 3 users, 3 devices verified — then dropped. This is the tested
  rollback path the risk register demanded.

### F-20 · CI — **local gate live; Actions pending owner billing fix**

- `scripts/ci.sh` runs the full gate: `npm audit --omit=dev`, typecheck,
  20/20 unit, `audit-f09` 16/16, e2e 71/71. Installed as a **versioned
  pre-push hook** (`core.hooksPath=scripts/hooks`) on the deployment host —
  nothing leaves the box without the suite passing.
- `.github/workflows/ci.yml` is committed (audit/typecheck/unit job, e2e +
  F-09 job against a real `postgres:16-alpine`, gitleaks) — GitHub Actions
  refused to start it: **account billing issue** ("payments have failed or
  spending limit needs increasing"). Owner action; the workflow runs on the
  next push once fixed.

---

## Tooling and infrastructure added

### `server/src/config.ts`

Single place configuration is read. Guarantees no secret is read from the ambient
environment after startup, and gives terminal children a minimal environment.

### `server/.env.example`

Documents every variable. There was no example file before, which is how the
fail-open `ALLOWED_EMAILS` default shipped. It states explicitly that
`ALLOWED_EMAILS` must not be empty and `FS_ROOTS` must not be `$HOME`.

### `server/src/env.ts`

Kept Node's precedence — the real environment wins over `.env` — because harnesses,
systemd and one-off `PORT=… npm start` all rely on it. It now also **parses** the
file purely to warn when the environment and the file disagree, so a stale export
cannot change behaviour silently.

### `audit/lib/harness.mjs`

Shared helpers: `spawnGrouped` / `killGroup` (kill the whole process group),
`assertPortFree`, `waitForHealth`.

### Regression harnesses

| File | Covers |
|---|---|
| `audit/audit-e2e.mjs` | 71 end-to-end checks across auth, files, WS, revocation, crash scope |
| `audit/audit-f09.mjs` | 16 checks: the app role is least-privilege and migrations still work |
| `audit/audit-r02.mjs` | Fail-closed registration (F-04) |
| `audit/audit-r07.mjs` | Client-IP spoofing and the account lockout (F-05) |
| `audit/audit-r09.mjs` | Terminal environment isolation (F-10) |
| `audit/audit-algtest.mjs` | JWT acceptance matrix (F-06/F-08/F-11) |

All are self-cleaning: they create a dedicated `friday_audit*` role and database,
boot the real server on their own port, then drop everything.

---

## Mistakes made during remediation, and how they were fixed

Recorded because each one produced a false result at the time.

**A stale server made the first test results fiction.**
The harnesses spawned the server via `npx tsx`, which is a wrapper.
`child.kill()` signalled the wrapper and the real server kept running — still
holding the port *and* the database. The next run then talked to the old process
with the old JWT secret, the old schema and the old code, and produced several
entirely bogus results. Fixed by spawning detached and killing the whole process
group, plus a port guard that aborts instead of silently testing against a stale
instance.

**A "fix" to the env loader broke every harness.**
Making `.env` override the real environment seemed safer, but it overrode the
`PORT` each harness sets, so servers tried to bind the production port. Reverted
to environment-wins, with a loud conflict warning. This also surfaced a genuine
stale `TERMINAL_CWD` that had been quietly redirecting the terminal into the
owner's home.

**A security test was passing vacuously.**
The R-09 harness waited a fixed 1.4 s and read whatever arrived. The PTY echoes
input, so my sentinel appeared in the *echo of the command* before any output —
and slicing at the first occurrence truncated everything. "The secret is absent"
was true of an empty string. Fixed with `stty -echo` and a shell-computed marker
(`$((6*7))` → `42`) so the literal only appears in real output, plus an explicit
assertion that the capture is non-empty.

**A test asserted the wrong control was working.**
Both the account lockout and the rate limiter answer `429`. The first version
could not tell them apart. Fixed by checking the response body
(`error: "too_many_attempts"`) and by running the rate-limit burst last, so it
does not exhaust the bucket the earlier checks depend on.

**A fixture path tripped my own denylist.**
The sandbox `TMPDIR` is `~/.hermes/cache/scratch`, and `.hermes` is a denied
segment, so every fixture inside it was correctly refused — for the wrong reason.
Fixtures now live under `/tmp` with `realpath` applied so the configured root and
the resolved path agree.

---

## Environment restored

Nothing is left running.

- No listener on `8788` or `8790–8799`.
- No `friday-one` server processes.
- No `friday_audit*` databases or roles remain.
- Temporary fixtures and the extracted database password file were removed.
- `/tmp/friday-console.service` was **left untouched** — it belongs to the
  separate `~/friday-console` project and predates this work.
