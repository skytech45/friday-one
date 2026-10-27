# FRIDAY One — Rollback Plan (Firebase cutover)

**Status:** written, **not yet rehearsed**. A rollback drill on staging is
a release gate (PRODUCTION_READINESS_CHECKLIST.md, item O-4).

## 1. Principle

Until the operator retires it, the legacy stack (Vercel API + Supabase +
host gateway) is left **intact and read-only**, never deleted or modified
by the migration. The migration never writes to Supabase (export is
GET/HEAD only). Rollback therefore means pointing clients back, not
restoring data.

## 2. When to roll back

Roll back if, after cutover, any of these holds and cannot be fixed forward
within the agreed window (default: 2 hours):

- users cannot sign in, or the app cannot list servers;
- paired connectors cannot sync or reconnect;
- an authorization failure: any cross-user read or command;
- reconciliation (`friday-migrate reconcile`) reports missing or mismatched records that cannot be repaired with `--overwrite`;
- gateway instability (crash loop, sustained 5xx from `api`).

## 3. Steps (operator)

| # | Action | Command / place | Time |
|---|---|---|---|
| 1 | Announce the maintenance window | — | — |
| 2 | Stop new writes to Firebase: set `api` `maxInstances` to 0 (or deploy a maintenance build), scale the Cloud Run gateway to 0 | `gcloud run services update friday-gateway --max-instances 0 --min-instances 0 --region asia-south1` | minutes |
| 3 | Re-enable the Vercel API (undo its maintenance mode) | Vercel dashboard / `control-plane/deploy.py` | minutes |
| 4 | Start the legacy gateway and tunnel | `sudo systemctl start friday-gateway friday-gw-tunnel` (DEPLOY.md) | minutes |
| 5 | Point connectors back | `/etc/friday-connector/env`: old `FRIDAY_CONTROL_PLANE_URL` + `FRIDAY_GATEWAY_URL`; `systemctl restart friday-connector` | per VPS |
| 6 | App | release builds still default to `AUTH_PROVIDER=supabase`; if a Firebase release shipped, publish the previous release build | store / sideload |
| 7 | Verify | sign in, list servers, pair test VPS, run a prompt, revoke | 15 min |

Connectors keep working after step 5 without re-pairing: their credential
hashes still exist in Supabase.

## 4. Data written after cutover

Rollback does **not** copy Firebase data back. What is lost or diverges:

| Data | Impact | Mitigation |
|---|---|---|
| New pairings | servers paired on Firebase are unknown to Supabase | re-pair those servers |
| Revocations | a server revoked on Firebase is **active again** in Supabase | **security**: re-revoke from the app on the legacy stack, using the `auditEvents` list of `server.revoked` after cutover (step 7b below) |
| Rotated credentials | Supabase still accepts the pre-rotation credential | re-trigger rotation, or re-pair |
| Policy edits | lost | re-apply from the `policy.*` audit events |
| Jobs, approvals, audit | history only | export from Firestore for the record |

**7b (mandatory if any revocation happened after cutover):** list
post-cutover revocations from Firestore (`auditEvents` where
`action == "server.revoked"` and `createdAt > cutover`) and revoke the same
servers on the legacy stack **before** restoring connector traffic.

Keeping the cutover short (freeze → import → verify) keeps this list small.

## 5. Roll forward again

Fix the cause, then repeat DATA_MIGRATION.md §5 from step 3 with a fresh
export. The import is idempotent; use `--overwrite` only on a project you
intend to replace wholesale.

## 6. Retirement (point of no return)

Only after the rollback window (default 30 days) **and** with explicit operator
authorization: delete the Vercel project, decommission the host gateway and
tunnel units, take a final `pg_dump` for the archive, then pause and delete
the Supabase project, and delete the migration snapshot. After that, this
plan no longer applies.
