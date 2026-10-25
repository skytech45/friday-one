# FRIDAY One — Baseline Audit (Upgrade Plan Phase 0)

**Date:** 2026-10-25
**Audited at:** `master` @ `43fcce0` (12 commits, tags `audit-p0-20261023`, `audit-p1-20261024`, `audit-p1b-20261024`), working tree clean.
**Method:** read-only inspection of the repository and its live deployment on the
target host, compared against `UPGRADE_PLAN.md` / `SYSTEM_DESIGN.md` / `PROMPT.md`.
Every claim below was verified by execution or direct file inspection; nothing is
taken from documentation alone. No application code was changed.

---

## 1. What exists today (verified)

### Backend — `server/` (Fastify + TypeScript, Node 22)

| Piece | State | Evidence |
|---|---|---|
| HTTP API on `127.0.0.1:8787` | working | boots green in every audit harness; e2e 71/71 |
| PostgreSQL 16 in Docker (`friday-pg`), loopback `:5433` | working | `infra/docker-compose.yml`; app connects as least-privilege `friday_app` (F-09 fixed) |
| Auth: register/login/refresh/devices, HS256 JWT, per-device trust | working, single-owner | `routes/auth.ts`; `ALLOWED_EMAILS` allowlist makes registration owner-only |
| Device binding: fingerprint (peppered hash), trust, revocation, key-security metadata | working | `schema-device-binding.sql`, `revocation.ts` |
| Routes: `/system` (trusted-gated), `/fs/*` (path jail), `/crash` (sanitised, linked-only), `/ws/terminal` (WS PTY) | working | `routes/*.ts`; e2e §3–13 |
| Audit log | partial | `audit_log` table records auth events; no query/UI surface beyond `/system/audit` |
| Migrations | idempotent, run at boot | `src/migrate.ts` (bootstrap-role URL), `schema.sql` |
| Secrets handling | scrubbed from env after capture; child env is an explicit allowlist | `config.ts` (F-10 fixed) |

### Android — `android/` (Kotlin, Jetpack Compose)

| Piece | State | Evidence |
|---|---|---|
| Screens: Login, Machine (telemetry), Files, Terminal | working | `MainActivity.kt` (session store, device-identity register/login flow) |
| Transport discovery | public gist publishes the quick-tunnel URL; app re-resolves on failure | `data/EndpointDiscovery.kt` (finding F-22: dead tunnel, unauthenticated discovery) |
| Security classes: `AppLock`, `CertificatePinning`, `DeviceIntegrityGate`, `TamperDetection`, `NetworkModule` | **dead code** — zero call sites (audit finding F-01, open) | grep: no references from `MainActivity` |
| Network config | cleartext denied except loopback; TLS enforced | `res/xml/network_security_config.xml` |
| Tests | none (F-15 open); `junit` declared, unused | no `src/test`/`src/androidTest` |

### Transport / deployment

- Cloudflare **quick tunnel** (random hostname per restart), published to a gist.
  **Currently dead: HTTP 530, and `friday-one-api.service` / `friday-one-tunnel.service`
  are not installed.** Only `friday-console.service` (a separate project) is active.
  The Android app therefore has no reachable backend right now.
- `scripts/setup-named-tunnel.sh` exists but was never executed (needs DNS
  delegation of `knistudio.in` — owner action).

### Agents on the target host (verified live)

- `opencode` **v2.1.3** at `/usr/local/bin/opencode`.
- `hermes` lives at **`~/.local/bin/hermes`** (with `hermes-acp`, `hermes-agent`).
  The server's terminal child PATH is `/usr/local/bin:/usr/bin:/bin`
  (`config.ts childEnv`), so the `hermes` terminal kind **fails with ENOENT as
  deployed** (finding B-7 below).
- The Hermes "gateway" is a config/state directory (`~/.hermes/`, incl.
  `auth.json`), not a service the repo controls.
- Agent interaction today is **PTY TUI streaming only** — there is no
  programmatic session/chat/permission interface anywhere in the stack.
  The presence of `hermes-acp` (Agent Client Protocol) suggests a real
  programmatic surface exists to build the adapter on; it must be verified
  (version, docs) before adapter work starts.

### Engineering posture

- Security audit (26 findings): **14 fixed, 0 partially open.** All P0 and P1
  items closed and re-verified: `tsc` clean · 20/20 unit · 71/71 e2e ·
  `npm audit --omit=dev` 0 vulnerabilities.
- Remaining findings: F-14 (debug-signed release APK), F-15 (no Android tests),
  F-16 (terminal runs as owner uid; docker group), F-17 (no terminal resource
  limits), F-20 (no CI), F-21 (vendored xterm.js unversioned), F-22 (dead
  tunnel/discovery), F-23–F-26 (informational), RR-05 (control plane shares the
  host with other services), RR-09 (no backups/restore drill).

---

## 2. Current architecture vs target architecture

| Target component (`SYSTEM_DESIGN.md`) | Today | Gap |
|---|---|---|
| Android (Compose, MVVM) | exists, 4 screens | missing pairing/sessions/permissions/policies/audit screens; dead security layer; single hard-coded trust model |
| Supabase Auth + RLS | **absent** — custom JWT, single owner, app-level `user_id` scoping | full identity migration; RLS meaningless until Postgres is user-facing |
| Vercel control plane | **absent** — the Fastify app on the target box *is* the control plane | structural conflict: today's control plane runs on the managed machine (RR-05 flagged exactly this) |
| FRIDAY Connector (per server, outbound WSS, unprivileged, local policy gate) | **absent** — execution is in-process on the box via `/ws/terminal` PTYs | new component; no pairing, no per-server identity, no local policy engine |
| Realtime gateway + shared routing | **absent** — inbound HTTPS/WSS through a tunnel | new component; Vercel WS limits must be validated before choosing where it runs |
| Agent adapters with capability registry | **absent** — TUI PTYs (`hermes`/`opencode`/`shell`) with no negotiation | new adapter contract; `hermes-acp`/`opencode` are the candidate real interfaces |
| Policy engine + approvals | **absent** | new; audit_log is a partial precedent for audit_events |
| Durable command/approval state in Postgres | **absent** | schema lacks all 11 target entities; today's tables: `users, devices, sessions, files, crash_reports, audit_log` |
| Secrets never in Android | **holds** | scan of `android/` found no embedded secrets; base URL only (gist) |

**The single most important structural fact:** today's system is
*single-user, single-server, control plane co-located with execution*. The
target is *multi-user, multi-server, control plane in the cloud, execution
behind a locally-enforcing connector*. This is a re-platforming, not a
feature addition. Everything in §3 follows from it.

---

## 3. Prioritized findings (gaps)

Severity is for the **upgrade program**, not day-0 exploitation. "Dependencies"
list what must land first. Acceptance criteria are the evidence each phase must
produce before it is called done.

### B-1 · No multi-user identity layer — Critical
Today's `users`/JWT/allowlist model cannot express "many users, each with their
own servers". Every later phase (RLS, pairing, ownership checks) derives from
this. **Dependency:** none. **Acceptance:** Supabase Auth issues tokens the
control plane verifies server-side; identity is never read from request bodies;
cross-user access tests pass against real token substitution.

### B-2 · Control plane and execution are the same process on the same box — Critical
`friday-one`'s Fastify app both authorizes *and* executes (terminal PTYs, file
reads) on the target machine. Any web-level compromise is immediate host
compromise; the audit's RR-05 already records the shared-host risk. The target
design fixes this by splitting control plane (cloud) from connector (box).
**Dependency:** B-1 (multi-user) conceptually, but the split itself can start
first — the connector v0 can speak to today's server. **Acceptance:** the box
runs only the connector (unprivileged account, outbound-only); authorization
decisions are made off-box.

### B-3 · No connector, pairing, or enrollment flow — Critical
Nothing enrolls a server, nothing binds a revocable per-server credential.
**Dependencies:** B-1, B-2. **Acceptance:** short-lived single-use pairing code
(hashed at rest, rate-limited redemption) → unique revocable connector
credential → outbound WSS; expiry/reuse/wrong-owner/guessing/revocation tests
all pass.

### B-4 · No realtime gateway — High
No WSS hub, no routing, no acks/cursors/idempotency/reconnect reconciliation.
Also **unverified: whether Vercel's runtime supports long-lived WebSocket
gateways at acceptable limits/cost** — the design itself says to check and, if
not, run a long-running gateway service. The box already runs a Node/WS stack
(fastify-websocket), so a standalone gateway is low-risk fallback.
**Dependencies:** B-3. **Acceptance:** protocol envelope (version, ids,
correlation, sequence, expiry) implemented; duplicate/out-of-order/disconnect
tests pass; durable state lives in Postgres, not in connections.

### B-5 · No agent adapter layer — High
Agents are PTY TUIs today; sessions/chat/permissions cannot be listed or
controlled programmatically, so "permission requests" cannot exist yet.
`opencode` v2.1.3 and `hermes-acp` are the candidate interfaces and must be
verified against their real docs before implementation. Do not claim
permission interception the agents don't expose. **Dependencies:** B-4
(transports the events). **Acceptance:** versioned adapter contract +
capability registry; Hermes adapter passes conformance tests on the real
installed version; unsupported capabilities return explicit errors.

### B-6 · Data model mismatch — High
Target needs 11 entities (profiles → audit_events) with FKs, RLS, retention;
current schema has 6 tables sized for a single owner. Migration must preserve
today's working features during the transition. **Dependencies:** B-1.
**Acceptance:** versioned migrations; RLS policies on every user-owned table;
cross-user and ID-substitution tests pass; rollback documented.

### B-7 · Deployed defects that block any user-facing work — Medium (fix now)
1. **Nothing is deployed:** API and tunnel units are not installed; the app
   cannot reach the backend at all (HTTP 530). Until the pivot lands, keep the
   current product usable.
2. **`hermes` terminal kind is broken:** binary is at `~/.local/bin/hermes`,
   outside the child PATH in `config.ts childEnv` → ENOENT. Fix: absolute path
   or extend PATH deliberately.
3. **F-14:** release APK is debug-signed — must be fixed before ANY new build is
   distributed, regardless of architecture.
4. **RR-09:** no backups. Before any schema migration in this program, an
   off-host git remote + nightly `pg_dump` + one successful restore must exist.
   A re-platforming with no rollback target is how data is lost.

### B-8 · Dead Android security layer + no tests — Medium
F-01 (AppLock/pinning/integrity gate have zero call sites) and F-15 (no
Android tests) stay open. The re-platforming rewrites the network/identity
layer anyway; decide per component: wire it (pinning once the stable domain
exists) or delete it (docs must never describe controls the binary lacks).

### B-9 · No CI — Medium (F-20)
The existing harnesses (unit + 71-check e2e + audit-f09 + R-02/R-07/R-09) are
excellent and self-cleaning but run only by hand. CI must exist **before** the
migration starts rewriting auth/DB layers, or regressions ship silently.
**Acceptance:** pipeline runs `npm ci`, audit, typecheck, unit, e2e, gitleaks,
Android lint/tests, release-signature assertion.

---

## 4. Security-invariant cross-check (current system)

| Invariant (PROMPT.md) | Status today |
|---|---|
| No privileged backend secret in Android | **holds** (verified by scan; only base URL in app) |
| No cross-user access | **holds by construction** (single owner); untested multi-user |
| No shared global connector credential | n/a — no connector |
| No execution without authorization + local policy | partial — WS terminal is JWT + trusted-device gated, but there is **no policy layer**; `kind=shell` is an unrestricted `bash -l` (owner decision pending) |
| No unrestricted root shell by default | **holds** (runs as `ubuntu`, `NoNewPrivileges`, sudo blocked) — but F-16's `docker`-group caveat applies |
| No execution from stale/changed approval | n/a — no approvals |
| Durable state over transient events | **holds** for auth/session state (Postgres); terminal sessions are ephemeral by design |
| No secrets in logs/reports/crash uploads | **holds and tested** (R-03 checks; F-12 sanitisation) |

---

## 5. Migration plan (maps to delivery phases 0–8)

**Guiding rule (from PROMPT.md): evolve, don't replace.** The current server
becomes *connector v0*: it already runs on the target box, already has
device-bound auth, revocation, a path-jail, sanitised crash intake and a
hardened WS terminal. That is a running start for the connector's
responsibilities (local execution gate). What must move off-box is
*authorization*, and what must be added is *enrollment, adapters, policies*.

| Phase | Work | Bridge strategy to preserve today's value |
|---|---|---|
| 0 (this doc) | baseline + threat model | — |
| Pre-1 (B-7) | deploy what exists (named tunnel once DNS delegated, or keep app working another way); fix hermes PATH; create release keystore; set up off-host git remote + pg_dump + restore drill; CI | current product usable again; safety net before migrations |
| 1 | Supabase Auth + schema + RLS; Vercel control-plane APIs (verify tokens, ownership) | keep Fastify auth working in parallel; Android gets an account layer; old tokens keep working until cutover |
| 2 | pairing/enrollment; connector identity | extract today's server's execution surface into a connector role; same box first (dogfood), then generalize |
| 3 | realtime gateway + protocol | start with a long-running Node gateway (stack already known); evaluate Vercel WS limits before committing; protocol versioned from day 1 |
| 4 | Hermes adapter (verify ACP first), session UI | keep TUI terminal as fallback path while adapter lands |
| 5 | policy engine + approvals + audit | audit_log evolves into audit_events; `kind=shell` decision folds in here |
| 6 | OpenCode adapter | — |
| 7 | custom adapter spec + conformance | — |
| 8 | hardening, signing, deployment, recovery drills | decommission dual-auth; remove legacy routes only after Android cutover is verified |

Owner decisions required before Phase 1 (unchanged from todo.md where they
overlap): supply release keystore; delegate `knistudio.in` DNS; keep-or-remove
`kind=shell`; keep-or-remove `/auth/register`; move control plane off the
shared host (RR-05) — now subsumed by the target architecture itself.

---

## 6. Rollback approach

1. **Git:** every phase lands as tagged batches (pattern exists:
   `audit-p0-20261023` etc.); revert = redeploy previous tag. Off-host remote
   (B-7.4) makes this recoverable even if the box dies.
2. **Database:** versioned migrations with paired down-scripts; `pg_dump`
   snapshot immediately before every migration; **restore drilled once** before
   Phase 1 starts.
3. **Dual-run windows:** new identity and connector run *alongside* the current
   server (different port, feature-flagged); Android keeps the old path until
   the new one is verified end-to-end; cutover is a config flip, revert is the
   flip back.
4. **Connector:** separate systemd unit under a dedicated account — removing it
   restores today's topology exactly.
5. **Android:** Play-style staged rollout is overkill for a personal app; keep
   every released APK under `~/FRIDAY-One-v*-debug.apk`-style versioning
   (pattern already exists) so any device can be downgraded.

---

## 7. Verified-state summary

| Check | Result at audit time |
|---|---|
| `git status` | clean, `master` @ `43fcce0` |
| `tsc --noEmit` | clean |
| unit tests | 20/20 |
| `audit/audit-e2e.mjs` | 71/71 |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Android build/tests | **not run** — no test sources exist (F-15); build requires a keystore decision for release (F-14). Debug build not exercised in this audit. |
| Live deployment | **down** — API/tunnel units not installed (B-7.1) |
| Secrets in repo | none found (gitignored `.env` files; prior commits were grep-checked) |
