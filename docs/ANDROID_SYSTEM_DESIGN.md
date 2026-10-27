# FRIDAY One Android — System Design

**Status:** Proposed baseline | **Platform:** Android | **Purpose:** Secure mobile control of AI agents on user-authorized VPS/cloud servers.

## 1. Overview

FRIDAY One is a native Android control center for supported agents such as Hermes and OpenCode. The app handles authentication, server enrollment, status, sessions, live output, approvals, policies and audit visibility. A restricted FRIDAY Connector runs on each VPS and is the final local enforcement point. The app is not the agent runtime and is not a replacement for SSH.

Principles: least privilege, explicit authorization, revocable credentials, clear online/stale/offline states, fail-closed sensitive actions, no backend secrets in the APK, and verifiable test evidence.

## 2. System architecture

```text
Android (Kotlin + Compose)
    | HTTPS / authenticated WSS
    v
Control-plane API (Vercel stateless routes) ---- Supabase Auth + Postgres/RLS
    | authenticated WSS / HTTPS
    v
Persistent real-time gateway (dedicated service if required)
    | outbound authenticated connector channel
    v
FRIDAY Connector on VPS (restricted systemd service)
    |
    +-- Agent adapters: Hermes / OpenCode / future supported agents
```

**Deployment constraint:** Do not assume Vercel serverless functions can host permanent WebSocket connections or long-running processes. Validate current runtime constraints. Use Vercel for suitable stateless APIs and a dedicated long-running gateway if needed. The connector should initiate outbound connections; inbound VPS ports should not be required by default.

## 3. Technology choices

| Layer | Recommended stack |
|---|---|
| Android | Kotlin, Jetpack Compose, Material 3 |
| App architecture | Feature-based MVVM, unidirectional state flow |
| Async/state | Coroutines, Flow, StateFlow |
| Navigation | Navigation Compose |
| DI | Hilt or Koin |
| HTTPS | Retrofit + OkHttp |
| WebSocket | Maintained WSS client, with authentication and reconnect strategy |
| Serialization | Kotlinx Serialization |
| Local cache | Room |
| Preferences | DataStore |
| Sensitive local material | Android Keystore-backed protection |
| Authentication | Supabase Auth + Google OAuth; never collect Google passwords |
| Backend | TypeScript API routes on Vercel for stateless control-plane work |
| Durable database | Supabase PostgreSQL, RLS, versioned migrations |
| Connector | Prefer Go or Rust for a small Linux binary; Python can be used for a prototype |
| VPS service | systemd, dedicated unprivileged service user |
| Releases | GitHub Releases with signed artifacts or verified checksums |
| CI | GitHub Actions |

Check current maintenance, licensing and Android compatibility before choosing libraries.

## 4. Android module layout

```text
app/
core/
  common/ design-system/ model/ network/ database/
  security/ auth/ realtime/
feature/
  onboarding/ dashboard/ servers/ pairing/ agents/
  sessions/ approvals/ policies/ activity/ settings/
```

Keep composables focused on rendering and user events. ViewModels expose immutable `StateFlow<UiState>`. Repositories coordinate APIs, WebSocket streams and Room. The UI must include loading, content, empty, stale, offline, unauthorized and error states. A hidden button is not an authorization mechanism; backend and connector checks remain mandatory.

## 5. Core modules

### Authentication
- Google OAuth through Supabase Auth, including redirect-state validation, session restore, token refresh and sign-out.
- Never ask for or store the user's Google password.
- Private routes require a valid authenticated session.

### Server management
- Show friendly name, OS metadata, connector version, last heartbeat, agents and connection state.
- Distinguish Online, Connecting, Stale, Offline, Revoked and Unknown.
- Allow renaming, diagnostics, revocation and safe re-pairing.
- Never display permanent connector credentials.

### Pairing flow
1. Signed-in user requests a pairing session.
2. Backend creates a short-lived, single-use QR/numeric code bound to that account.
3. QR contains only an opaque temporary pairing token, never a permanent secret.
4. User runs the documented bootstrap/install command on the VPS.
5. Connector completes an authenticated enrollment handshake.
6. Backend binds connector to the server/account and issues a unique revocable credential securely.
7. App shows success only after server-side confirmation.

Use expiry, rate limits, single-use redemption, attempt limits and replay protection. Pairing proves successful connector enrollment, not legal ownership of the cloud provider account.

### Agent adapters and sessions
- Discover agents and capabilities from actual connector observations.
- Represent installed, running, stopped, unsupported and unknown separately.
- Only show actions supported by a tested adapter.
- Sessions show transcript/output, timestamps, tool activity, errors and streaming state.
- Stop/cancel controls appear only when supported by the underlying agent.

### Commands, policies and approvals
- Prefer typed, allowlisted actions over arbitrary shell strings.
- No unrestricted root shell by default.
- Connector validates identity, target, request expiry, replay data, action schema and policy before execution.
- Sensitive or unknown actions are denied or require approval according to explicit policy.
- Approval is bound to an immutable request hash, target, actor and expiry; it cannot authorize a later modified request.
- If auth/policy/approval cannot be verified, fail closed.
- Do not auto-execute privileged commands queued while offline.

### Activity/audit
Record actor, server, agent, action type, timestamp, outcome, correlation ID and policy decision. Redact tokens, passwords, private keys and sensitive output. Use append-only or tamper-evident handling where practical.

## 6. Suggested data model

- `profiles`: metadata linked to Supabase Auth subject.
- `servers`: owner ID, name, OS metadata, connector version, state, last seen.
- `pairing_sessions`: hashed code/token, owner, expiry, consumed time, attempt count and state.
- `connector_credentials`: identifier, verifier/hash where feasible, server binding, issue/revocation timestamps.
- `agents`: server, adapter, version, capabilities and observed state.
- `sessions`: server/agent references and provider session metadata.
- `commands`: request ID, exact action/hash, actor, target, policy result, expiry and result metadata.
- `approvals`: command reference, approver, decision, request hash and expiry.
- `policies`: scope, version, policy document and audit metadata.
- `audit_events`: actor, target, event, outcome, correlation ID and timestamp.

Use foreign keys, constraints, indexes, migrations and RLS. Enforce ownership in backend routes as well as RLS. Never trust a client-supplied owner ID without validating it against the authenticated identity.

## 7. API and real-time contract

Proposed endpoint families (not claims that these routes already exist):
- `POST /api/v1/pairing-sessions`
- `GET /api/v1/servers`
- `GET /api/v1/servers/{serverId}`
- `POST /api/v1/servers/{serverId}/revoke`
- `GET /api/v1/servers/{serverId}/agents`
- `GET /api/v1/servers/{serverId}/sessions`
- `POST /api/v1/commands`
- `POST /api/v1/commands/{commandId}/cancel`
- `GET /api/v1/approvals`
- `POST /api/v1/approvals/{approvalId}/decision`
- `GET /api/v1/audit-events`

Every request/message needs schema validation, authentication, authorization, request/correlation IDs, timestamps/expiry and consistent error handling. WSS messages need protocol version, message ID, request ID, connector identity, message type and replay protection. Client-supplied server IDs are not proof of access.

## 8. Security requirements

- No Supabase service-role key, signing private key or global connector secret in Android.
- TLS-only HTTPS/WSS in production.
- Unique, scoped, rotatable, revocable connector credentials.
- Short-lived, single-use pairing codes; rate limiting and hashed storage where possible.
- IDOR prevention through resource ownership checks and RLS.
- Replay protection, idempotency and strict payload validation.
- Never interpolate untrusted input into shell commands.
- Connector runs as an unprivileged systemd user with filesystem/resource restrictions and no unnecessary capabilities.
- Signed releases or trusted checksum verification.
- Redact secrets from logs, crash reports, clipboard and notifications.
- Dependency/secret scanning and a documented threat model.
- Certificate pinning is optional and requires a safe rotation plan; it does not replace TLS validation.

## 9. Reliability and observability

- Cache read-only data in Room and label it with last-updated time.
- WebSocket reconnect uses bounded exponential backoff with jitter.
- Mark status stale after missed heartbeats.
- Use request IDs and reconcile action state after reconnect; do not blindly repeat non-idempotent commands.
- Bound transcript/output buffers and paginate history.
- Structured logs with correlation IDs and redaction.
- Track pairing failures, API errors, WSS disconnects, command latency, connector version and heartbeat freshness.

## 10. Testing

Android: ViewModel/repository unit tests, Compose UI tests, deep-link tests, offline/stale tests, accessibility checks.

Backend/connector: pairing expiry/reuse tests, RLS and cross-user isolation tests, authz tests, policy tests, replay protection, restricted-user connector tests, protocol contract tests, revocation tests, malformed payload tests and command-injection tests.

End-to-end: use a disposable VPS or containerized environment to pair, detect a real supported agent, view a session, approve/deny an action, revoke the connector and verify access is rejected.

## 11. Delivery sequence

1. Foundation: app shell, theme, OAuth, API client, error model, CI.
2. Read-only dashboard and server status.
3. Real pairing + connector enrollment + revocation.
4. Authenticated gateway, heartbeat and diagnostics.
5. One verified agent adapter and session view.
6. Typed commands, policy enforcement, approvals and audit.
7. Security review, accessibility, failure injection, release signing and rollout.

## 12. Definition of done

A production-ready claim requires a real Android build, successful real-VPS pairing, accurate live status, one real agent integration, authorization/revocation tests, connector-side enforcement, passing migrations/tests, deployment evidence, documented privacy/retention/recovery, and no unresolved critical/high security findings.
