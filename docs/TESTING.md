# FRIDAY One — Testing

Every number below comes from an actual run on 2026-10-27 (Windows 11, Node
22.23.2, JDK 17), recorded in [FIREBASE_MIGRATION_STATUS.md](FIREBASE_MIGRATION_STATUS.md).
"Emulator" means the Firebase Local Emulator Suite under the
`demo-friday-one` project: no real project or data is touched.

## 1. Suites

| Suite | Kind | Command | Cases | Last result |
|---|---|---|---|---|
| Firestore rules | security (emulator) | `cd firebase/rules-tests && npm test` | 34 (R-1…R-12) | 34/34 |
| `/api/v1` functions | integration (Auth + Firestore emulators) | `cd firebase/functions && npm test` | 21 (A-1…A-10) | 21/21 |
| Gateway | integration (emulators + real WebSockets) | `cd gateway && npm test` | 7 unit + 15 (G-1…G-9) | 7/7, 15/15 |
| Migration: transform | unit | `cd firebase/migrate && node --test test/transform.test.mjs` | 13 | 13/13 |
| Migration: export | integration (fake Supabase) | `… test/export.test.mjs` | 3 | 3/3 |
| Migration: import/reconcile | integration (emulators; drives the built functions) | `cd firebase/migrate && npm test` | 6 | 6/6 |
| Android | unit + Robolectric Compose | `cd android && ./gradlew :app:testDebugUnitTest` | 25 | 25/25 |
| Connector | unit | `cd connector && npm test` | 8 | 6/8 on Windows (2 tests assume Linux paths; expected to pass on CI) |
| Control plane (legacy) | integration (fake Supabase) | `cd control-plane && npm test` | 4 (F-M9) | 4/4 |
| Legacy gateway hotfix | integration (fake Supabase) | on `master`: `cd gateway && npm test` | F-M14 | pass |

## 2. Mutation checks (do the tests catch a real regression?)

| Change made on purpose | Tests that failed |
|---|---|
| Rules: `servers` writable by the owner | 4 (R-4, R-11) |
| API: remove the jobs ownership check / the claim attempt budget | 2 |
| Gateway: remove the approval owner check / the revocation listener | 4 |
| Android: `close()` waits for the server's handshake again | 1 |

## 3. Local requirements

- Node 22. JDK **21** for firebase-tools 15 (the version in the lockfiles).
  With only JDK 17, run the emulator suites through firebase-tools 13, as
  the dated results above were:
  `npx -y firebase-tools@13 emulators:exec --config <firebase.json> --project demo-friday-one --only auth,firestore "<test command>"`.
- Android: JDK 17 for Gradle, the SDK path in `android/local.properties`.
- The migration import test needs `firebase/functions` built (`npm run build`).

## 4. CI (`.github/workflows/ci.yml`)

Jobs: `cloud` (typecheck + tests for gateway, connector and control-plane;
Java 21 for the gateway's emulator tests), `firestore-rules`, `functions`,
`migrate`, `android` (unit tests + release build), `gitleaks`.
**None of the Firebase jobs has run on GitHub Actions yet**: nothing has
been pushed.

## 5. Not covered by automated tests

| Area | Why | Where it gets tested |
|---|---|---|
| Forged-signature ID tokens | the Auth emulator issues unsigned tokens | staging (A-1b) |
| Trusted client-IP header position on Google's front end | no front end locally | staging (A-3b) |
| Cloud Run WebSocket lifetime, single-instance behaviour, reconnect | no Cloud Run locally | staging (G-6) |
| Google sign-in on a device, App Check | needs console setup and fingerprints | device test on dev, then staging |
| Real agent execution (OpenCode, Hermes) | needs a VPS | E-1 on staging |
| Instrumented Android UI (biometrics, WebView) | needs an emulator or device | not started (alignment plan Phase 7) |
| Password-only users signing in with Google | Firebase account-linking behaviour | staging, before production |

## 6. End-to-end acceptance (E-1, staging + a VPS)

1. Sign in with Google on a device (debug build, dev project).
2. Pair a VPS by QR, and a second by numeric key.
3. Run an OpenCode prompt and watch it stream; cancel one mid-stream.
4. Add a `deny` policy, then a `require_approval` one; approve and deny.
5. Let the gateway hit its 60-minute limit and confirm both sides reconnect.
6. Revoke the server: the connector disconnects (4403) and cannot reconnect.
7. Check the audit list contains each step and no tokens or credentials.
