# FRIDAY One — UI/UX Design System and Build Guide

## 1. Direction

Create a premium native Android app using Apple-inspired principles: clarity, restraint, generous spacing, hierarchy, subtle motion and readable controls. Do not copy exact iOS screens/assets or make Android behave unnaturally. The product should feel calm, technical, precise and trustworthy—not like a neon gaming dashboard.

## 2. Principles
1. Server status and approvals outrank decoration.
2. Progressive disclosure: summary first, advanced diagnostics deeper.
3. One primary action per screen.
4. Always show status freshness and connection state.
5. Use consistent components and semantic tokens.
6. Remote actions need clear target, consequence and authorization.
7. Accessibility is part of the design, not a final patch.

## 3. Suggested color tokens

### Dark
- Background `#080B12`
- Surface `#101722`
- Raised surface `#151F2D`
- Border `#263244`
- Primary text `#F4F7FB`
- Secondary text `#A7B4C7`
- Brand blue `#36A8FF`
- Brand violet `#7657FF`
- Success `#28D98B`
- Warning `#FFB547`
- Error `#FF5D6C`

### Light
- Background `#F5F7FB`
- Surface `#FFFFFF`
- Raised surface `#EDF1F7`
- Border `#DCE3ED`
- Primary text `#121826`
- Secondary text `#536176`

Use semantic color names in the theme, not scattered hex values. Use gradients sparingly for the logo or one primary action—not every card. Verify contrast in both themes.

## 4. Typography
Use Android system sans-serif and Material 3 typography as the base. Define display, headline, title, body and label roles. Use monospaced type only for commands/logs. Avoid all-caps paragraphs, tiny low-contrast metadata and fixed-height text that clips when font scaling is enabled.

## 5. Spacing and shapes
Use a 4dp base grid:
- 4dp micro gap
- 8dp compact spacing
- 12dp dense row spacing
- 16dp standard screen gutter/card padding
- 20–24dp section separation
- 32dp major section separation

Suggested radii: chips 10–12dp; buttons/inputs 14–16dp; cards 18–22dp; sheets 24–28dp at top. Prefer subtle borders/tonal elevation to heavy shadows.

## 6. Navigation
Bottom destinations: Home, Chats, Create, Servers, Settings. Create opens a contextual bottom sheet (New Session, Add Server, Review Approvals). It must not instantly execute a command. Keep labels visible and use accessible semantics.

## 7. Home screen hierarchy
1. Top bar: FRIDAY One, notifications, profile.
2. Compact summary: online, stale/offline, pending approvals.
3. Add Server/Continue Setup card for empty accounts.
4. Your Servers: name, OS, status, last seen and agent count.
5. Pending Approvals when present.
6. Recent Activity with time and outcome.
7. Bottom navigation.

A large globe/hero image is optional and should never push essential server information far below the fold. Do not display fabricated server data as real.

## 8. Screen layouts

### Server row
Server icon/initials; name; OS/connector version; text status plus icon; last-seen freshness; agent count. Row opens detail and has a meaningful accessibility label.

### Server detail
Header/status, heartbeat details, agent list, sessions, activity, policy summary, diagnostics and a clearly separated revoke action.

### Pairing
1. Explain what is installed and what connector access means.
2. Show QR and manual numeric code with expiry.
3. Provide terminal instructions and copy button.
4. Show waiting/progress and troubleshooting.
5. Show success only after server confirmation.
6. Provide safe retry for expired/failed attempts.

QR payload contains only an opaque temporary pairing token, never a permanent credential.

### Approval
Show exact action and target, server/agent, requester, timestamp, risk explanation and expiry. Provide Approve and Deny with a confirmation step for high-risk operations. Approval applies only to the exact request; changed request requires a new decision.

### Session
Show server/agent context, stream status, distinct message/tool/output/error types, timestamps, bounded output, copy/pagination and supported cancel action. Display reconnecting state when streaming is interrupted.

## 9. Reusable Compose components
- `FridayTopBar`
- `ServerStatusChip`
- `ServerCard` / `ServerRow`
- `AgentBadge`
- `ConnectionStateBanner`
- `SectionHeader`
- `MetricSummaryCard`
- `EmptyState`
- `ErrorState`
- `OfflineBanner`
- `PairingCodeCard`
- `CopyableCodeBlock`
- `ApprovalCard`
- `RiskLabel`
- `ActivityRow`
- `SessionMessage`
- `CommandOutputPanel`
- `ConfirmActionDialog`
- `LoadingSkeleton`
- `AccessibleIconButton`

Components take semantic values such as `ServerStatus.Online`; centralize status labels/colors. Do not duplicate status logic across screens.

## 10. Motion and states
Use brief transitions, restrained press feedback and non-blocking progress indicators. Avoid per-token expensive recompositions and endless pulsing status indicators. Respect reduced-motion preferences where practical.

Every network-backed feature needs loading, content, empty, error, unauthorized/session expired, offline, stale, partial data, in-progress, success, cancelled, expired and permission-denied states. No blank screen or infinite spinner.

## 11. Accessibility checklist
- Touch targets around 48dp.
- Labels for icon-only buttons.
- Correct semantic headings and focus order.
- Dynamic text scaling tested at large sizes.
- Contrast tested in both themes.
- Status is communicated with text/icon as well as color.
- Error text includes a recovery path.
- TalkBack and keyboard navigation tested.
- Pairing has a manual code alternative to QR.
- Copy action announces success/failure accessibly.

## 12. Android stack
Kotlin, Jetpack Compose, Material 3, Navigation Compose, ViewModel + StateFlow, Coroutines/Flow, Hilt or Koin, Retrofit/OkHttp, Kotlinx Serialization, Room, DataStore, Android Keystore-backed protection and Supabase Auth with Google OAuth.

Keep business logic out of composables. Use app-wide theme tokens and previews. Never place secret keys in source code, resources or `BuildConfig`.

## 13. Suggested structure
```text
core/design-system/
  theme/ components/ preview/
feature/home/
  HomeScreen.kt HomeViewModel.kt HomeUiState.kt
feature/servers/
  ServerListScreen.kt ServerDetailScreen.kt ServerViewModel.kt
feature/pairing/
  PairingScreen.kt PairingViewModel.kt
feature/approvals/
  ApprovalsScreen.kt
feature/sessions/
  SessionScreen.kt
```

Example UI state:
```kotlin
sealed interface LoadState<out T> {
    data object Loading : LoadState<Nothing>
    data class Content<T>(val value: T, val updatedAt: Instant?) : LoadState<T>
    data class Error(val message: String, val canRetry: Boolean) : LoadState<Nothing>
}
```
Represent connection states explicitly (Connected, Connecting, Disconnected, Stale). A cached server object does not prove connectivity.

## 14. UX copy
Prefer literal, actionable labels: “Online,” “Last seen 2 min ago,” “Connection lost,” “Code expires in 04:32,” “Approval required,” “Denied by policy,” “Reconnect,” “Generate new code,” “Revoke server access.”

Avoid vague errors without recovery guidance. Never announce success until the backend/connector confirms it.

## 15. Implementation workflow
1. Confirm package name and current architecture.
2. Define theme tokens and design system.
3. Build navigation shell and reusable components.
4. Implement dashboard with clearly marked preview data.
5. Add all loading/empty/error/offline states.
6. Integrate real server API and freshness timestamps.
7. Implement pairing alongside the backend/connector contract.
8. Implement approvals only after exact-request enforcement works end to end.
9. Run Compose/screenshot tests on small and large devices.
10. Test both themes, font scaling, TalkBack, network loss and expired sessions.
11. Compare screenshots against the approved reference and fix inconsistencies.
12. Complete a security review before release.

## 16. Design definition of done
Every screen has clear hierarchy and primary action; both themes work; all failure/empty/stale states exist; no fake status or unsupported actions appear as real; accessibility checks pass; pairing/approval consequences are clear; and UI data comes from real API contracts or visibly marked preview data.
