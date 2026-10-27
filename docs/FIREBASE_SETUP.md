# FRIDAY One — Firebase Setup

What is version-controlled, what must be done in the console or with `gcloud`,
and in what order. Status of each step per project:
[FIREBASE_MIGRATION_STATUS.md](FIREBASE_MIGRATION_STATUS.md).

## In the repository (`firebase/`)

| File | Purpose |
|---|---|
| `firebase.json` | rules/index paths, emulator ports (auth 9099, firestore 8080, functions 5001) |
| `.firebaserc` | aliases `default` (demo), `dev`, `staging`, `prod` |
| `firestore.rules` | security rules (FIRESTORE_SECURITY_RULES.md) |
| `firestore.indexes.json` | composite indexes + unindexed `detail` / `resultSummary` maps |
| `rules-tests/` | emulator-backed rules tests (34 cases) |
| `env.example` | placeholder configuration |

Deploys from this folder (only after authorization, never from a laptop for prod):

```bash
cd firebase
npx firebase-tools deploy --only firestore:rules,firestore:indexes --project dev
```

## Manual / console steps (one-time per project)

| # | Step | Why manual | Blocking |
|---|---|---|---|
| 1 | Create the project (staging, prod) | D1 | everything |
| 2 | Upgrade to **Blaze** and set a **budget alert** | Functions, Cloud Run and Secret Manager need billing (D5) | functions, gateway |
| 3 | Create the Firestore database in **Native mode** in the chosen region | the region is **permanent** (D4) | rules deploy |
| 4 | Auth → enable **Google** provider; set the support email | console | sign-in |
| 5 | Register Android apps `com.friday.one` (+ `com.friday.one.debug` in dev) with **SHA-1 and SHA-256** of the debug and release keys | Google sign-in and Play Integrity need the fingerprints | sign-in, App Check |
| 6 | App Check → register the Android apps with **Play Integrity**; add debug tokens for emulators | console | Phase 5 |
| 7 | Firestore TTL policies on `expireAt` for `auditEvents`, `jobs`, `permissionRequests`, `enrollments`, `enrollmentTokens`, `rateLimits` | not in `firebase.json` | retention |
| 8 | Workload Identity Federation pool for GitHub OIDC + a deploy service account with least-privilege roles | IAM | CI deploy |
| 9 | API key restrictions on the Android key (Android apps + SHA-1) | console | hardening |

Step 7 commands (repeat per collection group):

```bash
gcloud firestore fields ttls update expireAt --collection-group=auditEvents --enable-ttl --project <id>
```

## Local development

- Node 22, JDK **21** for firebase-tools 15 (JDK 17 works with firebase-tools 13).
- `cd firebase/rules-tests && npm ci --ignore-scripts && npm test`.
- Emulators use `demo-friday-one`: no credentials needed, nothing leaves the machine.
