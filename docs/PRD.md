# FRIDAY One Android — Product Requirements Document

**Version:** 1.0 draft | **Status:** Proposed | **Platform:** Android phone first

## 1. Product summary

FRIDAY One is a secure mobile control center for AI agents running on user-authorized VPS/cloud servers. Users enroll servers, monitor status, discover supported agents, inspect sessions and live output, manage policies, approve sensitive requests and review audit history.

The app is a client, not the agent runtime. A restricted connector runs on each VPS and enforces local security rules.

## 2. Problem

Remote AI agents are managed through fragmented terminals and dashboards. Users need one mobile view of server health, agent activity and permission requests without embedding permanent credentials or exposing unrestricted root shell access.

## 3. Goals
- Securely pair a VPS with QR/one-time-code enrollment.
- Show accurate online/stale/offline status and last-seen timestamps.
- Support verified Hermes/OpenCode integrations using tested adapters.
- View sessions and live output where supported.
- Make sensitive actions explicit and controllable.
- Search activity/audit history.
- Revoke connector access and re-pair safely.
- Deliver a polished, accessible native Android UX.

## 4. Non-goals for MVP
- Full replacement for SSH or cloud consoles.
- General cloud-provider account administration.
- Unrestricted root shell by default.
- Claiming every agent is supported before its adapter is tested.
- Automatic execution of queued commands after reconnection.
- iOS/desktop clients, marketplace or billing in initial release.
- Claiming QR pairing proves legal ownership of the cloud account.

## 5. Target user and jobs

**Primary user:** developer/self-hoster running one or more VPS instances with AI agents.

Jobs:
- See which servers are online and when they last checked in.
- Pair a VPS without copying a permanent secret.
- Open the correct agent/session and follow output.
- Understand and decide on sensitive actions.
- Inspect why an action was allowed or denied.
- Revoke access quickly when a server/credential is no longer trusted.

## 6. Information architecture

Bottom navigation:
1. **Home:** summary, server status, pending approvals, recent activity.
2. **Chats:** agent sessions and conversations.
3. **Create:** contextual action sheet; not an immediate command executor.
4. **Servers:** enrolled servers, pairing, details, agents and diagnostics.
5. **Settings:** profile, security, notifications, appearance, privacy and help.

Other screens: onboarding, pairing, server detail, agent detail, session transcript, approval detail, policy editor, audit log, diagnostics and connector installation guide.

## 7. Functional requirements

### FR-01 Authentication
Google OAuth via Supabase Auth. No Google password collection. Support session restoration, token refresh, sign-out and redirect-state validation.
**Acceptance:** signed-out users cannot access private data; sign-out clears session material and private cache according to policy.

### FR-02 Home dashboard
Show server counts by status, pending approvals, recent servers and recent activity. Include Add Server/Continue Setup for empty accounts. Provide loading, empty, stale, offline and error states.
**Acceptance:** missed heartbeats cause stale/offline status, not indefinitely “Online.”

### FR-03 Pairing
Request a short-lived pairing session; display QR and numeric code, expiry, terminal instructions and safe retry. QR contains only an opaque temporary token. Pairing is account-bound, single-use, rate-limited and replay-protected.
**Acceptance:** valid flow succeeds end to end; expired/reused/invalid attempts are rejected and audited. Show success only after backend confirmation.

### FR-04 Server list/detail
Show name, OS, connector version, last seen, status and agent count. Detail includes agents, sessions, activity, policy summary and diagnostics. Support rename, revoke and safe re-pairing. Never show permanent credentials.

### FR-05 Agent discovery
Show observed state (running/stopped/unsupported/unknown), version and verified capabilities. Only render controls that a tested adapter supports.

### FR-06 Sessions
List sessions by server and agent. Show role/message type, timestamps, tool activity, output, errors and stream state. Support pagination/copy. Create/stop/cancel only where the underlying adapter supports it.

### FR-07 Commands/actions
Prefer structured allowlisted actions. Show target and action summary before execution. Apply backend authorization and connector-side policy. Use request IDs, expiry and replay protection. Show progress and confirmed outcome. Never auto-run privileged actions after reconnect.

### FR-08 Approvals
Show exact request, target, requester, risk, timestamp and expiry. Approve/deny only the immutable request. Modified payloads require new approval. Record decision and outcome.

### FR-09 Policies
Configure scope and action categories with readable previews and warnings for broad access. Default-deny sensitive/unknown actions unless an explicit reviewed policy permits them. Connector is the final enforcement point.

### FR-10 Audit
Filter by server, agent, event, outcome and time. Show actor, timestamp, action, policy result and correlation ID. Redact credentials and sensitive output.

### FR-11 Notifications
Optional alerts for stale/offline servers, pending approvals and connector errors. Allow category controls. No secrets or sensitive command contents in notifications. Revalidate authorization when opening an action.

### FR-12 Settings/help
Profile, sign-out, system/light/dark theme, privacy and retention info, notification settings, installation guide, troubleshooting, app version and support.

## 8. Non-functional requirements

**Security:** no service-role/global secret in APK; TLS; API and connector authorization; unique revocable credentials; short-lived pairing; redacted logs; no arbitrary root shell by default.

**Reliability:** explicit stale/offline states; bounded reconnect with jitter; idempotency/reconciliation; local cache is informational; no unbounded output buffers.

**Performance targets (validate on representative devices):** usable app shell under 3 seconds on a mid-range supported phone excluding network/OAuth; cached dashboard within 1 second after shell; routine reads target p95 under 1.5 seconds on a healthy network. Measure actual results and do not present targets as guarantees.

**Accessibility:** scalable text, semantic icon labels, high contrast, touch targets around 48dp, no color-only status and TalkBack testing.

**Privacy:** minimize collected data, define retention/deletion, disclose what server/session/audit data is stored, keep sensitive output out of notifications and redact diagnostics.

## 9. Visual UX requirements

Use a premium, calm, Apple-inspired design language without copying proprietary iOS screens or assets. Dark theme can be the initial direction, but provide a complete light theme. Suggested palette: near-black/navy surfaces, white/soft-gray text, restrained blue-violet brand accent, green healthy, amber pending, red critical.

Prioritize server status and approvals over decorative hero graphics. Use rounded cards consistently, readable labels, timestamps, restrained motion and clear status text. The central Create button opens a safe action sheet. Pairing, approval and revocation screens prioritize clarity over visual effects. Design loading, empty, offline, stale, error, expired and permission-denied states.

## 10. Screen inventory
1. Splash/session restore
2. Welcome/sign-in
3. OAuth return/error
4. Home dashboard
5. Add Server intro
6. QR/code pairing
7. Pairing progress/success/failure/expiry
8. Server list/detail
9. Agent detail
10. Session list/transcript
11. Quick-action sheet
12. Action review
13. Pending approvals/detail
14. Policy list/editor
15. Activity/audit and filters
16. Connection diagnostics
17. Settings/profile/privacy/help

## 11. MVP scope and release gates

MVP: Supabase OAuth; dashboard/server list; one real VPS pairing flow; connector credential issuance/revocation/heartbeat; one verified agent adapter; session/status view; audit events; automated ownership, pairing expiry/reuse, revocation and offline tests.

Release 1.1: second adapter, richer approvals/policies if not in MVP, push notifications and enhanced diagnostics.

Do not publicly release until real-device build and VPS pairing pass, cross-user authorization and revocation tests pass, critical/high security findings are fixed, signing/scanning are configured, privacy/retention/recovery are documented, and the real-time gateway hosting design is verified.

## 12. Success metrics
- Pairing completion rate and median pairing time.
- Fresh heartbeat coverage and stale-server rate.
- Session-open success rate.
- Action success/failure by cause.
- Approval latency and expiry rate.
- Reconnection recovery rate and crash-free sessions.
- Unauthorized requests correctly rejected.
- User confusion reports for pairing/permissions.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Connector compromise | Unprivileged service, OS restrictions, least privilege, revocation |
| Pairing token leak | Short expiry, one use, hashed storage, rate limits |
| Cross-user exposure | RLS + route ownership checks + IDOR tests |
| Vercel WSS limitations | Validate early; dedicated gateway if needed |
| Agent interface differences | Capability-based adapter contract |
| False online state | Heartbeat freshness and stale state |
| Command injection | Structured allowlisted actions; no shell interpolation |
| Approval replay/substitution | Bind approval to exact request hash and expiry |
| Secret leakage | Redaction tests, safe notifications and diagnostics |
| UX overload | Progressive disclosure and a focused dashboard |

## 14. Open decisions
- First production adapter: Hermes or OpenCode based on verified interface.
- Persistent gateway host/topology.
- Initial allowlisted action set.
- Audit/session retention periods.
- Privacy-compatible crash reporting.
- Minimum supported Android API level.
- Whether selected high-risk actions require biometric confirmation and how recovery works.
