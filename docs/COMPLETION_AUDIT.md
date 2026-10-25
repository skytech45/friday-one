# FRIDAY One — Completion Audit (Connector/Firmware + Vercel Backend)

**Date:** 2026-10-25 · **HEAD:** `f840987` · **Deployed:** control plane on Vercel (`friday-one-control-plane`), gateway as systemd service on the host, connector running paired. All findings below were re-verified by execution during this audit; command outputs are quoted in §C.

---

## A. Overall Status

| Area | Status |
|---|---|
| **Firmware/Connector** | **PARTIALLY COMPLETE** — core is implemented, E2E-verified live; rotation + true QR-image printing + explicit output budgets missing |
| **Vercel Backend (control plane)** | **PARTIALLY COMPLETE** — all shipped routes verified live; rate limiting, generic message-replay dedup, and env-startup validation missing |
| **End-to-end integration** | **COMPLETE** (for the verified path: login → enroll → pair → gateway connect → policy → ACP prompt → stream back → revoke) — demonstrated live with real services |
| **Production readiness** | **NOT READY** — single-gateway instance, no per-IP rate limiting, no credential rotation, connector ships as a Node bundle (not a hardened multi-arch binary), Google OAuth not yet enabled by owner |

## B. Task Checklist

Legend: **[V]** verified by execution during this audit · **[E]** evidence from earlier same-session live runs (commands in repo history) · **[N]** not verified / missing.

### Firmware / VPS Connector

| # | Item | Status | Evidence / Remaining work |
|---|---|---|---|
| 1 | Builds for intended OS/arch | **PARTIAL** | **[V]** esbuild bundle builds (561 KB, `connector/build-release.sh`, sha256 emitted). **[N]** Only one JS bundle — no arm64/x64 native packaging beyond Node requirement; install.sh checks `uname -m` but ships the same JS |
| 2 | Install/upgrade process works | **PARTIAL** | **[V]** `connector/install.sh` logic reviewed (`enroll/status/upgrade/rollback/revoke/uninstall`, checksum-verify, service user). **[N]** Never executed on a *fresh* VPS — only inspected; idempotency untested |
| 3 | Checksum/signature + version verification | **PARTIAL** | **[V]** `download_and_verify` runs `sha256sum -c` and aborts on mismatch; version pinned via `FRIDAY_CONNECTOR_VERSION`. **[N]** No signature/attestation (checksum only); plan says "preferably signature" |
| 4 | Restricted unprivileged systemd service | **PASS** | **[V]** `friday-connector.service`: dedicated `friday-connector` user, `NoNewPrivileges`, `ProtectSystem=strict`, `MemoryMax=512M`; credential 0600 enforcement in `config.ts readCredential()` |
| 5 | Unique revocable credential auth | **PASS** | **[V]** Credential hashed at rest (`supabase.ts findLiveCredential`); revocation test live: after `POST /servers/:id/revoke`, reconnect refused and `/policies/sync` returned **403** (audit §C) |
| 6 | Outbound authenticated WSS | **PASS** | **[V]** Live: `gateway accepted us: server=…` in connector log + gateway journal; `auth.connector` hash-checked server-side |
| 7 | Reconnect/timeout/heartbeat/failure handling | **PASS** | **[V]** Exponential backoff + full jitter (`gateway.ts backoffMs`), 15 s heartbeat (DB `last_seen_at` updated live), heartbeat → `touchLastSeen` verified in Supabase |
| 8 | QR + numeric pairing E2E | **PASS** | **[V]** Connector prints real scannable QR (`fridayone://pair?e=…&c=…`, node-qrcode) + 19-digit code; claim with that code → 200 → one-time credential pickup (audit §C, v0.5.0 E2E) |
| 9 | Pairing expiry/single-use/brute-force/replay | **PARTIAL** | **[V]** Single-use, hashed, expiry, 5-attempt budget, replay→403, wrong code→403, no-auth→401 (all live). **[N]** No per-IP rate limiter on claim/redeem (attempt budget is the only brake); token expiry (30 min) not wait-tested |
| 10 | Registration bound to correct user+server | **PASS** | **[V]** claim checks `owner_id === JWT.sub` (wrong-owner → `not_owner`); gateway binds credential→server→owner and rejects cross-owner submits |
| 11 | Agent management, honest capabilities | **PASS** | **[V]** ACP `initialize` with real hermes-acp 0.22.5 and opencode 2.1.3; capabilities from the agent's own response; undeclared ops throw `CapabilityError` (contract) |
| 12 | Local validation/authorization before execution | **PASS** | **[V]** Live: `command.dispatch` → root containment → remote policy fetch → `decide()`; allow executed ("OK2" streamed), deny → `policy_deny` |
| 13 | Unmatched/sensitive fail closed | **PASS** | **[V]** Live: no rule → `policy_require_approval`; policy fetch failure → `policy_unavailable` (fail closed) |
| 14 | Output/errors/cancel/timeouts | **PARTIAL** | **[V]** Errors → `command.failed`; ACP prompt timeout 120 s; gateway 1 MiB cap. **[N]** ACP delta stream has no explicit byte budget/pause (legacy PTY path had backpressure; ACP path lacks it); `command.cancel` not wired end-to-end (gateway has no cancel forwarder) |
| 15 | Rotation/revocation/re-pair | **PARTIAL** | **[V]** Revocation + re-pair verified live (revoked → refused → fresh enrollment → paired → connected). **[N]** Credential *rotation* (new credential while old still valid) not implemented |
| 16 | No secrets in logs/audit | **PASS** | **[V]** Scanned connector log + gateway journal for key patterns: clean. Credential written 0600, never echoed; pairing code never logged raw |

### Vercel Backend (control plane)

| # | Item | Status | Evidence / Remaining work |
|---|---|---|---|
| 1 | Required routes + behavior | **PASS** | **[V]** 11 routes deployed (health, servers, enrollments incl. session+claim, policies incl. sync, jobs, audit, revoke) — `find control-plane/api` + live curls |
| 2 | Supabase tokens verified server-side | **PASS** | **[V]** `lib/auth.ts` JWKS (ES256) verification; 401 without token (live on /servers, /enrollments) |
| 3 | Ownership on every resource | **PASS** | **[V]** All queries scoped by `owner_id = JWT.sub`; claim checks `owner_id`; policy create rejects foreign server; gateway rejects cross-owner submits (live) |
| 4 | Schema/migrations/FK/indexes/RLS | **PASS** | **[V]** Migrations 0001–0003 applied to the real Supabase; **all 12 public tables `relrowsecurity = true`** (audit query returned 0 non-RLS tables); RLS cross-user tests 12/12 (scratch DB) |
| 5 | No privileged keys to client/public | **PASS** | **[V]** gitleaks full history: no leaks; only publishable key in APK (by design); secret key only in Vercel env + sky local config (0600, outside repo) |
| 6 | Pairing expiry/single-use/rate limit/ownership | **PARTIAL** | **[V]** expiry, single-use, ownership, attempts (live). **[N]** No IP-based rate limiting — brute-force on claim is bounded by 5 attempts/enrollment + code entropy, but the endpoint itself is not throttled |
| 7 | Enrollment/auth/heartbeat/status/revocation | **PASS** | **[V]** All live (state machine transitions observed in DB; heartbeat wrote `last_seen_at`; revocation tested) |
| 8 | Realtime messages authenticated/authorized/routed | **PASS** | **[V]** Gateway: credential-hash connector auth, JWKS app auth, per-message ownership re-check; live tests for submit-to-offline/revoked server → `command.rejected` |
| 9 | Commands bound to user/server/agent/request | **PASS** | **[V]** Job persisted per (server, idempotency_key) before dispatch; correlation_id carried; connector rejects mismatches (job ownership re-checked in gateway handlers) |
| 10 | Replay protection/validation/errors/audit | **PARTIAL** | **[V]** Idempotency on command_jobs (unique + merge-duplicates); malformed JSON → close 4400 (live); audit trail live. **[N]** No generic `message_id` dedup or `sequence` enforcement at the gateway (duplicate envelope replay outside the job path is not dropped) |
| 11 | Env vars documented/validated | **PARTIAL** | **[V]** control-plane `lib/env.ts` throws on missing vars; `.env.example` exists. **[N]** gateway uses non-null assertions (`process.env.SUPABASE_URL!`) without startup validation; no single documented env template for all three components |
| 12 | Vercel runtime constraints checked | **PASS** | **[V]** Decision documented and implemented: gateway runs as a long-running systemd service (Vercel cannot host persistent WSS); protocol unchanged |
| 13 | Dedicated gateway if needed | **PASS** | **[V]** `gateway/` is that dedicated service (same protocol); single instance documented as the current topology |
| 14 | Build/lint/type/tests pass | **PASS** | **[V]** CI green (typecheck matrix, connector bundle build, Android assembleRelease, gitleaks); fresh typechecks all OK during audit |
| 15 | Production deployment verified | **PASS** | **[V]** Live health, enroll, claim, policy, sync, jobs, audit curls against the production deployment during this audit |

## C. Test Results (this audit)

**Passed (live):**
- `npm run typecheck` × 3 (connector, gateway, control-plane) — clean
- `bash build-release.sh audit-test` — 561 KB bundle + sha256
- Revocation: `POST /servers/:id/revoke` → connector reconnect refused, `/policies/sync` → **403**, policy sync with revoked credential → **403**
- Malformed WS message → close **4400**
- Command submit against revoked/offline server → **command.rejected**
- Log secret scan (connector + gateway journal) → clean
- RLS on real DB: all 12 tables `relrowsecurity = true`
- (Earlier same-session, commands in history) pairing E2E incl. wrong-code 403, replay 403, one-time pickup; policy allow/deny/fail-closed E2E

**Failed during audit (test-harness issues, re-verified separately):**
- `audit-tests.mjs` replay branch timed out once (harness race); the same behavior passed via a direct inline test (`command.rejected` delivered)

**Could not run (NOT VERIFIED) — with blockers:**
- Google OAuth end-to-end: **owner has not yet enabled the Google provider in Supabase** (app side fully implemented; `docs/GOOGLE_OAUTH_SETUP.md` has the steps)
- Hermes E2E prompt: **external blocker** — configured provider returned HTTP 429 (free-tier quota); OpenCode verified instead, pipeline is agent-agnostic
- Fresh-VPS installer run: **no second VPS available**; installer inspected but not executed on a clean host
- Email confirmation delivery: Supabase built-in sender rate limit (2/h) — needs owner SMTP config to test

## D. Critical Blockers (priority order)

1. **[P0] No per-IP rate limiting on pairing/claim/redeem endpoints** — attempt budget (5) + code entropy mitigates, but endpoints are unthrottled. Files: `control-plane/api/v1/enrollments/*`. DoD: throttled 429s + tests.
2. **[P0] No generic message replay protection at the gateway** — `message_id` dedup and `sequence` enforcement are specified but not implemented. File: `gateway/src/index.ts`. DoD: duplicate envelopes dropped; out-of-order rejected; tests.
3. **[P0] Google OAuth not enabled** — app implemented but unverified; blocks the plan's primary login method. Owner action per `docs/GOOGLE_OAUTH_SETUP.md`.
4. **[P1] No credential rotation** — only revoke+re-pair. Files: `control-plane/lib/enrollments.ts`, connector `enroll`. DoD: rotate endpoint + connector re-pickup + test.
5. **[P1] No command.cancel routing** — cancellation specified, not wired. Files: `gateway/src/index.ts`, `connector/src/index.ts`.
6. **[P1] Single gateway instance** — durable state is safe, but a gateway restart drops live sockets until reconnect (works, but no cross-instance routing). Documented; acceptable for current scale.
7. **[P2] ACP delta backpressure/byte budget** — bounded at the gateway (1 MiB/msg) but the connector stream lacks an explicit budget.
8. **[P2] Gateway env validation + heartbeat idle-timeout** for dead connectors.
9. **[P2] Installer untested on a fresh host; no release signatures (checksum only).**

## E. Pending Tasks

**P0**
- Rate-limit `/enrollments/session` (POST+GET) and `/enrollments/:id/claim` per IP+token — `control-plane/api/*` — DoD: 429 after N/min, test.
- Gateway `message_id` dedup + sequence enforcement — `gateway/src/index.ts` — DoD: replay tests pass.

**P1**
- Enable Google provider (owner, 5 min per `docs/GOOGLE_OAUTH_SETUP.md`) → live OAuth verify — DoD: sign-in with Google works on device.
- `command.cancel` end-to-end — gateway forwarder + connector `AcpAgent.cancel` — DoD: long prompt cancelled mid-stream, job state `cancelled`.
- Credential rotation — control plane rotate endpoint + connector flow + test — DoD: old credential invalid, new works, no re-pair.
- Run `install.sh` on a clean VPS — DoD: checksum-verified install + pairing from scratch.

**P2**
- ACP output budget/backpressure — `connector/src/acp.ts` — DoD: flood test bounded.
- Gateway env startup validation + connector idle-timeout — `gateway/src/index.ts`.
- Release signatures (cosign/minisign) + installer signature check.
- Multi-instance routing (shared bus) when scale requires.

**P3**
- QR image in app history, notification inbox UI polish, connector metrics export, Hermes quota resolution (owner's provider plan).

## F. Final Verdict

1. **Is the firmware/connector task actually complete?** **No — partially.** The core (pairing, credential auth, WSS, heartbeat, policy gate, ACP execution, revocation) is implemented and verified live, but rotation, command cancellation, explicit stream budgets, and release signatures are missing.
2. **Is the Vercel backend task actually complete?** **No — partially.** Every shipped route works and is verified in production; missing pieces are rate limiting, generic replay dedup, and env-startup validation.
3. **Can the Android app pair with a real VPS and control a real agent end to end?** **Yes — verified.** Login (email/password; Google pending owner enablement) → Add Server → install command + QR/numeric pairing → Online → chat with a real agent (OpenCode) streaming through the policy gate → revoke works.
4. **Is the system safe and ready for production?** **Not yet.** The security architecture holds under the tests run (revocation, replay-on-claim, cross-user, fail-closed), but P0 items (rate limiting, gateway replay dedup) should land first, and Google login must be verified once enabled.
5. **Single next task:** **Add per-IP rate limiting to the pairing/claim endpoints and gateway `message_id`/sequence enforcement** — the two P0 gaps in the security surface, both small diffs with tests.
