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
| 2, 5, 7–16 | not started | Decisions D1–D6 **accepted 2026-10-27** (plan §7) |

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
| Google sign-in through Firebase Auth | MISSING | Phase 2/12 |
| Session restoration and sign-out | MISSING | |
| Firestore access follows tested least-privilege rules | PARTIAL | Rules **VERIFIED on emulator** (R-1…R-12, 34/34); not deployed to any project; backend (Admin SDK) authorization not written yet |
| Cross-user access rejected | PARTIAL | Rules: VERIFIED on emulator (R-2, R-3, R-5, R-6, R-7, R-8, R-10). API/gateway: pending |
| Security-sensitive fields not client-modifiable | PARTIAL | Rules: VERIFIED on emulator (R-4, R-5, R-7, R-8, R-9, R-10, R-11). Backend validation: pending |
| Indexes and validation configured | IMPLEMENTED_NOT_VERIFIED | `firestore.indexes.json` written, not deployed; backend zod validation pending |
| Existing data migrated and reconciled | BLOCKED | Needs Supabase DB credentials (deployment host) + a staging project |

### Backend and gateway
| Criterion | Status | Evidence / blocker |
|---|---|---|
| Every Supabase/Vercel dependency replaced or justified | PARTIAL | Vercel API: all 11 routes ported (`firebase/functions`). Gateway and Android auth: pending |
| Trusted APIs validate identity and authorization | IMPLEMENTED_NOT_VERIFIED (staging) · VERIFIED on emulator | A-1 (missing/garbage/non-Google tokens → 401), A-2/A-4/A-5/A-6/A-7/A-8 owner scoping. Forged-signature rejection needs a real project (the emulator issues unsigned tokens) |
| Gateway supports authenticated WSS | MISSING (on Firebase) | Phase 7 |
| Replay and duplicate handling tested | MISSING (on Firebase) | Phase 7 |
| Pairing rate-limited and single-use | VERIFIED on emulator | A-2 (single-use session token, one-time pickup, attempt budget, expiry, parallel claims → one credential), A-3 (10/h exactly under 13 parallel requests; failed-claim throttle; hashed buckets). Trusted client-IP header position on Google's front end: staging (A-3b) |
| Revocation blocks reconnect and commands | PARTIAL | API side VERIFIED on emulator (A-4: sync 403, rotation refused, enrollments closed). Gateway reconnect refusal: Phase 7 |
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
