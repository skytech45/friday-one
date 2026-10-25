# FRIDAY One — Completed Work

**Last updated:** 2026-10-25
**Scope:** security remediation, P0 and P1 batches
**State:** 7 commits, 3 tags, working tree clean, all suites green

This file records what has actually been **built, executed and verified**.
Anything not listed here is still open — see [`todo.md`](todo.md).

---

## Verification at HEAD

Every number below comes from a real run, not an estimate.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **clean**, 0 errors |
| `npx tsx --test test/*.test.ts` | **20/20** pass (2 suites) |
| `audit/audit-e2e.mjs` | **63/63** checks pass |
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

---

## Findings closed

12 findings fixed, 1 partially fixed. Each entry names the evidence.

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
  (63/63 after the F-13 additions below).

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


- The **exploitable behaviours** are closed: algorithms pinned, `crit` rejected,
  array payloads rejected, `exp` required.
- The **dependency** is still `fast-jwt@5.0.6`; the upgrade to `@fastify/jwt@10.x`
  (or a `fast-jwt` override) is **not done**. Tracked in `todo.md`.

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
| `audit/audit-e2e.mjs` | 63 end-to-end checks across auth, files, WS, revocation |
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
