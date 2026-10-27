# FRIDAY One — Production Readiness Checklist (Firebase stack)

**Verdict (2026-10-27): NOT production-ready.** The code is implemented
and passes its automated tests on emulators. Nothing is deployed, nothing
has run on a real device or VPS, and the release gates below are open.

Statuses: `VERIFIED` (evidence linked) · `IMPLEMENTED_NOT_VERIFIED` ·
`PARTIAL` · `MISSING` · `BLOCKED` (needs an owner action).
Detail and evidence: [FIREBASE_MIGRATION_STATUS.md](FIREBASE_MIGRATION_STATUS.md).

## Security

| # | Gate | Status | Evidence / blocker |
|---|---|---|---|
| S-1 | Firestore rules least-privilege, tested | VERIFIED (emulator) | rules tests 34/34 + mutation check |
| S-2 | API and gateway authorize every operation | VERIFIED (emulator) | A-1…A-8, G-2/G-5/G-7 + mutation checks |
| S-3 | Forged ID-token signatures rejected | BLOCKED | needs a real project (emulator tokens are unsigned) |
| S-4 | Pairing single-use, rate-limited, expiring | VERIFIED (emulator) | A-2, A-3; trusted-IP header position in staging (A-3b) |
| S-5 | Revocation blocks reconnect and live sockets | VERIFIED (emulator) | A-4, G-2, G-3; live run E-1 pending |
| S-6 | No secrets in the APK or repo | PARTIAL | git-ignore + gitleaks job; APK scanned for key-file names only; full APK secret scan pending |
| S-7 | App Check (Play Integrity) enforced | MISSING | Phase 5; needs console registration |
| S-8 | Live-stack fixes F-M9 / F-M14 deployed | BLOCKED | merged to `master` locally; owner deploys |
| S-9 | Connector credential never stored in plaintext server-side (F-M1) | PARTIAL | held only until pickup in a closed collection; connector 0.2.0 change not done |
| S-10 | Security review of the Firebase code | MISSING | no independent review yet |

## Functionality (staging + VPS)

| # | Gate | Status |
|---|---|---|
| F-1 | Google sign-in, session restore, sign-out on a device | BLOCKED (debug app + SHA fingerprints) |
| F-2 | QR and numeric pairing end to end | MISSING (staging) |
| F-3 | OpenCode prompt streams; cancel works | MISSING (staging); cancel fix F-M18 unit-tested |
| F-4 | Hermes prompt | BLOCKED (model provider quota) |
| F-5 | Policies and approvals end to end | MISSING (staging) |
| F-6 | Reconnect after the 60-min Cloud Run cut (app + connector) | IMPLEMENTED_NOT_VERIFIED (unit-tested app side) |
| F-7 | Audit trail complete and redacted | VERIFIED (emulator, A-8); staging pending |

## Data

| # | Gate | Status |
|---|---|---|
| D-1 | Migration tooling tested | VERIFIED (emulator, 22 tests) |
| D-2 | Staging rehearsal: export → import → reconcile `ok: true` | BLOCKED (Supabase key + staging project) |
| D-3 | Password-only users can sign in with Google after import | MISSING (staging) |
| D-4 | Fresh `pg_dump` taken immediately before cutover | MISSING (at cutover) |

## Operations

| # | Gate | Status |
|---|---|---|
| O-1 | Projects: dev / staging / prod, Blaze, budget alerts | BLOCKED (owner console steps, D1/D5) |
| O-2 | Firestore DB in `asia-south1`, rules, indexes and TTL policies deployed | MISSING |
| O-3 | `api` and gateway deployed, smoke tests pass (DEPLOYMENT.md) | MISSING |
| O-4 | Rollback rehearsed on staging (ROLLBACK_PLAN.md) | MISSING |
| O-5 | Monitoring and alerts (COST_AND_QUOTAS.md §6) | MISSING |
| O-6 | Gateway capacity test (1 instance, target sockets) | MISSING |
| O-7 | Cost estimate priced against current pricing | PARTIAL (volumes derived; prices to verify) |
| O-8 | CI green on GitHub Actions (incl. Firebase jobs) | MISSING (not pushed) |
| O-9 | CI deploy via Workload Identity Federation, prod gated | MISSING |
| O-10 | Release keystore backed up off-host | BLOCKED (owner, from todo.md) |

## Known issues to clear or accept

| Priority | Issue |
|---|---|
| P1 | F-M1 plaintext pickup → connector 0.2.0 local credential generation |
| P2 | Connector policy sync every 60 s dominates Firestore reads (COST_AND_QUOTAS.md §2) |
| P2 | R8 in AGP 8.7.3 cannot parse Kotlin 2.4 metadata (warning) → upgrade AGP |
| P2 | `friday-gateway.service` still configured for Supabase (unused after cutover) |
| P3 | Android: output sent while the app is reconnecting is not recovered (UI warns) |
