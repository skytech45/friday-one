# FRIDAY One — Firestore Security Rules

Rules: [`firebase/firestore.rules`](../firebase/firestore.rules) · Tests:
[`firebase/rules-tests/rules.test.mjs`](../firebase/rules-tests/rules.test.mjs)
· Data model: [FIREBASE_DATA_MODEL.md](FIREBASE_DATA_MODEL.md)

## Policy in one paragraph

Default deny. A signed-in user may **read** documents whose `ownerId` is their
UID (servers and their agents, projects, jobs and permission requests;
policies; audit events) and their own `users/{uid}` profile. The **only**
client write is updating their own `displayName`, stamped with the server
time. Credentials, enrollments, enrollment tokens, rate limits and app config
are unreadable and unwritable from clients. Every other write happens in
trusted backends through the Admin SDK, which **bypasses these rules**, so
those code paths must authorize every operation themselves (functions/,
gateway/).

## Why reads are allowed at all

The `/api/v1` HTTP API stays the primary read path. Owner-scoped reads let
the app add **bounded** live listeners later (for example on
`servers where ownerId == me` for online status) without another backend
round trip. Nothing sensitive is readable: credential hashes, enrollment
secrets and rate-limit state live in client-closed collections.

## What the rules deliberately do not do

- **Validate backend writes.** The Admin SDK skips rules. Schema validation
  for those writes is zod in `functions/` and `gateway/`.
- **Check App Check.** App Check enforcement for Firestore is a project
  setting (console or API), not a rules expression. See plan Phase 5.
- **Check revocation for reads.** An owner can still read a revoked server's
  history, by design. Revocation is enforced where it matters: credential
  lookups in the API and the gateway.

## Test coverage (34 cases, R-1…R-12)

| Group | Proves |
|---|---|
| R-1 | Unauthenticated: no reads, lists or creates |
| R-2/R-3 | Owner get and owner-filtered list work; cross-user get, unfiltered list and filtering on another user's ID fail |
| R-4 | No client create/update/delete on `servers`: no self-enrollment, state flips, connector rebinding, heartbeat spoofing or ownership change |
| R-5 | Subcollections are owner-read only; **approval tampering** (status, decidedBy, payloadHash) and forged requests or jobs fail |
| R-6 | Collection-group job history is owner-scoped |
| R-7 | Policies: owner read only; create/update/delete fail even for the owner (CRUD goes through the API) |
| R-8 | Audit events cannot be forged, altered or deleted |
| R-9 | Backend-only collections are closed even when the doc carries the user's `ownerId` |
| R-10 | Profile: own get; only `displayName` + `updatedAt == request.time`; length bounds; no create, delete, list or cross-user edit |
| R-11 | Revoked server: history readable, reactivation impossible |
| R-12 | Unknown collections denied |

**Mutation check (2026-10-27):** changing `servers` to
`allow write: if ownsExisting()` makes 4 tests fail (R-4 ×3, R-11). The suite
detects a permissive regression, not just syntax.

## Running

```bash
cd firebase/rules-tests
npm ci --ignore-scripts
npm test            # firebase-tools 15: requires JDK 21+
```

On a machine with only JDK 17, firebase-tools 13 runs the same suite:

```bash
npx -y firebase-tools@13 emulators:exec --config ../firebase.json --project demo-friday-one --only firestore "node --test rules.test.mjs"
```

CI job `firestore-rules` runs `npm test` on Temurin 21.

## Changing the rules

1. Change `firestore.rules` **and** add or adjust a test in the same commit.
2. Run the suite; for any loosening, also run a mutation check like the one above.
3. Deploy only via `firebase deploy --only firestore:rules --project <alias>`
   (the default alias is a demo project and cannot deploy).
