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

The google-services plugin matches by application ID. Debug builds use
`com.friday.one.debug`, so the dev project needs a **second Android app**
registered with that ID (decision D6). Today `google-services.json` lists only
`com.friday.one`, which would fail every debug build once the plugin is applied.
