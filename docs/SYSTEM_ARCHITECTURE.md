# FRIDAY One — System Architecture (Firebase target)

**Status (2026-10-27):** the Firebase architecture below is **implemented and
tested on emulators, not deployed**. Production still runs the legacy stack
(§1) until cutover ([DATA_MIGRATION.md](DATA_MIGRATION.md) §5). Product and
security requirements: [PRD.md](PRD.md), [plans/v2/SYSTEM_DESIGN.md](plans/v2/SYSTEM_DESIGN.md).

## 1. Before → after

```text
BEFORE (live today)                          AFTER (this branch)
Android ── Supabase Auth (email/pw, Google)  Android ── Firebase Auth (Google via Credential Manager)
   │ HTTPS /api/v1                              │ HTTPS /api/v1  (same paths and bodies)
   ▼                                            ▼
Vercel (11 functions) ─ service key ─┐       Cloud Function `api` (asia-south1) ─┐
   │                                 ▼          │                                ▼
   │                          Supabase Postgres  │                         Cloud Firestore
   │ WSS                         (RLS)           │ WSS                    (rules: owner-read only)
   ▼                                 ▲          ▼                                ▲
Gateway on shared host ── service key┘       Gateway on Cloud Run (1 instance) ──┘
 + Cloudflare quick tunnel (URL churns)        (runtime service account, stable URL)
   ▲ outbound WSS                               ▲ outbound WSS
Connector (VPS, systemd, unprivileged)       Connector (unchanged code; new URLs)
```

What stayed the same on purpose: the `/api/v1` HTTP contract, the realtime
envelope protocol ([REALTIME_PROTOCOL.md](REALTIME_PROTOCOL.md)), the
connector and its local policy gate, and the credential-hash scheme. So the
connector needs only new URLs, and existing pairings survive the migration.

## 2. Components and responsibilities

| Component | Code | Runs on | Owns | Trusts |
|---|---|---|---|---|
| Android app | `android/` | user's phone | UI, sign-in, local preferences | nothing it receives; shows only server-authorized data |
| API | `firebase/functions/` | Cloud Functions 2nd gen, `api` | pairing state machine, policies CRUD and sync, revoke/rotate, jobs and audit reads, rate limits | Firebase ID tokens (Google provider only), connector credential hashes |
| Gateway | `gateway/` | Cloud Run, **max 1 instance** | WSS routing, replay guard, job state, approvals, live revocation | Firebase ID tokens (revocation-checked at connect), connector credential hashes |
| Connector | `connector/` | each VPS (systemd, unprivileged user) | executing allowed agent operations, local policy gate (fail closed), output budget | its own credential; the policy fetched right before each execution |
| Firestore | `firebase/firestore.rules` | Firebase | durable state | clients read their own records only and write nothing sensitive |
| Firebase Auth | console | Firebase | identities | Google |

The Admin SDK in the API and the gateway **bypasses Firestore rules**, so
both re-check ownership on every operation (tests A-*, G-*).

## 3. Trust boundaries

| Boundary | Control | Evidence |
|---|---|---|
| App → API | `Authorization: Bearer <ID token>`; signature, issuer and audience checked, Google provider required, revocation checked on writes; ownership checked against Firestore | functions tests A-1…A-8 |
| App → gateway | `auth.app` first message; same token checks; every command re-authorized against the live connector's owner | gateway G-2, G-5 |
| Connector → gateway / API | credential hash lookup; revoked and expired refused; **live sockets closed on revocation** | G-2, G-3, A-4, A-5 |
| Client → Firestore | rules: default deny, owner reads, one client write (own `displayName`) | rules R-1…R-12 |
| Gateway → connector | connector re-validates agent, project root and policy locally before executing | connector code (unchanged) |
| App ↔ device | no secrets in the APK; Firebase config is per variant and git-ignored; tokens held by the Firebase SDK | ENVIRONMENT_CONFIGURATION.md |

## 4. Key flows

**Pairing.** App `POST /enrollments` → token (30 min) → connector
`POST /enrollments/session` → numeric code (10 min, shown with the QR) →
app `POST /enrollments/{id}/claim` (5 attempts; credential issued and bound
in one transaction) → connector polls → one-time pickup → server `active`.

**Command.** App `command.submit` → gateway checks ownership and agent,
creates the job with a deterministic ID (a repeat is rejected, never
re-dispatched) → `command.dispatch` → connector fetches policy (fail closed)
→ `command.accepted/started` → `chat.delta` stream (**WebSocket only, never
Firestore**) → `command.completed` (summary ≤ 4 KiB).

**Approval.** Connector `permission.requested` → stored with payload hash
and expiry → owner's app → `permission.decided` accepted only for the
owner's live server, while pending and unexpired → forwarded with the stored
payload hash.

**Revocation.** App `POST /servers/{id}/revoke` → one transaction: server
`revoked`, credentials revoked, enrollments closed, audit event →
gateway's Firestore listener closes the live connector socket (4403).

## 5. Consistency and timing assumptions

| Assumption | Value | Consequence if violated |
|---|---|---|
| Revocation reaches a live connector socket | ~1 s (Firestore listener latency), measured on the emulator only | the socket stays open longer; commands are still blocked by the API-side credential check on the next policy sync |
| A listener failure | closes the socket (`authorization_unavailable`) | fail closed: the connector reconnects and is re-authenticated |
| Online status | heartbeat within 2 min; `lastSeenAt` written ≤ 1/min per server | brief false "offline" right after a gateway restart |
| App ID token | 1 h lifetime; app refreshes its copy every 4 min and on every reconnect | an expired token is refused; the client retries once, then asks the user to sign in |
| Cloud Run socket lifetime | ≤ 60 min | connector and app reconnect with jittered backoff; nothing is replayed |
| Gateway instances | exactly 1 | a second instance would split routing state; this is a hard constraint, not a tuning knob |

## 6. Deliberately not in Firebase

| Piece | Where | Why |
|---|---|---|
| Realtime gateway | Cloud Run container | needs long-lived WebSockets and in-memory routing; Firestore listeners are not a command channel |
| Agent output | WebSocket stream | per-token Firestore writes would cost money and add latency; only bounded summaries are stored |
| Connector | each VPS | it is the local enforcement point and must not depend on Firebase to say no |
| Legacy Supabase/Vercel | unchanged | rollback target until retirement (ROLLBACK_PLAN.md) |
