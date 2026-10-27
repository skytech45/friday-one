# FRIDAY One — Firebase Migration Status

**Last updated:** 2026-10-27 · **Branch:** `firebase/migration-phase-0` · Plan: [FIREBASE_MIGRATION_PLAN.md](FIREBASE_MIGRATION_PLAN.md)

Statuses: `VERIFIED` (evidence below) · `IMPLEMENTED_NOT_VERIFIED` · `PARTIAL` ·
`MISSING` · `FAILED` · `BLOCKED` · `NOT_APPLICABLE`.
Nothing is deployed. "Verified" here means verified locally or on an emulator
unless it says staging or production.

---

## Phase log

| Phase | State | Evidence |
|---|---|---|
| 0 Discovery + baseline | **done** | §1 below; plan §1–§2, §8 |
| 1 Firebase config + emulators | **code done; no project configured** | `firebase/firebase.json`, `.firebaserc` (default = `demo-friday-one`, cannot deploy), `env.example`; docs FIREBASE_SETUP.md, ENVIRONMENT_CONFIGURATION.md. Root Gradle declares `com.google.gms.google-services` 4.5.0 `apply false` (resolves; Android tests 11/11 after the change). |
| 3 Data model | **designed** | docs/FIREBASE_DATA_MODEL.md, `firebase/firestore.indexes.json` (6 composite indexes; not deployed or validated against a project) |
| 4 Rules + rules tests | **verified on emulator** | `firebase/firestore.rules`; `firebase/rules-tests` → **34/34 pass** (2026-10-27, firebase-tools 13 emulator on JDK 17; see note). Mutation check: `servers` write loosened → 4 fail. CI job `firestore-rules` added (JDK 21, firebase-tools 15), **not yet run on Actions**. |
| 6 `/api/v1` on Cloud Functions | **code done, verified on emulator, not deployed** | `firebase/functions/` (one 2nd-gen HTTPS function `api`, region `asia-south1`). Same paths, methods, status codes and bodies as Vercel; deliberate changes F-M2/3/9/10/11/12. `npm run typecheck` clean. `test/api.test.mjs` → **21/21 pass** on Auth + Firestore emulators (2026-10-27, firebase-tools 13 on JDK 17). Mutation check: removing the jobs ownership check or the claim attempt budget → 2 fail. CI job `functions` added, not yet run on Actions. |
| 7 Gateway on Firestore | **code done, verified on emulator, not deployed** | `gateway/src/store.ts` replaces `supabase.ts` (firebase-admin; Firebase ID tokens, Google only, revocation checked at connect). Fixes F-M13/14/15/16; UUID constraint F-M17 (also applied to functions). `test/gateway.test.mjs` → **15/15 pass** on emulators (2026-10-27). Mutation check: removing the approval owner check or the revocation listener → 4 fail. Removed fake/live-Supabase scripts (scenarios ported). `cancel-state` fix merged from `fix/gateway-cancel-state` (F-M8). Functions suite re-run after the UUID change: 21/21. Not done: Cloud Run container/deploy config, `friday-gateway.service` still Supabase-era, Android socket reconnect on Cloud Run timeouts. |
| Live hotfix (legacy stack) | **merged to `master` locally, not deployed** | `2e27d57` fixes F-M9 and F-M14 on Vercel + Supabase; tests fail before and pass after. Merged into this branch (`8893c6d`; gateway conflicts resolved to the Firestore versions). Owner deploys. |
| 7b Gateway on Cloud Run | **packaging written, not built or deployed** | `gateway/Dockerfile` (non-root, prod deps only, `HOST=0.0.0.0`), `.dockerignore`; docs/DEPLOYMENT.md §3 (single instance, 3600 s timeout, no key file). No Docker here, so the image is unbuilt. |
| 2/12 Android Firebase sign-in | **code done, unit-tested, not run on a device** | `data/auth/AuthRepository` + `FirebaseAuthRepository` (Credential Manager → Firebase Auth, Google only), `GoogleSignInScreen`; `AUTH_PROVIDER` switch: debug = Firebase (dev), release = Supabase until cutover; the legacy path is untouched. Google-services plugin with WARN for missing configs. Toolchain: Firebase BoM 35.1.0 (firebase-auth 25.0.0) needed **Kotlin 2.4.0** (was 2.0.21) and **compileSdk 35** (targetSdk stays 34). Tests **16/16** (AuthFlowTest 5 new); `assembleDebug` + `assembleRelease` succeed. Known issue: R8 (AGP 8.7.3) warns that it cannot parse Kotlin 2.4 metadata; the build passes, and the fix is an AGP upgrade (P2). |
| 7c Android gateway reconnect | **code done, unit-tested against a real WebSocket server; not run on a device** | `GatewayClient` reconnects with exponential backoff + full jitter (1 s → 30 s cap), fetches a fresh token per connect (`tokenProvider` from the auth backend), stops after two refused logins (`AuthFailed`), never queues or replays (send while offline returns false), and `close()` ends the session without waiting for the server's handshake. Chat shows "reconnecting in Ns" and warns that output during the gap may be missing. Fixes F-M18 (cancel used the wrong job ID) and F-M19. Session copy refreshed every 4 min. Tests: `GatewayClientTest` 9/9; Android total **25/25**. Mutation check: removing the immediate completion in `close()` → the no-handshake test fails. |
| 14 Data migration tooling | **built, verified on emulator; not run on real data** | `firebase/migrate/` export → plan → import → reconcile (docs/DATA_MIGRATION.md). Tests: transform 13/13, export 3/3 (fake Supabase), import 6/6 (emulators, including end-to-end: same Google account → same UID, migrated connector credential syncs with no re-pair, agent UUID preserved). CI job `migrate` added (not yet run on Actions). Blocked for real use: Supabase service key + staging project. |
| 11 Cost: connector rotation cadence | **code done; unit-verified locally, integration on CI only** | `connector/src/rotation.ts`: rotation check every 15 min (was 60 s), env override 1–60 min (plain ms only), boot check kept, failing checks logged instead of becoming unhandled rejections (which would kill the process). Pre-execution policy fetch unchanged. Tests: `rotation.test.ts` 5/5 locally; `dispatch.test.ts` (2, real connector process vs fake control plane + gateway: one boot sync only, fresh sync before every outcome, deny → `policy_deny`, unreachable → `policy_unavailable`) **skipped on Windows** (0600 credential files impossible there), not yet run on CI. Reads ≈ 9× lower per server. |
| 16 Documentation | **written** | SYSTEM_ARCHITECTURE, ROLLBACK_PLAN (not rehearsed), TESTING, COST_AND_QUOTAS (volumes derived from code; prices to verify), PRODUCTION_READINESS_CHECKLIST (verdict: not production-ready), plus DATA_MIGRATION, DEPLOYMENT, data model, rules, setup and environments; README links them all. |
| 5, 8–13, 15 | not started | Decisions D1–D6 **accepted 2026-10-27** (plan §7) |

Note: firebase-tools 15 (the version in the lockfile) needs JDK 21 for the
emulator, and this machine has JDK 17, so the local run used
`npx firebase-tools@13`. CI runs the locked 15.x on JDK 21.

---

## 1. Baseline (before any migration change)

Commit `05ef84e` (branch `android/alignment-phase-0-1`), run 2026-10-27 11:26 IST
on Windows 11, Node 22.23.2, JDK 17.0.19.

| Suite | Command | Result |
|---|---|---|
| Gateway typecheck | `cd gateway && npx tsc --noEmit` | pass |
| Connector typecheck | `cd connector && npx tsc --noEmit` | pass |
| Control-plane typecheck | `cd control-plane && npx tsc --noEmit` | pass |
| Gateway unit + integration | `cd gateway && npm test` | **7/7** sanitisation checks + capabilities integration **PASS** |
| Connector unit | `cd connector && npm test` | **6/8**. The 2 failures (`commandAvailable…`, `availableAgentSpecs…`) assume Linux paths such as `/bin/sh` and fail only on Windows. They are the same failures seen before this work, not a regression. |
| Android JVM unit + Robolectric smoke | `./gradlew :app:testDebugUnitTest` | **11/11** (ScreensSmokeTest 8, ServerParsingTest 3) |

**Not executed (and why):**

| Suite | Reason |
|---|---|
| `infra/supabase/migrations/rls-test.sql` | No PostgreSQL or Docker on this machine. |
| `audit/audit-e2e.mjs`, `audit-f09/r02/r07/r09.mjs` | They target the removed legacy Fastify server (`/auth/devices`, `/ws/terminal`) and cannot run against v2. |
| `gateway/{app-submit,replay-tests,audit-tests,cancel-test}.mjs` | Live tests that need the real Supabase project, a running gateway and a paired connector. |
| Android `assembleRelease` with the real keystore | The keystore is on the deployment host only. A debug-key-signed release build passed. |
| Any live E2E | No connector is paired (per `docs/BACKEND.md`, 2026-10-26). |

Tools **not** available locally at baseline: `firebase` CLI, `gcloud`,
Docker, `psql`.

---

## 2. Acceptance criteria

### Authentication and database
| Criterion | Status | Evidence / blocker |
|---|---|---|
| Google sign-in through Firebase Auth | IMPLEMENTED_NOT_VERIFIED | `FirebaseAuthRepository`; outcomes and unconfigured builds covered by `AuthFlowTest`. **BLOCKED** on device: debug app + SHA fingerprints (owner console steps) |
| Session restoration and sign-out | IMPLEMENTED_NOT_VERIFIED | `current()` on start (Firebase SDK persistence), 10-min token refresh in `FirebaseRoot`, `signOut()` clears Firebase and Credential Manager state; not run on a device |
| Firestore access follows tested least-privilege rules | PARTIAL | Rules **VERIFIED on emulator** (R-1…R-12, 34/34); not deployed to any project; backend (Admin SDK) authorization not written yet |
| Cross-user access rejected | PARTIAL | Rules: VERIFIED on emulator (R-2, R-3, R-5, R-6, R-7, R-8, R-10). API/gateway: pending |
| Security-sensitive fields not client-modifiable | PARTIAL | Rules: VERIFIED on emulator (R-4, R-5, R-7, R-8, R-9, R-10, R-11). Backend validation: pending |
| Indexes and validation configured | IMPLEMENTED_NOT_VERIFIED | `firestore.indexes.json` written, not deployed; backend zod validation pending |
| Existing data migrated and reconciled | PARTIAL | Tooling VERIFIED on emulator with synthetic data (DATA_MIGRATION.md §7). Real run BLOCKED: Supabase service key + staging project |

### Backend and gateway
| Criterion | Status | Evidence / blocker |
|---|---|---|
| Every Supabase/Vercel dependency replaced or justified | PARTIAL | Vercel API: all 11 routes ported (`firebase/functions`). Gateway and Android auth: pending |
| Trusted APIs validate identity and authorization | IMPLEMENTED_NOT_VERIFIED (staging) · VERIFIED on emulator | A-1 (missing/garbage/non-Google tokens → 401), A-2/A-4/A-5/A-6/A-7/A-8 owner scoping. Forged-signature rejection needs a real project (the emulator issues unsigned tokens) |
| Gateway supports authenticated WSS | VERIFIED on emulator · not deployed | G-2 (garbage/non-Google app tokens 4403; unknown/revoked/expired/inactive connector credentials 4403; auth-first 4401) |
| Replay and duplicate handling tested | VERIFIED on emulator | G-8 (duplicate message ID dropped, stale sequence 4400, malformed 4400), G-5 (repeated idempotency key never re-dispatched) |
| Pairing rate-limited and single-use | VERIFIED on emulator | A-2 (single-use session token, one-time pickup, attempt budget, expiry, parallel claims → one credential), A-3 (10/h exactly under 13 parallel requests; failed-claim throttle; hashed buckets). Trusted client-IP header position on Google's front end: staging (A-3b) |
| Revocation blocks reconnect and commands | VERIFIED on emulator · live E2E pending | API: A-4. Gateway: G-2 (revoked/expired credential refused at connect), G-3 (live socket closed on credential revoke, server revoke, grace expiry). Real VPS run: E-1 |
| Connector-side policy enforcement active | NOT_APPLICABLE to change | Connector code unchanged by design |
| Live output not on high-frequency Firestore writes | IMPLEMENTED_NOT_VERIFIED | By design: `chat.delta` stays on WSS (plan §2.2, §2.4) |

### Security and operations
| Criterion | Status | Evidence / blocker |
|---|---|---|
| App Check configured and tested | BLOCKED | Console access + Play Integrity setup (Phase 5) |
| No secrets in APK or source control | PARTIAL | `google-services.json` and service-account patterns git-ignored; full APK scan pending |
| Rules and backend authorization tests pass | PARTIAL | Rules tests pass locally (34/34); backend authorization tests not written |
| CI/CD security checks | PARTIAL | Existing gitleaks + typecheck; `firestore-rules` job added, not yet run on Actions; functions/deploy jobs pending |
| Backup and rollback documented and tested | PARTIAL | Nightly `pg_dump` exists (RR-09); Firebase rollback doc pending |
| Cost, quota, monitoring documented | MISSING | |
| Production deployment evidenced | BLOCKED | Not authorized; projects D1, billing D5 |

### Product functionality
| Criterion | Status | Evidence / blocker |
|---|---|---|
| Android login and server management | MISSING | |
| QR and numeric pairing | MISSING (on Firebase) | |
| OpenCode integration | BLOCKED | Needs staging + VPS |
| Hermes integration | BLOCKED | Needs staging + VPS; Hermes provider quota (429s) noted 2026-10-26 |
| Sessions and live output | MISSING (on Firebase) | |
| Policies and approvals | MISSING (on Firebase) | |
| Revocation end to end | MISSING (on Firebase) | |
| Audit events without secrets | MISSING (on Firebase) | |

---

## 3. Blockers (owner actions)

1. **D1–D6** in the plan §7 (environments, email/password, gateway host,
   region, billing, debug app ID).
2. Supabase DB credentials or a fresh `pg_dump` for the data export (Phase 14).
3. Debug and release SHA-1/SHA-256 fingerprints added to the Firebase Android
   apps (needed for Google sign-in and Play Integrity).
