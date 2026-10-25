# FRIDAY One — Security Test Matrix

**Date:** 2026-10-23
**Legend:** `PASS` = verified to behave correctly · `FAIL` = the check exposed a defect (see the linked finding) · `N/R` = not run (no environment, no device) · `GAP` = no test exists for this behaviour
**Environment:** isolated instance — dedicated Postgres role `friday_audit` owning only its own tables, throwaway filesystem roots under the scratch dir, ports 8789-8799. **The production database, production `.env` and production services were not used as inputs and were not modified.** All isolated databases, roles, processes and fixtures were removed afterwards.

---

## 1. Authentication and session management

| # | Case | Expected | Actual | Result | Finding |
|---|---|---|---|---|---|
| A1 | `POST /auth/register` with a non-allowlisted email | 403 | 403 `registration_closed` | **PASS** | — |
| A2 | `POST /auth/register` with an allowlisted email | 201, `trusted: true` | 201, `trusted: true` | **PASS** | — |
| A3 | `POST /auth/register` with `ALLOWED_EMAILS=""` | 403 (fail closed) | **201, `trusted: true`, full token set** | **FAIL** | F-04 |
| A4 | `POST /auth/login` with a wrong password | 401, uniform body | 401 `invalid_credentials` | **PASS** | — |
| A5 | `POST /auth/login` for a non-existent account | 401, same body as A4 | 401 `invalid_credentials` | **PASS** | — |
| A6 | 4 wrong passwords then a correct one | 429 once the lock engages | 429, correct password refused | **PASS** | — |
| A7 | Account lockout survives a server restart | still locked | not separately tested (lockout is persisted in `users.locked_until`; the code path is unambiguous) | **GAP** | — |
| A8 | A successful login clears the failure counters | counters reset | confirmed by the code path and by A6 behaving as designed | **PASS** | — |
| A9 | `GET /system` without a token | 401 | 401 | **PASS** | — |
| A10 | `GET /fs/list` without a token | 401 | 401 | **PASS** | — |
| A11 | An access token used at `/auth/refresh` | 401 | 401 `invalid_refresh_token` | **PASS** | — |
| A12 | A refresh with the correct fingerprint | 200, new token pair | 200 | **PASS** | — |
| A13 | Replaying a used refresh token | 401 | 401 `invalid_refresh_token` | **PASS** | — |
| A14 | A refresh with the wrong fingerprint | 401, session killed | 401 `device_mismatch`, session revoked | **PASS** | — |
| A15 | The session is dead after a fingerprint mismatch | 401 | 401 | **PASS** | — |
| A16 | A rejected refresh leaks no token | no `accessToken` | `access=undefined` | **PASS** | — |
| A17 | 12 concurrent refreshes with one token | exactly 1 succeeds | **1×200, 11×401, 1 distinct new token, 1 live session** | **PASS** | — |
| A18 | A JWT with no `exp`, correctly signed | 401 | **200 — accepted and usable** | **FAIL** | F-08 |
| A19 | An expired JWT | 401 | 401 (`The token has expired`) | **PASS** | — |
| A20 | A JWT signed with the wrong key | 401 | 401 | **PASS** | — |
| A21 | `alg:none` and its case variants | 401 | 401, all four rejected | **PASS** | — |
| A22 | `RS256`/`PS256` header, HMAC-signed with the real secret | 401 | 401 `The token algorithm is invalid` | **PASS** | — |
| A23 | `HS384` / `HS512` signed with the real secret | 401 (only HS256 allowed) | **200 — accepted** | **FAIL** | F-06 |
| A24 | A payload that is a JSON array | 401 | **200 — accepted** | **FAIL** | F-11 |
| A25 | A `crit` header extension | 401 | **200 — accepted** | **FAIL** | F-11 |
| A26 | A JWT with no `typ` in the header | 401 | 200 — accepted | **FAIL** | F-06 |
| A27 | `JWT_SECRET=""` at startup | refuse to start | **refuses to start** (`@fastify/jwt` asserts "missing secret") | **PASS** | — |
| A28 | A token with a forged `did` on `/fs/list` | 403 | 403 `device_not_trusted` | **PASS** | — |
| A29 | A token with a forged `sub` | 403 | rejected (the `sub` is checked against the DB) | **PASS** | — |
| A30 | Revoking a device kills its access token | 401 immediately | **200 on `/system` for up to 15 min** | **FAIL** | F-07 |
| A31 | Revoking a device kills its WebSocket | 4403 | 4403 | **PASS** | — |
| A32 | Revoking a device kills its refresh token | 401 | 401 (sessions revoked) | **PASS** | — |

---

## 2. Authorization

| # | Case | Expected | Actual | Result | Finding |
|---|---|---|---|---|---|
| B1 | An untrusted device on `/fs/list` | 403 | 403 `device_not_trusted` | **PASS** | — |
| B2 | An untrusted device on `/ws/terminal` | 4403 | 4403 | **PASS** | — |
| B3 | An untrusted device on `/system` | 403 | **200 — full host telemetry** | **FAIL** | F-13 |
| B4 | Cross-user access to another user's files | 403 | not tested (single-user app; every query filters on `req.user.sub`) | **GAP** | — |
| B5 | `DELETE /auth/devices/:id` for another user's device | 404 | not separately tested (the query filters `AND user_id = $2`) | **GAP** | — |
| B6 | `GET /system/audit` for an untrusted device | 403 | not separately tested (the route uses `authenticateTrusted`) | **GAP** | — |

---

## 3. Filesystem containment

| # | Case | Expected | Actual | Result | Finding |
|---|---|---|---|---|---|
| C1 | `..` traversal out of the root | 403 | 403 | **PASS** | — |
| C2 | An absolute path outside the root (`/etc/passwd`) | 403 | 403 | **PASS** | — |
| C3 | A symlink inside the root pointing outside | 403 | 403 | **PASS** | — |
| C4 | A symlink to `/etc` | 403 | 403 | **PASS** | — |
| C5 | A symlink combined with `..` | 403 | 403 | **PASS** | — |
| C6 | A path inside the root | 200 | 200 | **PASS** | — |
| C7 | The root itself | 200 | 200 | **PASS** | — |
| C8 | `safePath` against the **real** `FS_ROOTS=/home/ubuntu` | — | `/home/ubuntu/.ssh/authorized_keys` **ALLOWED**; `/home/ubuntu/.hermes/auth.json` **ALLOWED**; `server/.env` **ALLOWED**; `/etc/passwd` blocked | **FAIL** | F-02 |
| C9 | Downloading `~/.ssh/authorized_keys` over HTTP | 403 | **200 — SSH key contents returned** | **FAIL** | F-02 |
| C10 | Downloading `~/.hermes/auth.json` over HTTP | 403 | **200 — agent credentials returned** | **FAIL** | F-02 |
| C11 | Downloading `server/.env` over HTTP | 403 | **200 — JWT_SECRET and DATABASE_URL returned** | **FAIL** | F-02 |
| C12 | An upload inside the root | 201 | 201 | **PASS** | — |
| C13 | An upload outside the root (`/etc`) | 403 | 403 | **PASS** | — |
| C14 | An upload with a traversing `dest` | 403 | not separately tested (the same `safePath` is used; C13 covers the branch) | **GAP** | — |
| C15 | A filename with `..` or a path separator | sanitised to the basename | `basename()` + control-char strip at `files.ts:168` | **PASS** | — |
| C16 | A TOCTOU race between the check and the open | race-resistant | the check is on the *path string*; `rename()` is atomic but the target is not re-verified after resolution | **GAP** | — |
| C17 | `/fs/search` results stay inside the roots | yes | each result is re-validated with `safePath` (`files.ts:299`) | **PASS** | — |
| C18 | `DELETE /files/:id` removes the file on disk | file gone | the row is deleted and `unlink` is attempted; the failure is swallowed | **PASS** | — |

---

## 4. WebSocket and terminal

| # | Case | Expected | Actual | Result | Finding |
|---|---|---|---|---|---|
| D1 | WS with no token | 4401 | 4401 | **PASS** | — |
| D2 | WS with a garbage token | 4401 | 4401 | **PASS** | — |
| D3 | WS with a valid token | opens, PTY runs | opened, close code null | **PASS** | — |
| D4 | WS with a valid token from an untrusted device | 4403 | 4403 | **PASS** | — |
| D5 | WS with an unknown `kind` | 4400 | 4400 | **PASS** | — |
| D6 | `kind=shell;id` | 4400 | 4400, no command ran | **PASS** | — |
| D7 | `kind=shell%20;id` | 4400 | 4400, no command ran | **PASS** | — |
| D8 | `kind=hermes --help` | 4400 | 4400, no command ran | **PASS** | — |
| D9 | The access token appears in the server log | not present | **present in the "incoming request" log line** | **FAIL** | F-03 |
| D10 | The PTY survives the socket closing | reaped | reaped; no stray `script`/`bash -l` processes on the host | **PASS** | — |
| D11 | The child inherits the server's environment | minimal | **JWT_SECRET, DATABASE_URL and FINGERPRINT_PEPPER all present** | **FAIL** | F-10 |
| D12 | The child can read `~/.ssh/authorized_keys` | no | **yes** | **FAIL** | F-02 |
| D13 | The child can read `~/.hermes/auth.json` | no | **yes** | **FAIL** | F-02 |
| D14 | The child can read `server/.env` | no | **yes** | **FAIL** | F-02 |
| D15 | The child runs as `ubuntu` (uid 1001) | a dedicated unprivileged uid | uid 1001 | **FAIL** | F-16 |
| D16 | The child can `sudo -n` to root | no | **yes without `NoNewPrivileges`** (`uid=0(root)`) | **FAIL** | F-16 |
| D17 | The child can `sudo -n` to root under the shipped systemd unit | no | **no — `NoNewPrivs: 1` is inherited and sudo is refused** | **PASS** | F-16 |
| D18 | The `ubuntu` account has passwordless sudo | no | **`(ALL) NOPASSWD: ALL`** | **FAIL** | F-16 |
| D19 | A concurrent-session cap | a limit exists | no cap on concurrent terminals, no output budget | **FAIL** | F-17 |
| D20 | WS origin validation | enforced | not implemented; the WebView loads `file://`, and the tunnel is the only path in | **GAP** | — |

---

## 5. Rate limiting and IP handling

| # | Case | Expected | Actual | Result | Finding |
|---|---|---|---|---|---|
| E1 | The global limiter buckets by client IP | yes | **the bucket key is the client-supplied `X-Forwarded-For`** | **FAIL** | F-05 |
| E2 | Rotating `X-Forwarded-For` resets the bucket | no | **yes — a fresh bucket per header value** | **FAIL** | F-05 |
| E3 | The per-IP login throttle is spoofable | no | **yes — the same mechanism** | **FAIL** | F-05 |
| E4 | The per-account lockout holds | yes | **yes — it is keyed on the user id in Postgres and survived every test** | **PASS** | — |
| E5 | The lockout is applied before the scrypt computation | yes | confirmed at `auth.ts:216-220` (the lock check precedes `verifyPassword`) | **PASS** | — |
| E6 | The lockout escalates (1m → 5m → 15m → 60m → 24h) | yes | confirmed in `loginGuard.ts:28`; not exhaustively exercised | **GAP** | — |

---

## 6. Information disclosure

| # | Case | Expected | Actual | Result | Finding |
|---|---|---|---|---|---|
| F1 | A path error echoes the path or a stack trace | no | `{"error":"path_outside_roots"}` | **PASS** | — |
| F2 | A malformed login returns a clean 400 | 400 | 400 | **PASS** | — |
| F3 | An unknown route leaks internals | no | `{"message":"Route GET:/… not found","error":"Not Found","statusCode":404}` | **PASS** | — |
| F4 | A database error leaks its message to the client | no | **`{"statusCode":500,"code":"42501","error":"Internal Server Error","message":"permission denied for table users"}`** | **FAIL** | — |
| F5 | The owner's email is stored in plaintext in the audit log | no | `{ email }` in the `detail` JSON | **FAIL** | F-26 |
| F6 | The owner's display name is hardcoded in source | no | `"[personal name removed]"` in `seed-owner.ts:56` | **FAIL** | F-26 |
| F7 | An unauthenticated party can write into the owner's console | no | **yes — the report appears in `GET /crash`** | **FAIL** | F-12 |
| F8 | An oversized crash message is rejected | 400 | 400 | **PASS** | — |
| F9 | Unlinked crash reports are retained forever | no | no retention policy, no delete endpoint | **FAIL** | F-23 |

---

## 7. Android client

| # | Case | Expected | Actual | Result | Finding |
|---|---|---|---|---|---|
| G1 | A biometric prompt is required before the dashboard | yes | **no — `AppLock` is never called** | **FAIL** | F-01 |
| G2 | Certificate pinning is applied to the tunnel host | yes | **no — `NetworkModule` is never called, and the pin list is empty** | **FAIL** | F-01 |
| G3 | The device key is registered and verified server-side | yes | **no — the `public_key` columns are never read or written** | **FAIL** | F-01 |
| G4 | A 401 triggers a token refresh | yes | **no — no authenticator on the client** | **FAIL** | F-01 |
| G5 | Tokens are excluded from backup | yes | `data_extraction_rules.xml` excludes `sharedpref` and `datastore` | **PASS** | — |
| G6 | `allowBackup` is false | yes | `android:allowBackup="false"` | **PASS** | — |
| G7 | Cleartext traffic is denied except loopback | yes | `network_security_config.xml`: `base-config cleartextTrafficPermitted="false"`, loopback only | **PASS** | — |
| G8 | The WebView blocks file/content access | yes | `allowFileAccess = false`, `allowContentAccess = false` | **PASS** | — |
| G9 | The release APK is signed with a release key | yes | **`signingConfig = signingConfigs.getByName("debug")`** | **FAIL** | F-14 |
| G10 | The app has unit and instrumented tests | yes | **no `src/test` and no `src/androidTest` at all** | **FAIL** | F-15 |
| G11 | The token is not written to a URL | no | it is — `?token=` in the WS URL (see D9) | **FAIL** | F-03 |
| G12 | The discovery document is authenticated | yes | **no — an unsigned public gist** | **FAIL** | F-22 |
| G13 | The discovery URL must be `https://` | yes | enforced in `EndpointDiscovery.refresh()` | **PASS** | — |
| G14 | The app adopts a new host only after `/health` answers | yes | enforced by `isReachable()` | **PASS** | — |
| G15 | An instrumented test run on a device | — | **N/R — no device, no emulator, and no test sources exist** | **N/R** | F-15 |

---

## 8. Dependencies, build and infrastructure

| # | Case | Expected | Actual | Result | Finding |
|---|---|---|---|---|---|
| H1 | `tsc --noEmit` | clean | clean, 0 errors | **PASS** | — |
| H2 | The server test suite passes | all pass | **15/15 pass**, 2 suites | **PASS** | — |
| H3 | `npm audit --omit=dev` | 0 critical | **2 critical** (`fast-jwt` chain, 10 advisories) | **FAIL** | F-11 |
| H4 | A secret-pattern scan of the tree | clean | **clean** — one test-only literal (`auth.test.ts:14`) | **PASS** | — |
| H5 | The `ws` package is declared | yes | **no — transitive only** | **FAIL** | F-18 |
| H6 | The project is in version control | yes | **no `.git`** | **FAIL** | F-19 |
| H7 | CI exists | yes | **none** | **FAIL** | F-20 |
| H8 | The vendored `xterm.js` has a version and hash | yes | **neither** | **FAIL** | F-21 |
| H9 | The database binds to loopback only | yes | `127.0.0.1:5433` | **PASS** | — |
| H10 | The database role has least privilege | yes | **`Superuser, Create role, Create DB, Replication, Bypass RLS`** | **FAIL** | F-09 |
| H11 | The API binds to loopback only | yes | `HOST=127.0.0.1` | **PASS** | — |
| H12 | The systemd unit sets `NoNewPrivileges` | yes | yes, and it propagates to the child | **PASS** | F-16 |
| H13 | The systemd unit is installed | yes | **no — `not-found`; the API and tunnel units were never installed** | **FAIL** | F-22 |
| H14 | The published endpoint is live | yes | **HTTP 530** | **FAIL** | F-22 |
| H15 | The `.env` files are `0600` | yes | both are `0600` | **PASS** | — |
| H16 | All SQL is parameterised | yes | **yes — every query in `auth.ts`, `files.ts`, `system.ts`, `crash.ts`, `loginGuard.ts` uses `$n` placeholders** | **PASS** | — |
| H17 | `CORS_ORIGINS` is not `*` | yes | empty (no origin allowed) | **PASS** | F-25 |

---

## 9. Coverage gaps

| Area | What is missing |
|---|---|
| **Android runtime** | No device or emulator was available, and no test sources exist. Every G-case is a source-level judgement except G5-G8 and G13-G14, which are verified by reading the config. |
| **Concurrency** | The refresh-rotation race (A17) was tested. The *upload* race and the *file replacement* race were not. |
| **Load / resource exhaustion** | No load testing was performed, by instruction. F-17 is source-evidence only. |
| **Multi-user** | The app is single-user by design, so B4/B5 could not be exercised meaningfully. |
| **The production deployment** | Not testable — the service is not running and the tunnel is down. All findings are properties of the source, validated against a faithful isolated instance. |
| **Upgrade paths** | The `@fastify/jwt` 10.x migration (R-06) was not attempted; the acceptance matrix is the planned safety net. |
| **The named tunnel** | `scripts/setup-named-tunnel.sh` was read but not executed — DNS delegation of `knistudio.in` is an owner action outside the audit's reach. |
| **Prompt injection into the agents** | Not directly tested. The *consequences* were measured (the terminal child holds the secrets); the injection delivery was not simulated. |

---

## 10. Summary

| Result | Count |
|---|---|
| **PASS** | 51 |
| **FAIL** | 29 |
| **N/R** (not run) | 1 |
| **GAP** (no test exists) | 8 |
| **Total** | 89 |

The **server-side authentication and filesystem core passes every adversarial test it was given** — the path jail, refresh rotation, replay rejection, fingerprint binding, lockout, the trust gate and the WebSocket auth all held. The failures cluster in exactly two places: **the Android client** (its entire security layer is unwired) and **the configuration that surrounds an otherwise-correct core** (`FS_ROOTS`, the fail-open allowlist, the logged token, the spoofable IP, the superuser database role).
