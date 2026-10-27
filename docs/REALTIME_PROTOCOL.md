# FRIDAY One — Realtime Protocol v1

Status: **draft** — the connector scaffold (`connector/`) and the future
gateway implement THIS document. Version field in every message makes later
evolution explicit; unknown `event_type` values fail closed on the connector
for high-risk types (SYSTEM_DESIGN.md §6).

## 1. Transport

- Connector → gateway: **outbound** WSS (the server is never reachable
  inbound; this is what makes NAT/firewall setups work).
- Android → gateway: WSS with the Supabase access token.
- TLS required; **no bearer tokens in URLs** (the legacy terminal route's
  query-string token is grandfathered, not copied).
- Heartbeat every 15 s in both directions; 3 missed → close and reconnect.
- Reconnect: exponential backoff with full jitter, 1 s → 60 s cap. After
  reconnect, the client re-authenticates, then sends `resume` with its last
  `sequence`; the gateway replays durable-pending work, never blind replays.

## 2. Envelope

Every message is exactly this shape (JSON, UTF-8):

```json
{
  "protocol_version": 1,
  "message_id": "uuid",
  "correlation_id": "uuid",
  "server_id": "uuid",
  "connector_id": "uuid-or-null",
  "agent_id": "uuid-or-null",
  "session_id": "string-or-null",
  "event_type": "command.submit",
  "issued_at": "RFC3339",
  "expires_at": "RFC3339-or-null",
  "sequence": 123,
  "idempotency_key": "string-or-null",
  "payload": {}
}
```

Validation rules (gateway and connector, both directions):

1. `protocol_version` must be 1; anything else → close 4400.
2. `message_id` duplicates per authenticated identity are DROPPED silently
   (idempotent no-op) — enforced by the gateway replay guard (bounded LRU,
   10k ids/identity). Command execution is additionally idempotent via
   `command_jobs`.
3. `expires_at` in the past → reject `message_expired`, never execute.
4. `sequence` is enforced per authenticated identity by the gateway: the
   baseline is set from the AUTH message's sequence and every later message
   must be strictly greater. Stale/out-of-order sequence → close 4400
   `sequence_violation`. The baseline resets on a fresh authenticated
   connection, so a connector/app restart recovers; a replayed old
   privileged message on a live connection is rejected, and content-level
   idempotency (`command_jobs` unique key) covers replays arriving on a new
   connection.
5. `payload` schema-validated per `event_type`; unknown event types for
   high-risk classes (`command.*`, `permission.*`) → reject, fail closed.
6. `correlation_id` ties a response to its request; the originator matches it
   and discards orphans after their `expires_at`.

## 3. Event catalogue

| Event | Direction | Payload (beyond envelope) | Notes |
|---|---|---|---|
| `auth.connector` | C→G | `{ credential }` | first message after open; hash-checked against `connector_credentials` |
| `auth.resume` | C→G / A→G | `{ last_sequence }` | after reconnect |
| `connector.hello` | C→G | `{ connector_version, agents: [AgentInfo], projects: [{ root, label }] }` | sent after `auth.resume.ok` and again when a version is learned; gateway upserts `agents` + `projects` scoped to the credential's server |
| `connector.heartbeat` | C→G | `{ uptime_s }` | gateway updates `servers.last_seen_at` |
| `agent.discovered` | C→G | `{ agent_id, adapter, version, capabilities }` | reserved for incremental registry updates; `connector.hello` is the bulk path |
| `session.updated` | C→G | `{ session }` | status transitions only; content is pull/chat |
| `chat.delta` | C→G | `{ delta, seq, agent }` | streamed token/output deltas; bounded size |
| `terminal.output` | C→G | `{ chunk, seq }` | legacy PTY bridge; bounded, backpressured |
| `permission.requested` | C→G | `{ operation, payload_hash, policy_version, expires_at, context }` | persisted BEFORE the app is notified |
| `permission.decided` | G→C | `{ request_id, decision, decided_by, decided_at }` | connector revalidates locally before executing |
| `command.submit` | A→G | `{ operation, arguments, idempotency_key, expires_at }` | structured operation, NEVER a shell string; `arguments.agent` selects a reported adapter, unknown → `command.rejected{agent_not_available}`; a repeated `idempotency_key` for the same server is never dispatched again → `command.rejected{duplicate_request, job_id, state}` (Firebase gateway) |
| `command.accepted` / `command.started` | C→G | `{ job_id }` | acks with explicit state transitions |
| `command.completed` / `command.failed` | C→G | `{ job_id, result_summary }` | bounded summary; big output stays on the connector |
| `command.cancel` | A→G | `{ job_id }` | idempotent; cancelled jobs never resume |
| `connector.revoked` | G→C | `{ reason }` | gateway closes 4403; credential dead |

Close codes: `4400` protocol violation · `4401` unauthenticated · `4403`
revoked/unauthorized · `4529` capacity exceeded · `1011` internal error.

## 4. State machines

### Permission request (SYSTEM_DESIGN §9)

```
pending ──approve──▶ approved ──dispatch──▶ executing ──▶ completed │ failed
   │ ──deny──▶ denied            │
   │ ──expire──▶ expired         └──cancel──▶ cancelled
```

Rules encoded here and enforced in code + tests:
- transitions are one-way; repeats are idempotent no-ops;
- approval binds to (`request_id`, `payload_hash`, `policy_version`); any
  mismatch → the stored approval is void, a NEW request is required;
- `expires_at` is mandatory; expired approvals never execute;
- "approve once" never mutates a policy into a standing allow.

### Command job

```
queued → dispatched → accepted → started → completed | failed | cancelled
```

Unknown terminal state after reconnect → query the durable job row before
any retry (§13); retries are keyed by `idempotency_key` so a replayed submit
cannot execute twice.

## 5. Security requirements (restating invariants)

- The connector's credential is unique, revocable, and hashed at rest.
- Message-level authorization happens per sensitive event; a live socket is
  transport, not authorization (§16.5).
- Pub/sub is transient; Postgres is the durable source of truth (§16.6).
- Agent output is untrusted input to every renderer (terminal/HTML escaping,
  secret redaction).
- Backpressure and size caps on every stream (`chat.delta`, `terminal.output`).

## App reconnect (Android `GatewayClient`)

Cloud Run ends every WebSocket at its request timeout (≤ 60 min), so app
reconnects are routine:

- Retry with exponential backoff and full jitter: attempt *n* waits a random
  250 ms – min(30 s, 1 s·2^(n−1)); the counter resets after a successful
  `auth.resume.ok`.
- Every connect sends `auth.app` with a **freshly fetched** ID token.
- Two consecutive refusals (close 4401/4403 before `auth.resume.ok`) stop
  the loop; the UI asks the user to sign in again.
- Nothing is queued or replayed: a send while disconnected fails, so a
  dropped socket can never execute a prompt twice. Events sent during the
  gap are not recovered; the UI says so if a job was running.
- `sequence` keeps increasing across sockets of one client; the gateway sets
  a new replay baseline on each `auth.app`.
