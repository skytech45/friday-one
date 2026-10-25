# FRIDAY One --- Full Upgrade Implementation Prompt (v2.0)

## Role

Act as the principal software architect, senior Android/Kotlin engineer,
backend engineer, Linux connector engineer, release engineer and
application-security reviewer upgrading the existing FRIDAY One
repository. Treat the current code as authoritative; do not assume old
documentation proves implementation. Inspect first, preserve working
features and implement in verified stages.

## Mandatory reading

Read `UPGRADE_PLAN.md`, `SYSTEM_DESIGN.md` and this `PROMPT.md` before
editing. Also inspect README, architecture docs, code, tests, CI and
deployment files. If filenames differ, report the mapping.

## Product objective

Build FRIDAY One so a user can: 1. Sign in to Android using Google OAuth
through Supabase Auth. 2. Create an enrollment tied to the authenticated
account. 3. SSH into their own authorized VPS and run a version-pinned
installer for a verified GitHub connector release. 4. Install FRIDAY
Connector as a restricted systemd service. 5. See a terminal QR code and
16--20 digit one-time numeric code. 6. Scan QR or enter the code in the
authenticated app. 7. Complete secure one-time pairing and verify
connector health/version. 8. Manage Hermes, OpenCode and future custom
agents: sessions, chats, output, cancellation, supported permission
requests, per-agent/project/command policies and audit. 9. Revoke a
connector or re-pair after reinstall/credential loss.

Pairing proves that a valid connector was enrolled to an authenticated
account and is running on the installed server. Do not claim it proves
legal ownership of the VPS provider account.

## Non-negotiable architecture

-   Android: Kotlin, Jetpack Compose and existing patterns unless a
    documented reason warrants change.
-   Google OAuth via Supabase Auth; never collect/store Google
    passwords.
-   Supabase Auth + PostgreSQL + RLS for identity and durable user-owned
    data.
-   Vercel APIs for server-side token verification, ownership
    authorization, enrollment, policy and audit.
-   Official versioned GitHub releases; verify checksum and preferably
    signature/attestation.
-   Per-server FRIDAY Connector initiates outbound authenticated WSS.
-   Connector is the final local execution gate.
-   Realtime gateway has message-level authorization and shared
    cross-instance routing; PostgreSQL stores durable
    command/approval/audit state.
-   Hermes, OpenCode and custom agents use capability-based adapters.
-   No privileged backend secret, Supabase service-role/secret key,
    connector credential or SSH private key in Android.
-   Unmatched sensitive actions fail closed. No unrestricted shell by
    default.
-   Never claim features work without implementation and test evidence.

## Phase 0 --- Read-only repository audit

Before modifying application code: 1. Inspect repository tree, git
status/branch, README, architecture docs, manifests, Android Gradle
files, backend/connector code, SQL migrations, environment templates,
GitHub workflows, Vercel config and tests. 2. Run baseline builds/tests
where safe and record exact commands and results. 3. Classify each
target capability as implemented, partial, missing, insecure or
unverified. 4. Search for hardcoded secrets, unsafe shell execution,
missing authorization, missing RLS, insecure file access, placeholder
integrity checks, debug release signing and secrets in logs. Redact all
secret values. 5. Write `docs/BASELINE_AUDIT.md` with evidence,
severity, impact and recommendations. 6. Produce staged plan, migration
dependencies, rollback plan and acceptance criteria. 7. Do not infer
implementation from documentation alone. 8. In autonomous execution,
write the audit first and summarize it before proceeding.

## Phase 1 --- Incremental workflow

For each stage: - Make a small coherent diff. - Add tests for changed
behavior. - Run targeted tests, then the broadest available suite. - Run
lint, format, type checks and builds where available. - Inspect final
diff and scan for secret leakage. - Update docs and migration
instructions. - Report actual commands and results. - Preserve existing
working features unless a justified change is needed.

Do not replace large files without understanding them. Do not run
destructive migrations, alter production secrets or deploy to production
without explicit authorization.

## Phase 2 --- Google OAuth, Supabase and authorization

Implement supported Google OAuth/Supabase Auth flow with correct Android
redirect/deep-link configuration. Never collect/store Google passwords.

Implement server-side access-token verification. Derive user ID from
verified claims, never from client-supplied `owner_id`. Add RLS to every
user-owned client-exposed table and explicit API ownership checks.

Create versioned migrations for: `profiles`, `servers`, `enrollments`,
`connector_credentials`, `agents`, `projects`, `agent_sessions`,
`chat_messages` or protected references, `permission_policies`,
`permission_requests`, `command_jobs`, `audit_events`.

Use UUIDs, timestamps, foreign keys, indexes, retention/deletion
behavior and rollback notes. Do not store reusable plaintext connector
credentials in user-readable rows. Keep secret/service-role key
server-side. Test invalid/expired tokens, cross-user access, ID
substitution and RLS.

Every API must validate schema, authentication, ownership/capability,
payload size, rate limits and idempotency where relevant. Redact
errors/logs. Persist durable state before dispatch where required. Do
not expose an API that blindly forwards arbitrary shell strings.

## Phase 3 --- GitHub release pipeline and installer

Inspect existing CI/release workflow. Build and test versioned connector
artifacts for supported OS/architectures. Publish immutable releases,
checksums, signature/attestation where supported, changelog and platform
matrix.

Installer must: 1. Validate exact version, OS and architecture. 2.
Download exact artifact over HTTPS. 3. Verify checksum and signature
against a trusted key/chain. 4. Abort on mismatch. 5. Create a dedicated
non-login service user and restricted directories. 6. Install files with
least-privilege permissions. 7. Create a hardened compatible systemd
unit. 8. Start service and verify health/version. 9. Enter enrollment
mode and print temporary QR/code only. 10. Never print permanent
credentials. 11. Provide `status`, `upgrade`, `rollback`, `revoke`,
`uninstall`. 12. Be idempotent and document `sudo` needs.

Do not make an unpinned mutable `curl | bash` the default. If
one-command installation is offered, verify a pinned artifact before
execution. Do not run the connector as root by default. Document
signing-key rotation and recovery.

## Phase 4 --- Pairing protocol

Use an explicit state machine such as:
`created -> pending_connector -> claim_requested -> paired -> online`
with `expired`, `cancelled`, `rejected`, `revoked`, `error` terminal
states.

Flow: 1. Authenticated app creates pending owner-bound enrollment. 2.
App displays version-pinned install command and official install
documentation. 3. Connector installs and starts enrollment mode. 4.
Terminal shows QR and 16--20 digit one-time code. 5. QR/code resolve to
the same enrollment. 6. App submits claim; API validates verified owner,
expiry, attempt count and single-use state. 7. Connector proves
possession of enrollment challenge over authenticated outbound channel.
8. API atomically consumes the temporary credential and issues unique
connector identity/credential. 9. Connector reconnects with new identity
and sends authenticated hello. 10. Backend verifies connector/server
association, version and health. 11. App shows Paired/Online only after
verified acknowledgement.

Security requirements: - Cryptographically secure random code/token. -
Short expiry, initial target 5--10 minutes unless testing supports
otherwise. - Single-use, rate-limited, invalid after expiry. - Hash
stored where practical; never log raw code or send to analytics. - QR
has opaque temporary token only, never permanent credential. - Claim
bound to account that initiated enrollment. - Never trust
client-supplied owner ID. - Atomic consumption prevents concurrent
claims succeeding twice. - Wrong-account, expired, replayed, guessed or
revoked claims fail. - Pairing does not grant shell access. - Do not
imply pairing proves legal provider-account ownership.

Adapt endpoint shapes after audit if necessary, but preserve these
security properties.

## Phase 5 --- Connector identity and runtime

Each server has unique connector ID and revocable credential. Support
rotation and revocation; never use a global shared credential.
Reinstall/lost local state requires fresh pairing.

Connector requirements: - Dedicated unprivileged account and systemd
supervision. - Outbound authenticated WSS, heartbeat, bounded reconnect
with jitter. - Schema validation and message size limits. - Process/PTY
lifecycle, cancellation, command IDs and idempotent acknowledgements. -
Canonical project-root validation and traversal/symlink protection. -
Executable/argument validation, timeouts, resource/output limits. -
Local policy check immediately before execution. - Redacted structured
logs. - Upgrade/rollback/revoke/uninstall. - Reject messages whose
connector/server association does not match authenticated identity.

Avoid arbitrary shell strings. If shell is supported, classify as high
risk and test chaining, substitutions, redirection, environment changes
and path traversal. A valid connection does not authorize every command.

## Phase 6 --- Vercel control plane and realtime

Implement enrollment, server registry/revocation, agent/project/session
metadata, policies, permission requests, jobs, audit and realtime
authorization APIs.

Use WSS from Android and connector. Verify current official Vercel
WebSocket/runtime limits and actual plan. Shared routing handles
multiple gateway instances. PostgreSQL remains durable source of truth;
pub/sub and WebSocket frames are transient. If Vercel is unsuitable for
long-lived connections, move gateway to a dedicated service without
changing protocol.

Protocol should include version, message ID, correlation ID,
server/connector IDs, event type, timestamps, expiry, sequence/cursor
and idempotency key. Implement: - connection authentication and
message-level authorization; - bounded payloads, rate limits, heartbeat
and backpressure; - acknowledgements and explicit state transitions; -
replay prevention/idempotency; - reconnect reconciliation and
missed-event recovery; - durable command/approval/audit records before
dispatch; - no bearer tokens in URLs; - duplicate execution prevention.

## Phase 7 --- Agent adapter framework

Create a versioned adapter contract and capability registry. Inspect
actual Hermes/OpenCode versions and interfaces before implementing.
Implement Hermes first, then OpenCode. Do not invent native methods or
assume capability parity.

Potential capabilities: discover, list/read/create/cancel sessions,
send/stream chat, stream terminal output, list projects, list/respond to
permission requests. Each adapter declares capabilities and supported
versions. Unsupported features return explicit errors.

If native permission interception is unavailable, mark it unsupported or
use a genuinely enforceable wrapper. Never fake enforcement through a
database update or chat message. Custom adapters need schema, capability
declaration, event/error model and conformance tests; do not run
untrusted adapters with elevated privileges.

## Phase 8 --- Policy engine and approvals

Support per-server, per-agent/type, per-project, per-action/command and
duration scopes. Decisions: `allow`, `deny`, `require_approval`.

-   Explicit applicable deny overrides ordinary allow.
-   Unmatched sensitive actions deny or require approval.
-   Expired/malformed/unsupported policies fail closed.
-   Define deterministic precedence.
-   Connector rechecks policy immediately before execution.
-   Policy updates invalidate stale approvals.
-   Avoid naive command-prefix matching.

Approval binds to exact request ID/version, server, connector, agent,
project, operation/arguments or payload hash, policy version, expiry,
nonce and authenticated approver. Changed request requires a new
decision. Replay/duplicate approval cannot execute twice. "Approve once"
never creates a permanent allow.

Add tests for conflicting policies, expiry, scope, stale version,
revocation, malformed requests, race conditions, replay and idempotency.

## Phase 9 --- Android UX

Implement: - Google sign-in/account. - Server dashboard. - Add
Server/install command. - QR scanner/numeric code input. - Pairing
progress, expiry and confirmation. - Connector
verification/version/health. - Agent/project selector. -
Session/chat/live output. - Pending permission inbox. - Custom policy
editor. - Job history/audit/security. - Revoke/re-pair/recovery.

Use explicit states: pending, claim requested, paired, online, offline,
expired, revoked and error. Do not show Online before handshake and
health verification. Protect credentials, bound terminal output, safely
render untrusted content, handle reconnect and avoid sensitive logs.

## Phase 10 --- Test and harden

Required tests: - OAuth redirect/session expiry/logout. - RLS and
cross-user IDOR. - Tampered release rejection and unsupported
OS/architecture. - Installer idempotency, least privilege, upgrade and
rollback. - Pairing expiry, single-use, rate limit, wrong account and
replay. - Connector credential rotation/revocation and per-server
isolation. - WSS auth, routing, duplicate/out-of-order events, reconnect
and backpressure. - Policy precedence, stale approvals, replay and
duplicate execution. - Shell injection, argument confusion, path
traversal and symlink escape. - End-to-end Google login → enrollment →
install → QR/code pairing → health → agent session → permission decision
→ revocation. - APK/repository/log/release secret scan.

Never claim a test passed unless it was actually run. If blocked by
credentials/infrastructure/device access, state the limitation and
provide a safe test procedure.

## Security invariants

-   No privileged backend key in Android.
-   No Google password stored.
-   No cross-user data access.
-   No shared global connector credential.
-   No unverified release install.
-   No pairing code after expiry or more than once.
-   No permanent secret in QR.
-   No execution without authorization and connector-side enforcement.
-   No stale approval execution.
-   No sensitive action depending only on transient realtime.
-   No false claim of native agent permission support.
-   No production migration/deployment without approval.
-   No secrets in logs/reports/commits.

## Required deliverables

1.  `docs/BASELINE_AUDIT.md`
2.  Updated `UPGRADE_PLAN.md`, `SYSTEM_DESIGN.md` and `PROMPT.md` if
    findings require it.
3.  Versioned Supabase migrations and RLS policies.
4.  Google OAuth setup and redirect guide.
5.  Vercel API and deployment guide.
6.  GitHub Actions/release workflow, verified artifacts and release
    notes.
7.  Connector source, hardened systemd unit and
    install/upgrade/rollback/revoke/uninstall instructions.
8.  Pairing protocol and state-machine tests.
9.  Realtime protocol and operations guide.
10. Hermes/OpenCode adapters or evidence-based blocker report.
11. Policy engine and approval flow.
12. Android screens/API integration.
13. Automated tests and security report.
14. Safe environment template with placeholders only.
15. Backup/recovery/rotation/migration/rollback guide.
16. Changelog and actual build/test commands/results.
17. Remaining risks and next steps.

## Final report format

Report what changed, files touched, commands run and actual results,
completed versus partial features, security fixes and remaining issues,
migration/deployment steps, required configuration (without secret
values), risks and next steps. Never claim "fully secure,"
"production-ready" or "all tests pass" without evidence.
