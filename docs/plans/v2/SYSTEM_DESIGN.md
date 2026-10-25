# FRIDAY One --- Updated System Design

**Version:** 2.0 · Target architecture

## 1. Purpose and invariants

FRIDAY One lets an authenticated user register Linux VPS/cloud servers
and manage supported AI-agent sessions from Android. A FRIDAY Connector
is installed per server and connects outbound to a realtime gateway.

Invariants: 1. No privileged backend secrets in Android. 2. Google
passwords are never collected or stored by FRIDAY One. 3. Supabase
provides identity and durable user-owned data. 4. Vercel is the control
plane, not the target machine's shell. 5. Connector is the final local
execution gate. 6. QR/numeric pairing is temporary, single-use and not a
permanent credential. 7. Each connector has a unique revocable identity.
8. Durable database state is authoritative over transient realtime
delivery. 9. Sensitive operations are authorized remotely and checked
locally. 10. Unknown sensitive actions fail closed. 11. Agent
capabilities are verified, versioned and explicit. 12. Pairing proves
connector enrollment, not legal ownership of the provider account.

## 2. Components

### Android

Kotlin, Jetpack Compose, MVVM/repository. Google OAuth through Supabase
Auth, HTTPS API, WSS events, QR scanner/numeric pairing input, server
dashboard, connector health, agent/session/chat UI, permission inbox,
policy editor and audit view. Protect local credentials and safely
render bounded untrusted terminal output.

### Supabase

Auth for user identity and session lifecycle. PostgreSQL stores
profiles, servers, enrollments, connector credential metadata, agents,
projects, sessions, messages/references, policies, permission requests,
command jobs and audit events. Apply RLS to every client-exposed
user-owned table. Service-role/secret keys remain server-side.

### Vercel control plane

Verify Supabase access tokens; derive user ID from verified claims;
enforce ownership/capabilities; create and claim enrollment;
issue/revoke connector identity; manage policies and durable
command/approval metadata; query audit events; validate payloads,
rate-limit and redact logs. Never provide an arbitrary shell-forwarding
API.

### GitHub releases

CI builds versioned connector artifacts for supported architectures,
publishes checksums and preferably signatures/attestations, changelog
and platform matrix. Installer pins version and verifies integrity
before installation. Define signing-key rotation and rollback.

### FRIDAY Connector

Per-server Linux service under a dedicated unprivileged account. Unique
identity, outbound WSS, agent discovery, adapter management, process/PTY
lifecycle, local project/command policy enforcement, cancellation,
bounded output, acknowledgements, redacted logs, rotation/revocation and
systemd supervision.

### Realtime gateway

Authenticated WSS for Android and connector, message-level
authorization, routing and backpressure. Shared messaging routes across
instances. PostgreSQL stores durable command/approval/audit state.
Validate current Vercel WebSocket/runtime/plan constraints; if
unsuitable, host the gateway as a long-running service without changing
protocol.

### Agent adapters

Separate Hermes, OpenCode and custom adapters. Each declares
capabilities, version compatibility and limitations. Unsupported
operations return explicit errors; no fake capability parity.

## 3. Topology

``` text
Android FRIDAY One
  | HTTPS + WSS
  v
Vercel Control Plane <----> Supabase Auth + PostgreSQL/RLS
  |
  | authenticated routing / shared message bus
  v
Realtime Gateway
  ^
  | outbound WSS
  |
Linux VPS: FRIDAY Connector (systemd, unprivileged)
  |-- Hermes adapter
  |-- OpenCode adapter
  `-- Custom adapters
```

## 4. Threat model and boundaries

Assets: identity/session tokens, connector credentials, VPS association,
project files, commands, chat/terminal data, policies, approvals and
audit events.

Threats: unauthenticated attacker, cross-account user, stolen
phone/session, leaked pairing code, compromised connector, malicious
agent output, tampered release, misconfigured RLS or leaked server
secret.

Boundaries: - Android/API: client is untrusted; verify token and
ownership. - Android/gateway: authenticate connection and authorize each
message. - Vercel/Supabase: secrets server-side; RLS and API
authorization both matter. - Gateway/connector: identity binding,
expiry, replay protection and strict routing. - Connector/agent: least
privilege, path/argument validation and resource limits. -
GitHub/installer: verify artifact integrity/signature and pinned
version. - Agent output/UI/logging: treat as untrusted, escape output
and redact secrets.

## 5. Google OAuth and Supabase flow

1.  User selects Google sign-in.
2.  Android starts the supported OAuth/PKCE flow and returns through a
    verified redirect/deep link.
3.  Supabase Auth creates/restores the user session.
4.  Android sends access token to Vercel over HTTPS/WSS.
5.  Vercel verifies token and derives user ID from verified claims.
6.  Server queries return only records authorized for that user.

Never collect Google passwords. Validate redirect configuration, handle
expiry/logout/revocation, and require reauthentication for sensitive
operations where appropriate. Gmail identity alone does not prove VPS
ownership.

## 6. GitHub release and installation protocol

### Release assets

-   Immutable version tag and changelog.
-   Architecture-specific binaries/packages.
-   SHA-256 checksums.
-   Signature/attestation where supported.
-   Supported OS/architecture matrix.
-   Installer, upgrade, rollback and uninstall documentation.

### Installer steps

1.  Validate version, OS and architecture.
2.  Download exact release over HTTPS.
3.  Verify checksum and signature against trusted key/chain.
4.  Abort on mismatch.
5.  Create restricted service account/directories.
6.  Install files with least-privilege permissions.
7.  Create hardened systemd unit (NoNewPrivileges, reduced capabilities,
    filesystem restrictions where compatible).
8.  Start service and verify status/version.
9.  Enter enrollment mode and print temporary QR/code.
10. Never print permanent connector credential.
11. Support status, upgrade, rollback, revoke and uninstall.

Installer may require sudo for system user/service creation; explain it.
Do not run connector as root by default. Avoid an unpinned mutable
`curl | bash` default.

## 7. Enrollment and QR/numeric code state machine

States:
`created -> pending_connector -> claim_requested -> paired -> online`;
terminal/error states: `expired`, `cancelled`, `rejected`, `revoked`,
`error`.

Flow: 1. Authenticated app creates owner-bound pending enrollment. 2.
App shows version-pinned install command. 3. Connector installs and
starts enrollment mode. 4. Terminal displays QR plus 16--20 digit
one-time numeric code. 5. QR and code map to the same pending
enrollment. 6. App submits claim; backend verifies user, expiry, attempt
count and one-time status. 7. Connector proves possession of enrollment
challenge over authenticated outbound channel. 8. Backend atomically
consumes temporary credential and issues connector-specific
identity/credential. 9. Connector reconnects with new identity and sends
authenticated hello. 10. Backend checks connector/server association,
version and health. 11. App shows Paired/Online only after successful
acknowledgement/health verification.

Code requirements: - CSPRNG generation. - Short expiry (initial target
5--10 minutes). - Single-use, rate-limited and invalid after expiry. -
Hash stored where practical; raw code never logged or sent to
analytics. - QR contains opaque temporary token only, never permanent
secret. - Claim bound to account that created enrollment. - No
client-supplied owner ID. - Race-safe atomic consumption; two concurrent
claims cannot both succeed. - Pairing only enrolls connector; it does
not authorize shell commands. - A pairing code cannot prove legal
ownership of a provider account.

## 8. Connector identity lifecycle

Each connector has stable random ID, one-server association, unique
credential/key identity, issue/expiry/rotation/revocation metadata and
version. Store local credentials with restrictive OS permissions or
suitable secret store. Support rotation and revocation; revocation must
reject reconnect and close active control sessions where possible.
Reinstall or lost connector state requires fresh pairing. A connector
cannot change its server association by editing message fields.

## 9. Realtime transport and envelope

Use outbound WSS from connector and WSS from Android. This avoids a
public inbound control port on the VPS. Validate Vercel runtime limits;
move gateway to a long-lived service if required.

Example envelope:

``` json
{
  "protocol_version": 1,
  "message_id": "uuid",
  "correlation_id": "uuid",
  "server_id": "uuid",
  "connector_id": "uuid",
  "agent_id": "uuid-or-null",
  "session_id": "string-or-null",
  "event_type": "command.submit",
  "issued_at": "RFC3339",
  "expires_at": "RFC3339-or-null",
  "sequence": 123,
  "idempotency_key": "opaque-or-null",
  "payload": {}
}
```

Requirements: TLS validation, no tokens in URLs, connection auth plus
message authorization, size/rate/concurrency limits, heartbeat, bounded
reconnect with jitter, sequence/cursor, acknowledgements, idempotency,
replay protection, backpressure and reconnect reconciliation. Persist
command/approval/audit before dispatch. Pub/sub is transient; PostgreSQL
is authoritative. Never blindly replay commands.

## 10. Policy and approval engine

Policy dimensions: server, connector, agent/type, project/canonical
root, action/capability, executable/validated arguments, scope/duration
and policy version. Decisions: `allow`, `deny`, `require_approval`.

Evaluation: 1. Validate schema and capability. 2. Verify
user/connector/server association. 3. Resolve project root and reject
path escape. 4. Apply explicit applicable deny. 5. Apply documented
deterministic priority/specificity. 6. Unmatched sensitive operations
deny or require approval. 7. Bind decision to request and policy
version. 8. Connector rechecks immediately before execution.

Do not use naive command-prefix matching. Shell chaining, substitutions,
redirection, environment changes and symlinks can bypass simplistic
rules. Prefer structured operations, exact executable allowlists,
argument validation, timeouts and least privilege. Root escalation,
credential access, destructive operations and unrestricted shell are
high-risk.

Approval binds to request ID/version, server, connector, agent, project,
operation/arguments or payload hash, policy version, expiry, nonce and
authenticated approver. Changed request means new approval; replay
cannot execute twice. "Approve once" cannot silently become permanent
allow. If an agent lacks reliable permission interception, mark
unsupported or use a genuinely enforceable wrapper.

## 11. Database model

-   `profiles`: minimal profile/preferences.
-   `servers`: owner, name, enrollment state, connector ID,
    health/version/last-seen.
-   `enrollments`: owner, server, hashed token/code, nonce, expiry,
    attempts and state.
-   `connector_credentials`: hash/key reference and lifecycle/revocation
    metadata.
-   `agents`: adapter/version/capabilities/health.
-   `projects`: server/agent association and protected canonical root.
-   `agent_sessions`: IDs, project, status and timestamps.
-   `chat_messages`: bounded content or protected reference, only where
    supported.
-   `permission_policies`: scope, rules, decision, version, expiry.
-   `permission_requests`: exact request, payload hash, policy version,
    expiry, state, approver/outcome.
-   `command_jobs`: idempotency key, typed operation, state, timestamps,
    bounded result.
-   `audit_events`: actor, target, decision, timestamp, correlation and
    redacted metadata.

Use RLS, foreign keys, indexes, retention/deletion policy and
migrations. Do not store reusable plaintext connector secrets in
ordinary rows.

## 12. API surface

Representative routes: - `POST /api/v1/enrollments` -
`GET /api/v1/enrollments/:id` - `POST /api/v1/enrollments/:id/claim` -
connector-authenticated enrollment confirmation -
`GET /api/v1/servers` - `GET /api/v1/servers/:serverId` -
`POST /api/v1/servers/:serverId/revoke` -
`GET /api/v1/servers/:serverId/agents` - session
list/read/message/cancel routes - policy CRUD/version/revoke routes -
permission list/decision routes - job status/cancel routes - audit
query - WSS realtime endpoint

Every endpoint validates schema, authentication, ownership/capability,
payload size, rate limits and idempotency. Never trust `owner_id` from
the body.

## 13. Adapter contract

Conceptual internal interface:

``` ts
interface AgentAdapter {
  discover(): Promise<AgentInfo[]>;
  listSessions(): Promise<SessionInfo[]>;
  getSession(sessionId: string): Promise<SessionInfo>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  getPendingPermissions(): Promise<PermissionRequest[]>;
  respondToPermission(
    requestId: string,
    decision: "allow" | "deny"
  ): Promise<void>;
}
```

This is an abstraction, not a claim every agent natively supports these
methods. Adapters map to actual verified interfaces and declare
capability flags and compatible versions. Custom adapters require
conformance tests and must not run with elevated privileges.

## 14. Failure behavior

-   Invalid release integrity: abort install.
-   Unsupported OS: abort clearly.
-   Expired/reused pairing: reject; require new enrollment.
-   Connector offline: show Offline/Last seen, not success.
-   Auth expired: reauthenticate.
-   Reconnect: reconcile durable state.
-   Unknown command status: query job before retry.
-   Stale approval: reject.
-   Database unavailable: do not execute actions requiring durable
    approval/audit.
-   Policy service unavailable: fail closed.
-   Connector revoked: reject reconnect.
-   Unsupported agent capability: explicit error.
-   Output flood: backpressure, limits and cancellation.

## 15. Observability, testing and deployment

Track connector heartbeat, version, pairing failures, reconnects,
command latency, permission outcomes, adapter errors and event lag. Use
correlation IDs and redacted logs. Do not log secrets or unrestricted
terminal output. Configure backups, restore drills, migrations,
credential rotation and staged connector releases.

Tests: OAuth lifecycle; RLS/IDOR; tampered release rejection; installer
idempotency/least privilege/rollback; pairing expiry/one-time/rate
limit/wrong account/replay; credential rotation/revocation; WSS
auth/routing/reconnect/backpressure; policy precedence/stale approval;
shell injection/path traversal/symlink escape; end-to-end login →
install → QR pairing → health → agent session → permission decision →
revocation; APK/log secret scans.

Deployment: Vercel APIs in separate environments; Supabase
migrations/RLS/backups; gateway on Vercel only if verified fit,
otherwise dedicated long-running service; shared message routing;
systemd connector; signed Android release; documented
install/upgrade/revoke/uninstall/recovery/rollback.

## 16. Release security criteria

-   No privileged key in APK/client logs.
-   No cross-user access.
-   No shared connector secret.
-   Tampered release rejected.
-   Pairing code expires and is one-time.
-   Pairing does not grant shell access.
-   Connector enforces local policy.
-   Replayed approval cannot repeat execution.
-   Revocation ends authorization.
-   Unsupported native agent permission control is not misrepresented.
-   No unresolved Critical/High findings before release.
