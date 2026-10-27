# FRIDAY One — Data Migration (Supabase → Firebase)

Tool: [`firebase/migrate/`](../firebase/migrate/) (`src/cli.mjs`). Plan context:
[FIREBASE_MIGRATION_PLAN.md](FIREBASE_MIGRATION_PLAN.md) §4.
**Status:** built and tested on the emulators with a synthetic snapshot.
**Never run against the real Supabase or Firebase projects yet.**

## 1. Pipeline

```text
export ──▶ snapshot dir ──▶ plan ──▶ plan.json (review) ──▶ import ──▶ reconcile
(read-only)  (JSON + manifest   (pure     (users + docs +       (idempotent)  (M-1 gate)
             with sha256)       transform)  report)
```

| Step | Command | Writes to |
|---|---|---|
| export | `SUPABASE_URL=… SUPABASE_SECRET_KEY=… node src/cli.mjs export --out <dir>` | local dir only (0600 files) |
| plan | `node src/cli.mjs plan --snapshot <dir> --out plan.json` | local file; exit 2 if any record failed validation |
| import (dry run) | `node src/cli.mjs import --plan plan.json --project <id> --dry-run` | nothing (reads only) |
| import | `… import --plan plan.json --project <id> --confirm-project <id>` | Firebase Auth + Firestore |
| reconcile | `… reconcile --plan plan.json --project <id>` | nothing; exit 1 unless everything matches |

Credentials: Application Default Credentials. No key file is read. Writing
to any non-`demo-*` project requires `--confirm-project` with the same ID
(verified: without it the CLI refuses and exits 1).

## 2. Identity mapping

| Source | Firebase | Notes |
|---|---|---|
| `auth.users.id` (UUID) | Firebase **UID = same UUID** | every `ownerId` stays valid; nothing is rewritten |
| Google identity (`identity_data.sub`) | provider `google.com` with the same Google `sub` | the same Google account signs in to the same UID (**verified on the emulator**) |
| Email/password-only user | account with email, **no provider, no password** (D2) | flagged in the report; must sign in with Google using the same email. Account linking behaviour **must be verified in staging** before production |
| Existing Firebase UID | skipped, never overwritten | idempotent re-runs |

## 3. Table mapping and rules

| Table | Destination | Rule |
|---|---|---|
| profiles | `users/{uid}` | one per auth user; missing rows synthesized (counted separately) |
| servers | `servers/{id}` | fails if the owner is not in the auth export |
| connector_credentials | `connectorCredentials/{hash}` | hash must be sha256 hex; **existing connectors keep working without re-pairing** (verified) |
| agents | `servers/{id}/agents/{adapter}` | **UUID kept as `agentId`** (the agent-ID map is in `plan.agentIdMap`); duplicate or invalid adapter names fail |
| projects | `servers/{id}/projects/{sha256(root)}` | |
| permission_policies | `policies/{id}` | `serverScope` = server or `all`; `projectRoot` resolved from `project_id`; a policy on another owner's server fails |
| command_jobs | `servers/{id}/jobs/{sha256(server:key)}` | gateway's ID scheme; old ID kept as `legacyId`; summary ≤ 4 KiB |
| permission_requests | `servers/{id}/permissionRequests/{uuid without dashes}` | **pending → expired** at cutover; IDs fit the gateway's format |
| audit_events | `auditEvents/legacy-{id}` | owner from the actor, else the server owner; ownerless rows skipped; secret-looking `detail` keys removed |
| enrollments | **not migrated** | in-flight pairings re-pair; also keeps plaintext pickups (F-M1) out of the snapshot (count only, via `HEAD`) |
| pairing_codes, rate_limit_hits, agent_sessions, chat_messages, app_config | **not migrated** | counted and reported with a reason |

Every table satisfies `source = planned + skipped + failed` (tested).

## 4. Idempotency and drift

- `import` uses `create()`: a re-run reports `existing` and never overwrites
  data written since (verified: a live `lastSeenAt` update survived a re-run).
- `--overwrite` uses `set()`, for a deliberate re-import into a fresh project.
- `reconcile` compares counts plus critical fields (owner, enrollment state,
  credential binding and revocation, policy decision, enabled and version, job
  and approval state, audit owner). It detected a changed `ownerId` and a
  deleted policy in tests, and was clean again after `--overwrite`.

## 5. Cutover runbook (each production step needs your authorization)

1. Staging: export → plan → review `failed` and `flagged` → import → reconcile
   → run the app and connector against staging (E-1).
2. Test rollback (ROLLBACK_PLAN.md, to be written).
3. Freeze: stop the Vercel API (maintenance) and the old gateway.
4. Final `pg_dump` (backup), then export → plan → dry run → import →
   reconcile on prod. Reconcile must report `ok: true`.
5. Set `appConfig/gateway_url`, switch connector URLs, release the Firebase app build.
6. Keep Supabase and Vercel read-only for the rollback window (30 days),
   then delete the snapshot and retire them (only with your authorization).

## 6. Handling the snapshot

It contains emails (personal data) and credential **hashes**. Keep it
outside the repo (`firebase/migrate/.gitignore` covers `out/` and
`*.snapshot/`), on an encrypted disk, and delete it after the rollback window.

## 7. Test evidence (2026-10-27)

| Suite | Result |
|---|---|
| `test/transform.test.mjs` (pure) | 13/13 |
| `test/export.test.mjs` (fake Supabase: paging over 1,000 rows, HEAD counts, tamper detection, bad key) | 3/3 |
| `test/import.test.mjs` (Auth + Firestore emulators; dry run, import, reconcile, idempotent re-run, end-to-end with the `/api/v1` code, drift + repair) | 6/6 |
