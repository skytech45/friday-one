# FRIDAY One Android — Alignment Plan

**Status:** Proposed · **Written:** 2026-10-27 · **Baseline:** app v0.9.0 (versionCode 10), `master` @ `61a8896`

Brings the Android app in line with [PRD.md](../../PRD.md),
[ANDROID_SYSTEM_DESIGN.md](../../ANDROID_SYSTEM_DESIGN.md) and
[UI_UX_GUIDE.md](../../UI_UX_GUIDE.md). Each phase must leave a buildable,
releasable app; nothing is called done until it is built and checked on a
device or emulator.

---

## 1. Where the app is today

| Area | State at baseline |
|---|---|
| Size | 8 Kotlin files, 2,930 lines. `feature/cloud/CloudScreen.kt` alone is **1,384 lines** (limit: 800). |
| Architecture | No ViewModels. State lives in `remember { mutableStateOf(...) }` inside composables; network calls are launched from `rememberCoroutineScope()`. Clients are created with `remember { ControlPlaneClient() }` in each screen. |
| Navigation | Boolean/nullable flags in `AppDashboardShell` (`activeChatServer`, `securityOpen`, `pairingOpen`) pick one screen. No back stack, no bottom bar. |
| Theme | `Theme.kt` defines the guide's light **and** dark tokens correctly, but screens bypass it: the `Dash` object in `ui/components/Dashboard.kt` hardcodes the dark palette and is referenced **129 times** outside that file. Light mode therefore renders dark screens with light system chrome. |
| Dead code | `RingGauge`, `Sparkline`, `LoadBar`, `LiveDot`, `MetricRow`, `GrowDivider`, `fmtBps`, `fmtUptime` in `Dashboard.kt` have no callers (legacy telemetry UI). |
| Server status | `CloudServer` has only `online: Boolean`. The control plane already returns `last_seen_at` (`control-plane/api/v1/servers/index.ts:67`), but the client drops it. Every non-online server is shown as "OFFLINE"; there is no Stale/Revoked/Unknown. |
| Screen states | Ad-hoc `loadError: String?` per screen; no shared loading/empty/error/offline/stale model. A `401` is detected by `e.message?.contains("401")`. |
| Approvals | The inline card shows only `operation`. The spec requires the exact request, target, requester, expiry and a confirmation step for high-risk actions. |
| Debug leftovers | `ChatView` falls back to project root `"/tmp/friday-acp-test"` when the server reports none. |
| Tests | 3 JVM parsing tests (`ServerParsingTest`). No ViewModel, Compose UI or deep-link tests. |
| Local build | No Gradle wrapper in the repo; builds rely on a system `gradle` (CI uses `gradle/actions/setup-gradle`). |

Already aligned: colour tokens, Supabase email + Google PKCE auth, QR and
numeric pairing, capability-driven agent/project pickers, streaming chat,
cancel, and connector-side enforcement on the backend.

---

## 2. Phase 0 — Build guardrails (small, do first)

1. Add the Gradle wrapper (`gradle wrapper --gradle-version <pinned>`) and
   commit `gradlew`, `gradlew.bat`, `gradle/wrapper/*`. Switch CI and
   `android/build.sh` to `./gradlew`.
2. Document the JDK 17 requirement in `docs/SETUP_GUIDE.md` (the dev machine's
   default `java` is 8).
3. Add a Compose UI test dependency set (`androidx.compose.ui:ui-test-junit4`,
   `ui-test-manifest`) so Phase 1 can be guarded by a smoke test.

**Exit:** `./gradlew :app:testDebugUnitTest :app:assembleDebug` green locally and in CI.

---

## 3. Phase 1 — Split `CloudScreen.kt` (behaviour-preserving)

**Rule:** pure moves. No logic, copy, colour or layout changes, so the diff
reviews as relocation. Visibility goes from `private` to `internal` where a
function moves to its own file. Theme and state refactors come later.

### Target layout

```text
com/friday/one/
  MainActivity.kt
  app/
    FridayApp.kt            ← CloudScreen()            (CloudScreen.kt 60–106)
    AppShell.kt             ← AppDashboardShell()      (353–441)
  feature/
    auth/AuthScreen.kt      ← AuthScreen()             (112–347)
    pairing/
      PairingScreen.kt      ← ServerPairingScreen() frame, top bar, step 0 (447–588)
      PairingInstructions.kt← VPS terminal steps 1–2   (589–713)
      PairingConnect.kt     ← step 3: QR / key tabs    (714–865)
    home/
      HomeScreen.kt         ← DashboardView()          (871–1010)
    sessions/
      ChatScreen.kt         ← ChatView() frame, event collection, header (1081–1226)
      ChatComponents.kt     ← message list, approval card, cancel bar, input (1227–1371)
    security/
      SecurityView.kt       ← moved from feature/cloud/
  core/designsystem/
    Tokens.kt               ← Dash object (from ui/components/Dashboard.kt)
    components/
      MetricCard.kt         ← MetricCard()             (1012–1025)
      ServerCard.kt         ← ServerCard()             (1028–1075)
      FieldColors.kt        ← cloudFieldColors()       (1374–1384)
      SectionLabel.kt       ← SectionLabel() (Dashboard.kt + SecurityView duplicate)
  data/                     ← unchanged
```

Line ranges are from `master` @ `61a8896`; re-check them before moving.

### Steps (one commit each)

1. Move `SecurityView.kt` to `feature/security/`; update imports.
2. Extract the design-system pieces: `Dash` → `core/designsystem/Tokens.kt`,
   plus `MetricCard`, `ServerCard`, `cloudFieldColors`, and a single
   `SectionLabel` (it exists twice today). Delete the 8 uncalled components
   and helpers from `Dashboard.kt`, then delete the file.
3. Extract `AuthScreen` → `feature/auth/`.
4. Extract the pairing screen into the three `feature/pairing/` files, passing
   the existing state as parameters (no new state holder yet).
5. Extract `DashboardView` → `feature/home/HomeScreen.kt`.
6. Extract `ChatView` → `feature/sessions/` (two files).
7. What remains (`CloudScreen`, `AppDashboardShell`) moves to `app/`;
   `CloudScreen` is renamed `FridayApp`. Delete `feature/cloud/`.

### Verification

- Before step 1: add a Compose smoke test that renders `AuthScreen`,
  `DashboardView` (with a fixed server list), `ServerPairingScreen` and
  `ChatView` and asserts key labels. It must pass before and after every step.
- `./gradlew :app:testDebugUnitTest :app:assembleRelease` after each commit.
- Manual pass on an emulator: sign in → dashboard → add server → open chat →
  security → back. Screenshots before/after should match.

**Exit:** no file over 400 lines; `feature/cloud/` gone; screenshots unchanged.

---

## 4. Phase 2 — State holders and a shared screen-state model

1. Add `lifecycle-viewmodel-compose`. One ViewModel per feature:
   `AuthViewModel`, `HomeViewModel`, `PairingViewModel`, `ChatViewModel`,
   `SecurityViewModel`, each exposing an immutable `StateFlow<UiState>`.
2. Introduce the guide's shared model in `core/common`:

   ```kotlin
   sealed interface LoadState<out T> {
       data object Loading : LoadState<Nothing>
       data class Content<T>(val value: T, val updatedAt: Instant?) : LoadState<T>
       data class Error(val message: String, val canRetry: Boolean) : LoadState<Nothing>
   }
   ```

   Plus explicit `Unauthorized` and `Offline` handling so session expiry is
   not detected by string-matching `"401"`. `ControlPlaneClient` throws a
   typed `ApiException(status)` instead.
3. Repositories (`ServerRepository`, `SessionRepository`, `PolicyRepository`)
   wrap `ControlPlaneClient` and `GatewayClient`; ViewModels depend on them,
   never on the clients directly.
4. **DI:** start with a hand-written `AppContainer` created in `MainActivity`.
   Adopt Koin (lighter than Hilt for a single-module app) only if the
   container grows unwieldy. The spec allows either.
5. Shared components: `EmptyState`, `ErrorState`, `OfflineBanner`,
   `LoadingSkeleton`. Every network screen renders all `LoadState` branches,
   with no blank screens or endless spinners.

**Tests:** a unit test per ViewModel against a fake repository, covering
loading → content, error → retry, and 401 → signed out.
**Exit:** no `rememberCoroutineScope()` network calls left in composables.

---

## 5. Phase 3 — Real theming (light mode works)

1. Replace every `Dash.*` reference with `MaterialTheme.colorScheme.*` or a
   semantic extension (`FridayColors.statusOk`, etc.) provided through a
   `CompositionLocal` in `FridayOneTheme`.
2. Delete the `Dash` object.
3. Typography roles (display/headline/title/body/label) in the theme;
   monospace only for commands and logs.
4. Spacing and shape tokens from the guide (4dp grid; chip 10–12dp,
   button 14–16dp, card 18–22dp, sheet 24–28dp).

**Tests:** screenshot tests of Home, Pairing and Chat in both themes; a
contrast check on text/background pairs.
**Exit:** `grep -r "Dash\." app/src/main` returns nothing; light theme passes visual review.

---

## 6. Phase 4 — Navigation shell

1. Add Navigation Compose. Routes: `home`, `chats`, `servers`,
   `servers/{id}`, `pairing`, `session/{serverId}`, `approvals`,
   `security`, `settings`.
2. Bottom bar: **Home, Chats, Create, Servers, Settings**. Create opens a
   bottom sheet (New Session · Add Server · Review Approvals) and never
   executes anything directly.
3. The OAuth deep link (`fridayone://auth-callback`) and the pairing deep
   link (`fridayone://pair`) become navigation deep links.
4. Replace the "0 servers → open pairing automatically" behaviour with the
   guide's Add Server / Continue Setup card on Home.

**Tests:** navigation tests for each tab and deep link; system back closes
sheets and pops the stack correctly.

---

## 7. Phase 5 — Honest server status

1. Parse `last_seen_at` into `CloudServer` and replace `online: Boolean` with
   a `ServerStatus` enum: `Online`, `Connecting`, `Stale`, `Offline`,
   `Revoked`, `Unknown`. Thresholds are owned by one function, e.g. Online
   < 2 min, Stale < 10 min, otherwise Offline; Revoked from
   `enrollment_state`.
2. A single `ServerStatusChip` maps status → label + icon + colour (text and
   icon, never colour alone). Home summary counts Online / Stale-or-Offline /
   pending approvals.
3. "Last seen 2 min ago" freshness on every server row, updating on a timer.
4. **Backend dependency:** OS metadata and connector version are not stored
   today. Add columns plus reporting in `connector.hello` (connector →
   gateway → `servers`), then surface them. Until then the UI omits those
   fields instead of showing placeholders.

**Tests:** unit tests for the status thresholds and their boundaries.

---

## 8. Phase 6 — Missing screens

Ordered by user value; each ships with its own loading/empty/error states.

1. **Server detail:** status and heartbeat, agents with versions and health,
   recent jobs, policy summary, and a clearly separated **Revoke server
   access** action behind a `ConfirmActionDialog`. Rename and re-pair here.
2. **Approvals inbox and detail:** exact operation, target server and agent,
   requester, timestamp, expiry countdown and payload hash. Approve/Deny,
   with a confirmation step for high-risk operations. Expired requests become
   read-only. Replaces the minimal inline card in chat.
3. **Session list:** sessions by server and agent (needs a sessions endpoint
   or the jobs list grouped by session).
4. **Audit:** filters by server, agent, event, outcome and time; shows
   correlation ID and policy decision.
5. **Settings:** profile, sign-out, theme (system/light/dark), privacy and
   retention, installation guide, troubleshooting, app version.
6. **Diagnostics:** gateway connectivity, last heartbeat, connector version.

Remove the `"/tmp/friday-acp-test"` fallback root in chat. With no reported
projects, show an empty state that explains how to set `FRIDAY_ALLOWED_ROOTS`.

---

## 9. Phase 7 — Quality, accessibility and release gates

- Accessibility: 48dp touch targets, content descriptions on icon-only
  buttons, heading semantics, TalkBack pass, largest font scale with no
  clipping, copy actions announced.
- Reliability: Room cache for the server list labelled with its updated
  time; gateway reconnect with bounded backoff and jitter; bounded
  transcript buffer with pagination.
- Instrumented tests (emulator in CI): sign-in, pairing happy path with a
  fake backend, approval allow/deny, session expiry → sign-in.
- PRD §11 release gates: real-device build, real VPS pairing,
  cross-user/revocation tests and privacy/retention docs. Release only when all pass.

---

## 10. Out of scope here, tracked elsewhere

- Certificate pinning, the biometric gate and the stable gateway hostname
  (F-22 / F-01 in `todo.md`). The pinned hostname is a prerequisite for
  pinning, and the gateway URL is still a quick tunnel in `build.gradle.kts`.
- Retrofit and a multi-module Gradle split. The spec lists Retrofit, but the
  control-plane API is small; revisit once Phase 2 repositories exist.
  Multi-module is worth it only if build times or ownership boundaries demand it.

## 11. Open decisions (owner)

1. Koin vs. Hilt if a DI framework is adopted (recommendation: Koin, or none
   until needed).
2. Stale/Offline thresholds (proposed 2 min / 10 min).
3. Which operations count as high-risk and need a confirmation step or biometrics.
4. Whether email + password sign-in stays alongside Google OAuth (the PRD
   specifies Google OAuth only).
