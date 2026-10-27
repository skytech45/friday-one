# FRIDAY One — Firestore Data Model

Source of truth for collections, ownership, access and retention. The rules
live in [`firebase/firestore.rules`](../firebase/firestore.rules), the indexes
in [`firebase/firestore.indexes.json`](../firebase/firestore.indexes.json), and
the migration rationale in [FIREBASE_MIGRATION_PLAN.md](FIREBASE_MIGRATION_PLAN.md) §2.2.

## Principles

1. **Clients read, backends write.** The Android app reads owner-scoped
   documents (for example, live server status). Every write to
   security-sensitive state goes through a trusted backend (the `api` function
   or the gateway) using the Admin SDK, which bypasses rules, so those code
   paths carry their own authorization.
2. **`ownerId` on every owner-readable document.** Rules check
   `resource.data.ownerId == request.auth.uid` with no `get()`, which costs
   nothing extra and can't be confused by a cross-document lookup. A server's
   `ownerId` is copied into its subcollection documents at write time and
   never changes (ownership transfer is not a feature).
3. **IDs that make writes idempotent or lookups O(1):** credential and token
   documents are keyed by `sha256` of the secret; jobs by
   `sha256(serverId:idempotencyKey)`; agents by adapter name.
4. **Timestamps are server-generated** (`FieldValue.serverTimestamp()` in
   backends; `request.time` is enforced for the one client write).
5. **No streams in Firestore.** `chat.delta` output stays on the gateway's
   WebSocket. Jobs store only a bounded `resultSummary` (≤ 4 KiB, enforced by
   the gateway store; larger summaries become `{ truncated, bytes }`).
7. **Server IDs are UUIDs** (`randomUUID()`), because the realtime envelope
   schema requires `server_id` to be one.
6. **No secrets in ordinary documents,** with one bounded exception:
   `enrollments.credentialPickup` holds a freshly issued connector credential
   until the connector collects it (at most 30 min, deleted on pickup). The
   collection is unreadable to clients. Connector 0.2.0 removes this (plan §2.5).

## Collections

| Path | Fields (types) | Written by | Client access | Main queries / index |
|---|---|---|---|---|
| `users/{uid}` | `displayName` str ≤120, `email` str, `createdAt`, `updatedAt` ts | API (create on first call); owner (`displayName` only) | get own; update `displayName`+`updatedAt==request.time` | point read |
| `servers/{serverId}` | `ownerId`, `name` ≤120, `hostLabel`, `enrollmentState` (`pending`\|`active`\|`revoked`), `connectorId` (current credential id or null = rotation due), `lastSeenAt`, `createdAt`, `updatedAt` | API (create, revoke, rotate), gateway (`lastSeenAt`) | owner read | `ownerId ==` order `createdAt desc` |
| `servers/{id}/agents/{adapter}` | `agentId` (UUID used on the wire and in policies; v8 name-based for new agents, preserved for migrated ones), `ownerId`, `serverId`, `adapter` ≤40, `adapterVersion` ≤40, `capabilities` map, `health` (`unknown`\|`healthy`\|`degraded`\|`unreachable`), `discoveredAt`, `updatedAt` | gateway (`connector.hello`) | owner read | list per server |
| `servers/{id}/projects/{sha256(root)}` | `ownerId`, `serverId`, `canonicalRoot` ≤512, `label` ≤120, `createdAt` | gateway | owner read | list per server |
| `servers/{id}/jobs/{sha256(serverId:key)}` | `ownerId`, `serverId`, `idempotencyKey` ≤128, `operation` ≤200, `agentId`, `state` (`queued`…`cancelled`), `resultSummary` map ≤4 KiB, `createdAt`, `updatedAt`, `expireAt` | gateway | owner read | group: `ownerId ==` order `updatedAt desc` |
| `servers/{id}/permissionRequests/{id}` | `ownerId`, `serverId`, `connectorId`, `agentId`, `sessionId`, `operation`, `payloadHash` ≤128, `policyVersion`, `status`, `requestedAt`, `expiresAt`, `decidedBy`, `decidedAt`, `outcome` | gateway (create on `permission.requested`; decide in a transaction only if `pending` and unexpired) | owner read | `status ==` order `expiresAt` |
| `policies/{policyId}` | `ownerId`, `serverScope` (serverId or `"all"`), `agentId`, `projectId`, `action` ≤80, `executable` ≤256, `argumentPattern` map, `decision` (`allow`\|`deny`\|`require_approval`), `priority` int, `version` int, `enabled` bool, `expiresAt`, `createdAt`, `updatedAt` | API | owner read | list: `ownerId` order `createdAt`; sync: `ownerId`, `serverScope in [id,"all"]`, `enabled` order `priority` |
| `auditEvents/{autoId}` | `ownerId`, `actorId` (uid or `"connector:<credId>"`), `serverId`, `action` ≤120, `decision`, `correlationId`, `detail` map (redacted, unindexed), `createdAt`, `expireAt` | API, gateway | owner read | `ownerId ==` order `createdAt desc` |
| `connectorCredentials/{sha256(credential)}` | `credentialId`, `serverId`, `ownerId`, `createdAt`, `expiresAt`, `revokedAt`, `rotatedFrom` | API | none | point read by hash; `serverId ==` for revoke-all |
| `enrollments/{id}` | `serverId`, `ownerId`, `state`, `tokenExpiresAt`, `displayCodeHash`, `displayCodeExpiresAt`, `claimAttempts`, `credentialPickup` (see principle 6), `credentialPickedUpAt`, `createdAt`, `updatedAt`, `expireAt` | API | none | point read; `serverId ==` |
| `enrollmentTokens/{sha256(token)}` | `enrollmentId`, `expiresAt` | API | none | point read |
| `rateLimits/{bucket}` | `windowStart` ts, `count` int, `expireAt` | API (transaction) | none | point read |
| `appConfig/{key}` | `value` str, `updatedAt` | operator / deploy | none (served by `/health`) | point read |

## Relational constraints and their replacements

| Postgres guarantee | Firestore replacement |
|---|---|
| `unique (server_id, idempotency_key)` on jobs | deterministic doc ID + `create()` (fails if it exists) |
| `unique (server_id, adapter)`, `(server_id, canonical_root)` | deterministic doc IDs |
| `credential_hash unique` | the hash is the doc ID |
| FK `on delete cascade` (server → agents, jobs, …) | servers are never hard-deleted (revoke instead); retention deletes via TTL |
| Atomic `UPDATE … WHERE state = expected` (enrollment, permission decide, job cancel) | `runTransaction` read-check-write on the single document |
| `consume_rate_limit()` RPC | transaction on `rateLimits/{bucket}`, works across instances |
| CHECK constraints | validated in backend code (zod) before any write; rules allow no client writes to these fields |

A Firestore transaction covers documents, not the outside world. An agent
execution is never "inside" one. Job state moves through the same
`queued → dispatched → accepted → started → completed|failed|cancelled` steps,
each a separate conditional write.

## Retention (TTL on `expireAt`)

| Collection | Retention | Mechanism |
|---|---|---|
| `auditEvents` | 365 days | Firestore TTL policy on `expireAt` |
| `servers/*/jobs` | 90 days after last update | TTL |
| `servers/*/permissionRequests` | 30 days after expiry | TTL |
| `enrollments`, `enrollmentTokens` | 1 day after expiry or terminal state | TTL |
| `rateLimits` | window end + 1 h | TTL |

TTL policies are **not** set by `firebase deploy`. Create them once per project
(`gcloud firestore fields ttls update expireAt --collection-group=<name> --enable-ttl`);
see FIREBASE_SETUP.md. TTL deletion is best-effort (typically within 24 h), so
nothing relies on it for security. Expiry is always checked in code.

## Size and write frequency (per active server)

| Doc | Size | Writes |
|---|---|---|
| server | < 1 KiB | heartbeat-driven `lastSeenAt`: at most 1 write per 60 s **per server** (gateway `touchLastSeen`; heartbeats arrive every 15 s) |
| job | < 6 KiB | ~4–6 state writes per prompt |
| permission request | < 1 KiB | 2 per approval |
| audit event | < 2 KiB | 1–3 per user action |

Cost implications: [COST_AND_QUOTAS.md](COST_AND_QUOTAS.md) (to be written in Phase 11).
