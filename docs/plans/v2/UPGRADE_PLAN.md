# FRIDAY One --- Updated Full Upgrade Plan

Version 2.0 · Target implementation plan. Audit the existing repository
before changing code.

## 1. Objective

FRIDAY One is an Android app for managing AI agents on a user's own
SSH-accessible VPS/cloud servers. The user signs in with Google through
Supabase Auth, installs a verified FRIDAY Connector release from GitHub,
pairs it using a terminal QR code or 16--20 digit one-time code, and
manages supported agents such as Hermes and OpenCode.

The intended setup: 1. Sign in to the Android app with Google OAuth
through Supabase Auth. 2. Select **Add Server**. The app creates a
pending enrollment bound to the authenticated account. 3. SSH into the
target VPS independently and run the version-pinned installation command
shown in the app. 4. The installer checks OS/architecture, downloads an
exact GitHub release and verifies its checksum/signature before
installation. 5. It installs FRIDAY Connector as a restricted systemd
service and prints a temporary QR code and one-time numeric code. 6. The
user scans the QR or enters the code in the logged-in app. 7. Vercel
validates owner, expiry, one-time use and attempt limits. 8. Connector
proves possession of the enrollment challenge, receives a unique
revocable identity and establishes outbound WSS. 9. Backend verifies
connector/server association, version and health before the app shows
**Online**.

This proves a valid connector has been paired to an authenticated
account and is running on the server where installed. It does not prove
legal ownership of the VPS provider account.

## 2. Architecture decisions

-   **Android:** Kotlin, Jetpack Compose, MVVM/repository pattern unless
    repository audit justifies change.
-   **Login:** Google OAuth via Supabase Auth. Never collect or store
    Google passwords.
-   **Data:** Supabase PostgreSQL + Row Level Security (RLS).
-   **Control plane:** Vercel APIs for token verification, ownership
    checks, enrollment, policies, commands metadata and audit.
-   **Release distribution:** Versioned GitHub Releases with checksums
    and preferably signatures/attestation.
-   **Server runtime:** Per-server FRIDAY Connector, restricted Linux
    user, systemd.
-   **Pairing:** QR + numeric one-time code, short expiry, one-time
    redemption, rate limits and connector-specific credentials.
-   **Realtime:** Outbound WSS from connector and WSS from Android to an
    authenticated gateway; shared message routing for multiple gateway
    instances; PostgreSQL as durable source of truth.
-   **Agents:** Hermes, OpenCode and future custom adapters with
    explicit capability declarations.
-   **Policies:** Per-agent, per-project and per-command/action rules
    enforced at the connector.
-   **Secrets:** No Supabase secret/service-role key, Vercel secret,
    connector credential or SSH private key in Android or public GitHub
    artifacts.
-   **Default security:** Unknown sensitive actions fail closed; no
    unrestricted shell by default.

## 3. GitHub release and installer

### Release assets

Publish immutable, versioned artifacts for supported architectures (for
example Linux amd64 and arm64), installer, SHA-256 checksums,
signature/attestation where supported, changelog and supported OS
matrix. The app should generate a version-pinned install command. Do not
silently install mutable `latest` without integrity verification.

### Installer behavior

1.  Validate requested version, OS and architecture.
2.  Download the exact artifact over HTTPS.
3.  Verify checksum and, preferably, signature against a trusted
    verification key.
4.  Abort if verification fails.
5.  Create a dedicated non-login service user and restricted
    directories.
6.  Install binary/config with least-privilege permissions.
7.  Create a hardened systemd unit with capability reduction and
    compatible filesystem restrictions.
8.  Start service and verify health/version.
9.  Enter enrollment mode and print temporary QR/code only.
10. Never print permanent credentials.
11. Provide `status`, `upgrade`, `rollback`, `revoke` and `uninstall`.
12. Make install/upgrade idempotent and document any `sudo` requirement.

Do not make an unpinned mutable `curl | bash` the default. If a
one-command install is provided, it must verify a pinned artifact before
executing it.

## 4. QR and numeric pairing protocol

### UX

The terminal displays a QR code and a 16--20 digit one-time code. Both
resolve to the same pending enrollment. The app must already be
authenticated and should show the server label and remaining expiry
before the user confirms.

### Security properties

-   Generate codes/tokens with a cryptographically secure random source.
-   Initial expiry target: 5--10 minutes, configurable server-side.
-   Single-use, rate-limited and invalid after expiry.
-   Store a hash of the code/token where practical.
-   Never log raw code or send it to analytics.
-   QR contains an opaque temporary token/pairing URL, never a permanent
    connector secret.
-   Bind claim to the authenticated account that initiated enrollment.
-   Never trust client-supplied `owner_id`.
-   Pairing only enrolls the connector; it does not grant shell access.
-   Failed, expired, reused, guessed or wrong-account claims fail.
-   Connector must prove possession of the enrollment challenge before
    final pairing.
-   Backend atomically consumes the token and issues a unique, revocable
    connector credential.
-   App shows **Paired/Online** only after connector handshake and
    health verification.

Suggested flow: 1. `POST /api/v1/enrollments` creates an owner-bound
pending record. 2. Connector enters enrollment mode and obtains a
short-lived challenge. 3. Terminal renders QR/code. 4. App calls
`POST /api/v1/enrollments/:id/claim`. 5. Backend checks verified user,
state, expiry and attempt limit. 6. Connector confirms the challenge
over its authenticated outbound channel. 7. Backend atomically marks
paired and issues connector-specific identity/credential. 8. Connector
reconnects using its new identity and reports version/health.

Exact endpoint shapes may be adapted after the repository audit, but the
state machine and security properties are mandatory.

## 5. Google Auth and data security

-   Configure Google OAuth and verified Android redirect/deep-link URIs
    using the supported Supabase flow.
-   Supabase Auth handles identity and session lifecycle; FRIDAY One
    never asks for the Google password.
-   Vercel verifies access tokens server-side and derives the user ID
    from verified claims.
-   RLS applies to every user-owned client-accessible table.
-   API authorization checks ownership on every
    server/session/policy/command operation.
-   Keep service-role/secret keys server-side only.
-   Do not store reusable plaintext connector credentials in
    user-readable rows.
-   Implement logout, token expiry, account recovery, server revocation
    and account/data deletion behavior.

Proposed tables: `profiles`, `servers`, `enrollments`,
`connector_credentials`, `agents`, `projects`, `agent_sessions`,
`chat_messages` or protected references, `permission_policies`,
`permission_requests`, `command_jobs`, `audit_events`. Use UUIDs,
timestamps, foreign keys, indexes, migrations, retention rules and
rollback instructions.

## 6. Realtime transport

Use authenticated WSS from connector to gateway and from Android to
gateway. The connector initiates outbound connections so the VPS does
not need a public inbound control port.

Validate current Vercel WebSocket support, connection duration,
concurrency, scaling behavior and pricing against the actual plan. Use a
shared messaging layer for cross-instance routing. PostgreSQL is the
durable source of truth. If Vercel is unsuitable for long-lived
connections, move only the gateway to a dedicated long-running service.

Protocol fields should include `protocol_version`, `message_id`,
`correlation_id`, `server_id`, `connector_id`, optional
`agent_id`/`session_id`, `event_type`, timestamps, expiry,
sequence/cursor and idempotency key.

Requirements: - TLS validation; no bearer tokens in URLs. - Authenticate
connections and authorize every sensitive message. - Message size/rate
limits, heartbeat, backpressure and bounded reconnect with jitter. -
Acknowledgements for accepted/started/completed/failed command states. -
Persist commands, approvals and audit events before dispatch. - Pub/sub
is transient, not durable. - Reconcile pending work after reconnect;
never blindly replay. - Idempotency and replay protection.

## 7. Connector requirements

-   Unique connector ID and credential per server; rotation and
    revocation.
-   Outbound WSS, heartbeat and bounded reconnect.
-   Run under a dedicated unprivileged account.
-   Agent discovery and adapter lifecycle.
-   Process/PTY lifecycle, streaming, cancellation and cleanup.
-   Canonical project-root checks and traversal/symlink protection.
-   Executable/argument validation, timeouts, resource limits and
    bounded output.
-   Local policy enforcement immediately before execution.
-   Structured redacted logs; no secrets in logs.
-   Systemd supervision, upgrade, rollback, status and uninstall.
-   Never run as root by default; no arbitrary shell execution by
    default.

## 8. Agent adapters

Implement separate adapters for Hermes, OpenCode and future custom
agents. Inspect the actual installed versions and supported interfaces
before coding. A conceptual adapter may expose discover, list/read
sessions, send message, cancel session, list/respond to permission
requests and stream output, but these are internal abstractions---not
claims that every agent natively supports them.

Each adapter declares capabilities and compatible versions. Unsupported
features must be explicit. If an agent does not reliably expose
permission interception, do not pretend FRIDAY can approve its internal
tool calls; use a genuinely enforceable wrapper or mark it unsupported.
Custom adapters need versioned schemas and conformance tests; do not run
untrusted adapters with elevated privileges.

## 9. Policy engine and approvals

Policy scope: server, agent/type, project, action/capability, executable
and validated arguments where applicable, and duration. Decisions:
`allow`, `deny`, `require_approval`.

-   Explicit applicable deny overrides ordinary allow.
-   Unmatched sensitive actions deny or require approval.
-   Malformed, expired or unsupported rules fail closed.
-   Define deterministic precedence and version rules.
-   Connector rechecks policy immediately before execution.
-   Policy changes invalidate stale approvals.
-   Avoid shell-prefix matching; shell chaining, substitutions,
    redirection, environment changes and symlink traversal can bypass
    naive rules.
-   Root escalation, credential access, destructive operations and
    unrestricted shell are high-risk.

Approval binds to exact request ID/version, server, connector, agent,
project, operation/arguments or payload hash, policy version, expiry,
nonce and authenticated approver. Changed requests require new approval.
Replay must not execute twice. "Approve once" never becomes permanent
allow.

## 10. Android screens

-   Google sign-in/account.
-   Server dashboard.
-   Add Server/install command.
-   QR scanner and numeric pairing input.
-   Pairing progress, expiry and confirmation.
-   Connector verification/version/health.
-   Agent/project selector.
-   Sessions/chat/live output.
-   Pending permission inbox.
-   Policy editor.
-   Job history/audit/security settings.
-   Revoke/re-pair/recovery.

Use explicit states: `pending`, `claim requested`, `paired`, `online`,
`offline`, `expired`, `revoked`, `error`. Never show Online before
verified connector handshake and health. Protect local credentials,
bound terminal output, safely render untrusted output and avoid
sensitive logs.

## 11. Implementation phases

0.  Audit repository, baseline tests, secrets, schema, release signing
    and deployment; write `docs/BASELINE_AUDIT.md`.
1.  Google OAuth/Supabase Auth, schema/RLS, Vercel token verification
    and cross-user tests.
2.  GitHub release pipeline, artifact verification, installer, systemd
    hardening and rollback.
3.  Enrollment state machine, QR/key generation, expiry, one-time
    redemption, rate limiting and connector identity.
4.  Connector WSS, heartbeat, reconnect, event protocol, shared routing
    and durable recovery.
5.  Hermes adapter and Android sessions/chat/output.
6.  Policy engine, permission approvals and audit.
7.  OpenCode adapter and custom adapter contract.
8.  Security hardening, release signing, backup/recovery and rollback
    drills.

Do not assign dates before the baseline audit estimates scope.

## 12. Testing and release gates

Test Google OAuth/session expiry; RLS and cross-user IDOR; tampered
release rejection; unsupported OS/architecture; installer
idempotency/least privilege/rollback; pairing expiry, one-time use, rate
limits, wrong account and replay; connector rotation/revocation; WSS
authentication/routing/reconnect/backpressure; policy precedence and
stale approvals; shell injection, path traversal and symlink escapes;
end-to-end login → install → QR pairing → health verification → agent
session → approval → revocation; secret leakage in APK, repository, logs
and artifacts.

Release only after critical/high findings are resolved, connector
revocation and replay protection are verified, signed builds are
reproducible, and install/upgrade/rollback/recovery instructions exist.
Never claim a test passed unless it actually ran.

## 13. Definition of done

A user can sign in, enroll multiple servers using verified GitHub
releases, pair through QR/code, verify connector health, manage
supported agents, configure per-agent/project/command policies,
approve/deny supported actions, inspect audit history and revoke access.
Cross-user isolation, connector identity, replay prevention and local
policy enforcement have automated test evidence.

## 14. Non-goals/cautions

-   QR pairing does not prove legal ownership of the cloud-provider
    account.
-   Never store Google passwords.
-   Never place permanent credentials in QR or numeric codes.
-   No unrestricted root shell by default.
-   Do not claim native agent permission support without verification.
-   Do not claim "fully secure" without threat modeling and test
    evidence.
