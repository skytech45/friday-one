# FRIDAY One — Firebase Migration Plan

**Status:** Phase 0 complete (2026-10-27) · **Branch:** `firebase/migration-phase-0`
(based on `android/alignment-phase-0-1`) · **Live status:** see
[FIREBASE_MIGRATION_STATUS.md](FIREBASE_MIGRATION_STATUS.md)

Everything here comes from reading the code at `05ef84e`, not the older docs.
Where the docs and the code disagree, the code wins and the disagreement is
listed in §8.

---

## 1. What the system actually is today

```text
Android (Compose)
  ├─ Supabase Auth REST  ── email+password, Google PKCE, refresh   (SupabaseAuth.kt)
  ├─ HTTPS /api/v1/*     ── ALL data reads/writes                  (ControlPlaneClient.kt)
  └─ WSS                 ── auth.app{Supabase JWT}, command.*, chat (GatewayClient.kt)

Vercel control plane (control-plane/, 11 functions, Node)
  └─ Supabase PostgREST with the SECRET key (bypasses RLS) + JWKS token verify

Gateway (gateway/, Node, systemd on the deployment host, 127.0.0.1:8790,
         exposed through a Cloudflare QUICK tunnel whose URL churns)
  └─ Supabase PostgREST with the SECRET key + JWKS token verify

Connector (connector/, per VPS, systemd, unprivileged)
  ├─ HTTPS control plane: enrollments/session, policies/sync, connector/rotate-credential
  └─ outbound WSS to the gateway: auth.connector{credential}
```

The key facts for the migration:

1. **Android uses Supabase only for authentication.** It never queries
   PostgREST, never uses Realtime, and never touches tables. All data goes
   through the `/api/v1` HTTP contract.
2. **Only two trusted services touch the database:** the control plane and
   the gateway. Both use the service key, so RLS is defence in depth, not the
   primary control. Authorization lives in route code.
3. **The connector never talks to Supabase.** It only knows the control-plane
   base URL and the gateway URL.

So the migration is: **keep the `/api/v1` contract and the WSS protocol,
swap the identity provider and the data layer underneath them.** The connector
needs no code change for the data migration (only its control-plane URL), and
the Android app changes only its auth layer and its base URLs.

---

## 2. Dependency inventory → target

### 2.1 Identity

| Today | Where | Target | Notes |
|---|---|---|---|
| Supabase Auth email+password (login, signup, confirm) | `android/.../data/SupabaseAuth.kt` `login`, `register`, `authCall` | **Decision D2** (§7). Default: drop; Google-only per PRD FR-01. | Firebase supports email/password if kept. |
| Supabase Auth Google OAuth (PKCE via browser + `fridayone://auth-callback`) | `SupabaseAuth.googleAuthorizeUrl/completeGoogle`, `MainActivity.handleAuthRedirect`, manifest intent filter | **Firebase Auth + Credential Manager** (`GetGoogleIdOption` → `GoogleAuthProvider.getCredential` → `signInWithCredential`) | Removes the deep-link redirect flow entirely. |
| Supabase refresh-token storage in DataStore | `SupabaseAuth.save/current/refreshWith` | Firebase Auth SDK session (it persists and refreshes itself); `getIdToken(false)` per request | No tokens stored by our code. |
| Supabase JWT verification (JWKS, issuer) | `control-plane/lib/auth.ts`, `gateway/src/index.ts verifyAppToken` | Firebase ID token verification (`firebase-admin` `verifyIdToken`, issuer `https://securetoken.google.com/<project>`, audience `<project>`) | Gateway checks revocation (`checkRevoked`) at connect time. |
| `profiles` row via `auth.users` trigger | `0001_init.sql handle_new_user` | `users/{uid}` created by the API on first authenticated call (idempotent `create`) | No Firebase trigger needed. |

### 2.2 Data (15 tables) → Firestore

Full model, rules and indexes: [FIREBASE_DATA_MODEL.md](FIREBASE_DATA_MODEL.md).
Summary:

| Postgres table | Firestore | Client access (rules) |
|---|---|---|
| `profiles` | `users/{uid}` | owner read; owner write of `displayName` only |
| `servers` | `servers/{serverId}` (+ `ownerId`) | owner read; **no client writes** |
| `connector_credentials` | `connectorCredentials/{sha256(credential)}` | none (backend only) |
| `agents` | `servers/{id}/agents/{adapter}` | owner read |
| `projects` | `servers/{id}/projects/{sha256(root)}` | owner read |
| `agent_sessions`, `chat_messages` | **not migrated** — empty and unused by code (§8) | — |
| `permission_policies` | `policies/{policyId}` (+ `ownerId`) | owner read; writes via API only |
| `permission_requests` | `servers/{id}/permissionRequests/{id}` | owner read; decisions via gateway only |
| `command_jobs` | `servers/{id}/jobs/{jobId}`; idempotency via doc ID `sha256(serverId:key)` | owner read |
| `audit_events` | `auditEvents/{autoId}` (+ `ownerId`) | owner read; never client-writable |
| `pairing_codes` | **dropped** — legacy table, only dead helpers use it (§8) | — |
| `enrollments` | `enrollments/{id}` + `enrollmentTokens/{sha256(token)}` | none (backend only) |
| `rate_limit_hits` + `consume_rate_limit()` | `rateLimits/{bucket}` updated in a transaction | none |
| `app_config` | `appConfig/{key}` | none (served by `/health`) |

### 2.3 Trusted APIs (Vercel → Firebase)

All 11 Vercel functions are short request/response handlers, so they move to
**one 2nd-gen HTTPS Cloud Function `api`** with an internal router that keeps
the exact `/api/v1/...` paths. Callers then change only the base URL.

| Route | Caller | Auth | Rate limit today | Target |
|---|---|---|---|---|
| `GET /api/v1/health` | Android | none | none | Function; reads `appConfig/gateway_url` |
| `GET /api/v1/servers` | Android | user token | none | Function (+ per-uid limit) |
| `POST /api/v1/servers/{id}/revoke` | Android | user token | per-IP | Function, transaction |
| `POST /api/v1/servers/{id}/rotate` | Android | user token | per-IP | Function |
| `POST /api/v1/enrollments` | Android | user token | per-IP | Function |
| `POST /api/v1/enrollments/{id}/claim` | Android | user token | per-IP + fail budget | Function, transaction |
| `POST /api/v1/enrollments/session` | connector | enrollment token | per-IP | Function |
| `GET /api/v1/enrollments/session?token=` | connector | enrollment token **in URL** | per-IP | Function; **add `POST .../session/poll` with token in the body**, keep GET for old connectors until they upgrade (§5) |
| `GET/POST /api/v1/policies`, `PATCH/DELETE /api/v1/policies/{id}` | Android | user token | none | Function (+ per-uid limit) |
| `GET /api/v1/policies/sync` | connector | credential header | none | Function; **also check credential expiry** (§8 F-M3) |
| `POST /api/v1/connector/rotate-credential` | connector | credential header | none | Function, transaction |
| `GET /api/v1/jobs`, `GET /api/v1/audit` | Android | user token | none | Function, paginated (`limit`, `cursor`) |

Why not Cloud Run for the API: the handlers are stateless and short, and one
function keeps deployment, secrets and logs simple. Revisit only if cold-start
latency matters on the pairing path. Measure that in staging.

### 2.4 Gateway

| Today | Target |
|---|---|
| Supabase PostgREST via `gateway/src/supabase.ts` (13 functions) | Same function names re-implemented on `firebase-admin` Firestore (`gateway/src/store.ts`), so `index.ts` routing logic barely changes |
| Supabase JWT via JWKS | Firebase ID token via `firebase-admin` (`verifyIdToken(token, true)` at connect) |
| systemd on the shared deployment host + Cloudflare quick tunnel (URL churns; published via `app_config`/gist) | **Decision D3.** Default recommendation: **Cloud Run**, `min-instances=1`, `max-instances=1`, request timeout 3600 s, WebSockets on. Gives a stable HTTPS/WSS URL (fixes F-22 without the DNS change), no key file on disk (runtime service account), and moves it off the shared host (RR-05). |

`max-instances=1` is **required**, not a preference: routing state
(`connectorsByServer`, replay baselines) is in process memory. Running two
instances would split connectors and apps across instances and drop
messages. Going multi-instance needs a shared bus, which is out of scope.

Cloud Run ends each WebSocket at the request timeout (≤ 60 min). The
connector already reconnects with backoff and jitter. The Android client must
reconnect too. Verify this in staging (acceptance test G-6).

### 2.5 Connector

No protocol change is needed for the data migration. Changes:

- `FRIDAY_CONTROL_PLANE_URL` → the Function URL (installer default + docs).
- `FRIDAY_GATEWAY_URL` → the Cloud Run URL.
- **Optional, versioned (connector 0.2.0):** poll the enrollment session with
  `POST` (token in the body), and generate the connector credential locally
  so only its hash ever reaches the server (the rotation flow already works
  this way). The server would then never hold a plaintext credential (§8 F-M1).
  Old connectors keep working through the GET/pickup path until removed.

### 2.6 Android

| Today | Target |
|---|---|
| `SupabaseAuth` (OkHttp to `/auth/v1`) | `AuthRepository` interface + `FirebaseAuthRepository` (Credential Manager Google sign-in) |
| `BuildConfig.SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | removed; Firebase config comes from `google-services.json` per variant |
| `BuildConfig.CONTROL_PLANE_URL` (Vercel) | Function base URL per environment |
| `BuildConfig.GATEWAY_URL` (quick tunnel) + `/health` discovery | Cloud Run URL per environment; `/health` discovery kept as an override |
| `fridayone://auth-callback` deep link | removed after Firebase sign-in is verified |
| Token for API/WSS: Supabase access token | `FirebaseUser.getIdToken(false)` |
| — | App Check (Play Integrity; debug provider for debug builds) |

### 2.7 Build, CI, deployment

| Today | Target |
|---|---|
| `control-plane/deploy.py` (Vercel REST) | `firebase deploy --only functions,firestore` from CI with Workload Identity Federation (no JSON key) |
| `scripts/gw-publish-url.sh`, `gw-tunnel.sh`, `friday-gw-tunnel.service` | retired with D3 = Cloud Run |
| `infra/setup-app-role.sh`, `infra/docker-compose.yml`, migrations | kept read-only until Supabase is retired (rollback) |
| CI: typecheck, unit tests, gitleaks, Android | + Firestore rules tests (emulator), + functions tests (emulator), + `firebase` config validation |

---

## 3. Phases, in order

Each phase ends with evidence in the status doc. Deployments need your
explicit go-ahead.

| # | Phase | Can be done without your Firebase access? |
|---|---|---|
| 0 | Discovery, baseline, this plan | ✅ done |
| 1 | `firebase/` config: `firebase.json`, aliases, emulator config, env examples | ✅ |
| 3–4 | Data model, Firestore rules, rules tests on the emulator | ✅ |
| 6 | `functions/` (the `/api/v1` port) + emulator tests mirroring today's route behaviour | ✅ |
| 7 | Gateway `store.ts` on Firestore + ID-token verification; existing tests ported to the emulator | ✅ |
| 2/12 | Android Firebase Auth (Credential Manager), repositories, App Check | ✅ code; ❌ needs SHA-1 fingerprints and the Google provider enabled to run |
| 5 | App Check enforcement | ❌ console |
| 14 | Data export from Supabase → transform → staging import → reconciliation | ❌ needs Supabase DB credentials (deployment host) |
| 15 | CI deploy to staging, smoke tests; production gated | ❌ needs projects, billing, a WIF deploy identity |
| — | Live E2E: real VPS pairing, OpenCode run, revoke | ❌ needs staging deployed + a VPS |

---

## 4. Data migration and cutover (summary; detail in DATA_MIGRATION.md)

- **Size:** a handful of users and servers (the RR-09 restore drill counted 3
  users, but that was the legacy DB; the v2 project count is unknown until
  export). The migration is small; correctness matters more than throughput.
- **Identity mapping:** import users with the Firebase Admin `importUsers`
  API, **keeping the Supabase UUID as the Firebase UID**, so every `ownerId`
  stays unchanged and no data is rewritten. Google identities are imported
  with their `google.com` provider UID, so the same Google account signs in to
  the same UID. Email/password users (only if D2 keeps the provider) are
  imported with their bcrypt hashes (Firebase supports `BCRYPT`); verify this
  in staging before relying on it. Otherwise they sign in with Google using the
  same verified email, and the import maps them by email with an explicit
  report, never a silent duplicate.
- **Connector credentials:** only SHA-256 hashes are stored, and the scheme is
  identical. Importing the hashes lets **already-paired connectors keep
  working without re-pairing** (only their URLs change).
- **Order:** backup (`pg_dump -Fc`; the nightly backup already exists) → export
  JSON → transform (`scripts/migrate/`) → staging import → count/field
  reconciliation → rules and integration tests → rollback drill → production
  import (with your authorization) → verify → keep Supabase and Vercel
  read-only for a rollback window (default 30 days) → retire (with your
  authorization).
- **No dual-write.** Cutover is a short freeze: stop the Vercel API and the
  gateway, take the final export, import, switch URLs, start the Firebase
  stack. The app and connectors reconnect.

## 5. Rollback

Until retirement, rollback is: point the URLs back (Android build config or
`/health` override, connector env), restart the old gateway unit, and
re-enable the Vercel project. Data written to Firestore after cutover is not
copied back. The freeze-and-cutover window keeps that small, and the export
script can run in reverse for the few collections that matter (servers,
credentials, policies). Detail: ROLLBACK_PLAN.md.

## 6. Acceptance tests (IDs referenced by the status doc)

| ID | Test | Where |
|---|---|---|
| R-1…R-n | Rules: unauthenticated, cross-user, privileged fields, server-only collections, valid owner reads | `firebase/rules-tests` (emulator) |
| A-1 | `/api/v1` routes reject missing, invalid, expired and wrong-project tokens | functions tests (emulator) |
| A-2 | Enrollment: create → session → claim → pickup once; reuse, expiry and attempt budget rejected | functions tests |
| A-3 | Rate limits hold across instances (Firestore transaction counter) | functions tests |
| A-4 | Revoke: credential dead, sync 403, gateway refuses reconnect | functions + gateway tests |
| A-5 | Policy CRUD owner-scoped; sync returns only that server's rules; expired credential refused | functions tests |
| G-1 | Gateway capability, cancel-state and replay tests pass on the Firestore store | gateway tests (emulator) |
| G-2 | Firebase ID token accepted; Supabase or forged tokens refused | gateway tests |
| G-3…G-6 | Reconnect after restart, revocation propagation, oversized output, Cloud Run timeout reconnect | staging |
| M-1 | Migration: counts and critical fields match; report of imported/skipped/failed | migration script vs staging |
| E-1 | Live: sign in with Google on a device → pair a VPS by QR and by key → OpenCode prompt streams → policy deny / approval → revoke blocks reconnect | staging + VPS |

## 7. Decisions needed from you

| # | Decision | Recommendation |
|---|---|---|
| D1 | Environments: is `friday-969ea` dev, staging or prod? Create the others? | Make `friday-969ea` **dev**; create `friday-one-staging` and `friday-one-prod`. |
| D2 | Keep email+password sign-in? | Drop it (PRD FR-01 says Google only). Smaller attack surface, no password import. |
| D3 | Gateway hosting | Cloud Run, single instance (§2.4). |
| D4 | Firestore and Functions region (**permanent** for Firestore) | `asia-south1` (Mumbai), close to you; the current Supabase is in `ap-northeast-1`. |
| D5 | Blaze billing plan (required for Functions, Cloud Run and Secret Manager) | Required; set a budget alert first (COST_AND_QUOTAS.md). |
| D6 | Debug app ID `com.friday.one.debug` | Register it as a second Android app in the dev project (its `google-services.json` currently lists only `com.friday.one`, which breaks debug builds once the plugin is applied). |

## 8. Findings from the inventory (code vs docs)

| ID | Finding | Severity | Handled in |
|---|---|---|---|
| F-M1 | The connector credential is stored in **plain text** in `enrollments.credential_pickup` until the connector collects it. | Medium | Firestore: stored only until pickup, as today, but in a backend-only collection. Connector 0.2.0: locally generated credential, hash-only (§2.5). |
| F-M2 | The connector polls `GET /enrollments/session?token=…`, so the enrollment token ends up in URLs and access logs. | Medium | Add a POST poll; deprecate GET. |
| F-M3 | `/policies/sync` and `/connector/rotate-credential` accept a credential that is not revoked but has **expired** (they check only `revoked_at`); the gateway does check expiry. | Medium | Firestore lookup checks both. |
| F-M4 | `servers` RLS is `for all` to the owner, so a client holding the publishable key could update `enrollment_state`, `connector_id` or `last_seen_at` directly through PostgREST. Impact is limited to the owner's own rows. | Low | Firestore: no client writes to `servers`. |
| F-M5 | `lib/supabase.ts` keeps dead pairing helpers for the legacy `pairing_codes` table; `ALLOWED_EMAILS` is parsed but unused. | Info | Not ported. |
| F-M6 | `agent_sessions` and `chat_messages` exist but nothing reads or writes them. | Info | Not migrated; re-add when session history is built (alignment plan Phase 6). |
| F-M7 | `audit/*.mjs` test the removed legacy server, and `gateway/{app-submit,replay-tests,audit-tests,cancel-test}.mjs` need live Supabase. None can run as-is. | Info | Ported to emulator-backed tests where they guard migrated behaviour. |
| F-M8 | The `command.cancel` state fix (`fix/gateway-cancel-state`) is not on this branch's base. | Info | Merge before porting the gateway store. |
| F-M9 | `GET /api/v1/jobs?server_id=X` never checks that the caller owns X, so **any signed-in user can list another user's jobs** (the service key bypasses RLS). | **High** (cross-user read) | Fixed in the Functions port (404 unless owned); test A-7. The live Vercel API is still affected until cutover. |
| F-M10 | Claiming never sets `servers.connector_id`, so every newly paired connector sees `rotation_due` on its first sync and rotates immediately. | Low | Credential bound at claim; test A-2. |
| F-M11 | The claim is check-then-act across several requests: parallel claims can bypass the attempt budget, and a claim that loses the race leaves an issued, **unrevoked credential** behind. | Medium | One transaction per transition; test "parallel correct claims issue exactly one credential". |
| F-M12 | When the rate limiter itself fails, the Vercel code still answers 429 (the 503 branch is unreachable). | Info | 503 `temporarily_unavailable`, fail closed. |
| F-M13 | The gateway throttles `last_seen_at` writes with **one process-wide** timestamp, so with several connectors only one server is written per minute and the others can drop out of the 2-minute online window. | Medium (false offline) | Per-server throttle; test G-9. |
| F-M14 | `permission.decided` matches the request by ID and `pending` only, never checking that the decider owns the server, and never checks expiry. Any signed-in user with a request ID can approve or deny another user's request (the decision is not forwarded to the victim's connector, but the request is consumed). | **Medium–High** (approval integrity) | Owner + pending + expiry in one transaction, only under the user's live servers; test G-5/G-7. |
| F-M15 | A repeated `command.submit` with the same idempotency key resets the job to `queued` and **dispatches it again**, so the prompt executes twice. | Medium | Deterministic job ID + `create()`; a repeat gets `command.rejected{duplicate_request}`; test G-5. |
| F-M16 | A connector's live socket survives revocation; only its next reconnect is refused. | Medium | Firestore listener on the credential + server closes the socket with 4403 (about a second); expiry by timer; test G-3. |
| F-M17 | The envelope schema requires UUIDs for `server_id`/`agent_id`. Firestore auto-IDs would break every message. | (Design constraint) | Servers use `randomUUID()`; agents carry a stable `agentId` (v8 UUID, or the migrated one). |
| F-M18 | The Android client took job IDs from `correlation_id` (the dispatch message ID), so **Cancel in the app never reached a real job**; the live "cancel verified" evidence came from a test script that read `payload.job_id`. | Medium (broken feature) | Job ID read from `payload.job_id`; test `GatewayClientTest`. |
| F-M19 | The Android client never reconnected (despite its comment), and handed the gateway the token captured when the chat opened. On Cloud Run's 60-minute socket limit, chat would silently die, and a naive reconnect would fail on an expired token. | Medium (blocks D3) | Reconnect loop with jittered backoff, fresh token per connect, no replay; tests in `GatewayClientTest`. |

## 9. Risks

| Risk | Mitigation |
|---|---|
| Single-instance gateway is a SPOF | Same as today; Cloud Run restarts it, and clients reconnect. Multi-instance is out of scope. |
| Firestore region is permanent | D4 decided before the database is created. |
| Function cold starts on pairing | Measure in staging; `minInstances: 1` on `api` if needed (costs money). |
| Firestore cost from polling `/servers` | Paginated APIs; optional owner-scoped listeners only for server status; no per-token writes. |
| Identity mapping errors | Keep UIDs equal; dry-run report; staging reconciliation (M-1). |
| App Check blocking dev | Debug provider in debug builds; enforce in prod only after metrics show valid traffic. |
