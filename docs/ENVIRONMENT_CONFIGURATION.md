# FRIDAY One — Environment Configuration

Example with placeholders: [`firebase/env.example`](../firebase/env.example).

## Environments

| Alias (`firebase/.firebaserc`) | Project | Purpose | Status |
|---|---|---|---|
| `default` | `demo-friday-one` | Emulator only. The CLI refuses to deploy `demo-*` IDs, so a bare `firebase deploy` is harmless. | in use (tests) |
| `dev` | `friday-969ea` | Development | **exists**; nothing deployed; role pending decision D1 |
| `staging` | `REPLACE-friday-one-staging` | Pre-production, migration rehearsal | not created |
| `prod` | `REPLACE-friday-one-prod` | Production | not created |

Separate projects give separate Auth user pools, Firestore databases,
quotas, billing alerts and IAM, so a dev mistake cannot touch production data.

## What goes where

| Value | Kind | Where it lives | In git? |
|---|---|---|---|
| Firebase Android config (`google-services.json`) | client config: identifies the project; **not** a secret, but environment-specific | `android/app/src/debug/` and `android/app/src/release/` per variant | **No** (git-ignored); CI injects it from a CI variable |
| Firebase web API key inside it | public identifier, restricted by API-key restrictions + App Check + rules | same | No |
| Control-plane / gateway URLs | config | Gradle `-P` properties, connector env file | defaults only |
| Supabase-era `SUPABASE_SECRET_KEY` | secret | Vercel env + gateway env (until retirement) | No |
| Gateway Firestore access | identity | Cloud Run runtime service account (no key) | No |
| CI deploy identity | identity | GitHub OIDC → Workload Identity Federation → deploy service account | No JSON key anywhere |
| Connector credential | secret | `/etc/friday-connector/credential` (0600) on each VPS; only its SHA-256 is stored server-side | No |
| Release keystore | secret | `~/.android-keys/` on the build host | No |

**Never** commit a service-account JSON. `.gitignore` blocks
`*service-account*.json` and `*-firebase-adminsdk-*.json`, and gitleaks runs
in CI.

## Android variants

The google-services plugin matches by application ID, so each variant has
its own git-ignored config:

| Variant | App ID | Config file | Backend (`AUTH_PROVIDER`) | Status |
|---|---|---|---|---|
| debug | `com.friday.one.debug` | `android/app/src/debug/google-services.json` (dev project) | `firebase` | **file missing**: register the debug app (D6) and add its SHA-1/SHA-256 |
| release | `com.friday.one` | `android/app/src/release/google-services.json` | `supabase` until cutover | file present locally (moved from `android/app/`); no Android OAuth client (SHA-1) yet |

The plugin runs with `missingGoogleServicesStrategy = WARN`: a variant
without a config (CI, fresh clones) still builds, and the app shows "Sign-in
is not configured for this build" instead of crashing (test `AuthFlowTest`).

Gradle properties: `AUTH_PROVIDER` (`firebase` | `supabase`),
`FIREBASE_API_URL` and `FIREBASE_GATEWAY_URL` (debug), and `CONTROL_PLANE_URL`
and `GATEWAY_URL` (release).
