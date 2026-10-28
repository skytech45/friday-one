# FRIDAY One — Full System Integration Audit

**Date:** 2026-10-28 · **Branch:** `feat/fridayone-cli` (from `master` @ `c9fed73`)
· **Scope:** Android app, control plane (Vercel + Supabase today; Firebase port
on `firebase/migration-phase-0`), realtime gateway, VPS connector, installer
and `fridayone` CLI, agents (OpenCode, Hermes), GitHub release flow.
Test evidence: [END_TO_END_TEST_REPORT.md](END_TO_END_TEST_REPORT.md).

**Bottom line:** the pieces exist and most are tested in isolation, but the
connector **as distributed** has never worked. Every published bundle
crashed at startup, and a running connector never reconnected after a
disconnect. Both are fixed on this branch and need a new release. The full
Android → backend → gateway → connector → agent chain has **not** been run
together; that needs a live backend, a VPS and a device (§5).

Statuses: `VERIFIED` · `IMPLEMENTED_NOT_VERIFIED` · `PARTIAL` · `MISSING` ·
`FAILED` · `BLOCKED` · `NOT_APPLICABLE`.

## 1. Defects found in this audit (all fixed on this branch unless noted)

| ID | Severity | Defect | Fix | Evidence |
|---|---|---|---|---|
| A-1 | **P0** | Published connector bundles (`v0.6.0`, `v0.9.0`) crash on start: `Dynamic require of "fs" is not supported` (CommonJS deps in an ESM bundle). No connector installed from a release ever ran. | `createRequire` banner; `build-release.sh` smoke-runs the bundle; CI builds and runs it | Downloaded `v0.6.0`/`v0.9.0` assets reproduce the crash; the rebuilt bundle runs `version`/`agents`/`run` |
| A-2 | **P0** | Gateway client **never reconnected** after any disconnect: the backoff timer re-entered `connect()` and rescheduled forever. Gateway restart, network blip or Cloud Run's 60-min cut → server offline until a manual restart. | timer opens the socket | `lifecycle.test.ts` reconnect test fails before, passes after; trace showed 1 connection with endless "reconnect in …" |
| A-3 | **P0** | Old installer could not pair: its `fridayone` wrapper called `/opt/friday-connector/install.sh`, which was never installed (`curl … \| bash`). | new installer + real `fridayone` CLI | `cli-harness.sh` setup flow; `installer-e2e.sh` (CI) |
| A-4 | P1 | Enrollment token echoed by `read -r` and passed as a **command-line argument** (visible in `ps` to all local users). | hidden prompt; token only in the environment of the enrolling process | harness: token absent from config, argv log, output |
| A-5 | P1 | Installer hardcoded a Cloudflare **quick-tunnel** gateway URL (dead after any tunnel restart). | gateway URL fetched from the control plane's `/api/v1/health` during setup | harness: "gateway URL taken from /health" |
| A-6 | P1 | Revoked connector (close 4403) reconnected forever with backoff, hammering the gateway; no visible state. | 4403 is fatal → state `revoked`, exit 78, unit `RestartPreventExitStatus=78` | `lifecycle.test.ts`; `installer-e2e.sh` revocation section (CI) |
| A-7 | P1 | Unit restarted every 5 s forever on persistent failure (missing credential). | start limit 5/10 min, `RestartSec=10`, unpaired exits 78 | bundle smoke: unpaired run exits 78 + state `unpaired` |
| A-8 | P1 | Enrollment poll put the token in the URL (F-M2); live control plane only supported GET. | `POST /enrollments/session/poll` on Vercel (rewrite, no extra function) and in the connector, GET kept for ≤ v0.9.0 | `control-plane/test/session-poll.test.ts`; `lifecycle.test.ts` |
| A-9 | P2 | Installer downloaded to fixed `/tmp/<name>` paths as root (symlink race). | private `mktemp -d`, trap cleanup | code review |
| A-10 | P2 | No status/diagnostics; `uninstall` deleted config without asking; version always "0.1.0". | `fridayone status/doctor/logs`, guarded uninstall, tag embedded in builds | harness |
| A-11 | fixed | Published `v0.9.0` ships the broken bundle (A-1) and old installer (A-3). | released `v0.9.1` | assets downloaded after publishing: checksums OK, bundle runs, installer and CLI pinned to `v0.9.1` |
| A-13 | fixed on `master` (unreleased) | Live control plane advertises the gateway as `https://…`; `fridayone setup` accepts only `wss://`, so the suggested default fails. | setup converts an advertised or typed `https://`/`http://` to `wss://`/`ws://` (validation unchanged) | live `/api/v1/health`, 2026-10-28; harness: advertised and typed cases |
| A-12 | open (known) | F-M1: issued credential held in plaintext server-side until pickup. | connector-generated credential (protocol change, not done) | — |

Earlier findings F-M1…F-M19 (migration audit) are tracked in
`docs/FIREBASE_MIGRATION_PLAN.md` on the migration branch; F-M9 and F-M14
are fixed on `master` (not yet deployed).

## 2. Feature inventory

Columns: **A** Android · **API** control plane / Firebase functions · **GW** gateway · **C** connector.

| Feature | A | API | GW | C | Tests | Status |
|---|---|---|---|---|---|---|
| Email/password sign-in (legacy) | `SupabaseAuth` | Supabase Auth | JWKS verify | — | live-tested in Oct (BACKEND.md) | IMPLEMENTED_NOT_VERIFIED (not re-run) |
| Google sign-in | Supabase PKCE (release); Firebase Credential Manager (migration branch, debug) | Supabase / Firebase Auth | token verify | — | `AuthFlowTest` (migration) | BLOCKED (console: debug app + SHA fingerprints) |
| Session restoration | DataStore refresh (legacy); Firebase SDK (migration) | — | — | — | unit only | IMPLEMENTED_NOT_VERIFIED |
| Data authorization | — | route ownership checks; Firestore rules (migration) | per-message owner checks | — | rules 34, API 21, gateway 15 (emulator, migration) | VERIFIED on emulator · not deployed |
| Server registration + ownership | Pairing screen | `POST /enrollments` | — | — | API A-2 (emulator) | VERIFIED on emulator |
| QR pairing | ZXing scan of `fridayone://pair?e=&c=` | claim | — | renders QR in `enroll` | parser unit tests; harness shows code | PARTIAL (device scan not run) |
| Numeric pairing | key entry | claim (16–20 digits, 5 attempts, 10 min) | — | prints code | API A-2; E2E shows code | VERIFIED on emulator / CI pending |
| Token verification + expiry | — | hashed token, 30 min, single use | — | `FRIDAY_ENROLLMENT_TOKEN` | API A-2; E2E token reuse (CI) | VERIFIED (API, emulator) · CI pending |
| Connector enrollment | — | session/poll | — | `enroll` (POST poll) | harness (stub), E2E (real, CI) | IMPLEMENTED_NOT_VERIFIED until CI runs |
| Gateway connection | `GatewayClient` (reconnect on migration) | — | auth.connector / auth.app | `GatewayConnection` | `lifecycle.test.ts`, gateway G-2, E2E (CI) | PARTIAL: reconnect fixed (A-2); E2E pending |
| Heartbeats + status | dashboard online flag | `last_seen_at` < 2 min | `touchLastSeen` | 15 s heartbeat; state file | gateway G-9 (migration); E2E status | IMPLEMENTED_NOT_VERIFIED (live) |
| Agent discovery | agent chips | `/servers` agents | `connector.hello` upsert | `availableAgentSpecs`, `agents --json` | gateway G-1; connector unit | VERIFIED (unit/emulator) |
| OpenCode | — | — | — | ACP adapter | live-verified 2026-10-25 (BACKEND.md); not re-run | BLOCKED (no VPS/agent here) |
| Hermes | — | — | — | ACP adapter | initialize/session/prompt verified 2026-10-25; provider 429 | BLOCKED (model provider quota) |
| Command submission | chat send | jobs | dispatch, idempotent job IDs | policy gate → ACP | gateway G-5; connector dispatch tests (migration) | VERIFIED (emulator/unit) |
| Live output streaming | chat deltas | — | forward `chat.delta` | ACP deltas | unit/emulator only | IMPLEMENTED_NOT_VERIFIED |
| Cancellation | Cancel button (fixed F-M18 on migration) | — | `command.cancel` state-checked | ACP `session/cancel` | gateway G-6; app parse test | PARTIAL (app fix not on master) |
| Policies + sync | Security screen | CRUD + sync | — | fetched before every execution, fail closed | API A-5; connector `dispatch.test.ts` (migration, CI) | VERIFIED (emulator/CI on migration) |
| Request-bound approvals | inline card | — | owner + pending + expiry (F-M14) | payload hash | gateway G-7; hotfix test | VERIFIED (emulator) · live fix not deployed |
| Replay / duplicate protection | — | — | message-id LRU + sequence; idempotency keys | — | gateway G-5, G-8 | VERIFIED (emulator) |
| Reconnection + retry | backoff + fresh token (migration) | — | — | **fixed (A-2)** | `GatewayClientTest`, `lifecycle.test.ts`, E2E drop (CI) | PARTIAL until E2E runs |
| Server revocation | Revoke | revoke transaction | live socket closed (migration) | **stops on 4403 (A-6)** | API A-4, gateway G-3, E2E (CI) | IMPLEMENTED_NOT_VERIFIED (live) |
| Credential rotation | — | rotate | — | 15-min check (migration) | API A-6 | VERIFIED (emulator) |
| Audit events | audit list | written in transactions | — | — | API A-8 | VERIFIED (emulator) |
| Android error/offline states | partial (alignment plan Phase 2) | — | — | — | smoke tests | PARTIAL |
| Connector installation + upgrades | — | — | — | `install.sh` | harness; E2E (CI) | IMPLEMENTED_NOT_VERIFIED until CI |
| CLI setup + diagnostics | — | — | — | `fridayone` | harness 30/30 | VERIFIED (stubbed) · real systemd pending |
| GitHub release + install docs | — | — | — | release workflow | `v0.9.1` published and checked | VERIFIED (assets); live install on a VPS not run |

## 3. Pairing and token verification (as implemented)

1. App (signed in) → `POST /api/v1/enrollments` → server row `pending`,
   enrollment token (32 random bytes, stored as SHA-256, 30 min).
2. On the VPS, `fridayone setup` reads the token **without echo** and runs
   `friday-connector enroll` as the service user, token only in its environment.
3. Connector → `POST /enrollments/session {token}` → one-time 16–20 digit
   code (stored hashed, 10 min). Shown as a QR (`fridayone://pair?e=&c=`) and as text.
4. App scans or types the code → `POST /enrollments/{id}/claim`: owner
   check, 5-attempt budget, expiry, single use (one transaction in the Firebase port).
5. Connector polls `POST /enrollments/session/poll {token}` → credential
   handed out **once**, written 0600 for the service account.
6. Service starts → `auth.connector {credential}` → gateway verifies the
   hash, revocation, expiry and server state → `auth.resume.ok` → state file `connected`.

Negative paths with evidence: expired, reused or invalid tokens and
attempt exhaustion (API A-2, emulator); reused token on the VPS
(`installer-e2e.sh`, CI); malformed token, non-HTTPS or query-string URLs
and system project roots (harness); revoked or expired credentials (G-2,
G-3); replayed messages (G-8); cross-user commands (G-5); token never in
URLs (POST poll; E2E asserts the fake backend never sees `?token=`). The
QR payload is never executed: the app parses only `e` and `c`.

## 4. Security review summary

| Area | Result |
|---|---|
| Hardcoded credentials | none found: the Supabase **publishable** key in `build.gradle.kts` is public by design; gitleaks CI clean |
| Service-account keys | none in the repo (git-ignored patterns); runtime identities only |
| Token leakage | fixed: argv/echo (A-4), URL (A-8); redaction in logs and state |
| File permissions | credential 0600 service user; config 0640 root:svc; dir 0750 (E2E asserts) |
| Unauthenticated WebSocket commands | first message must authenticate (G-2) |
| Replay / brute force / rate limits | G-8; claim budget + per-IP limits (A-2/A-3) |
| Cross-user authorization | F-M9/F-M14 fixed (master, **not deployed**) |
| Arbitrary shell / injection | connector runs only `session.prompt` through ACP after the policy gate; no shell string execution path |
| Downloads | pinned version + SHA-256, fail closed (E2E tamper test); no signatures yet (P2) |
| systemd | unprivileged, no capabilities, `ProtectSystem=strict`, start limit, no inbound port (E2E asserts) |
| Privilege escalation | `NoNewPrivileges`, empty capability set; installer is the only root step |
| Message/output bounds | 1 MiB gateway frames; ACP output budget; 4 KiB stored summaries |
| Uninstall/upgrade | config preserved on upgrade; purge only with `--purge` |

## 5. What blocks a real end-to-end claim

| Blocker | Needed from you |
|---|---|
| New release with the fixed bundle + installer | authorize pushing this branch, merging to `master` and releasing (e.g. `v0.9.1`) |
| Linux E2E (`installer-e2e.sh`) | runs on CI once this branch is pushed |
| Live backend | deploy the F-M9/F-M14 hotfix to Vercel and the gateway host (legacy), or the Firebase stack (migration plan) |
| VPS + device test (E-1) | a disposable VPS, the app on a phone, an agent with a working model provider |
| Hermes | provider quota |
