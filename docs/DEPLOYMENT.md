# FRIDAY One — Deployment (Firebase stack)

**Status:** nothing below has been run yet. These are the intended commands,
for an operator with access to the project, after the console steps in
[FIREBASE_SETUP.md](FIREBASE_SETUP.md). Production deploys need explicit
authorization (migration plan §3). The legacy stack's procedure is unchanged
in [DEPLOY.md](DEPLOY.md) until cutover.

Region everywhere: `asia-south1` (decision D4). `<project>` is
`friday-969ea` (dev), or the staging/prod IDs once created (D1).

## 1. Firestore rules and indexes

```bash
cd firebase
npx firebase-tools deploy --only firestore:rules,firestore:indexes --project dev
```

Then create the TTL policies (FIREBASE_SETUP.md, step 7).

## 2. `/api/v1` Cloud Function

```bash
cd firebase
npx firebase-tools deploy --only functions --project dev
```

- The `predeploy` hook builds `functions/` (`tsc`), so only `lib/` is shipped.
- Settings live in `functions/src/index.ts`: 30 s timeout, 256 MiB,
  `maxInstances: 10`, `concurrency: 40`, no CORS.
- Base URL for clients: `https://asia-south1-<project>.cloudfunctions.net/api`
  (Android `FIREBASE_API_URL`, connector `FRIDAY_CONTROL_PLANE_URL`).
- Optional rate-limit overrides (`RL_*`) and `ROTATE_GRACE_SECONDS` go in
  `functions/.env.<project>`. None are secrets.

**Smoke test** after deploy:

```bash
curl -s https://asia-south1-<project>.cloudfunctions.net/api/api/v1/health
```

Expected: `{"ok":true,"service":"friday-one-control-plane","gateway_url":...}`.
A request with no token to `/api/v1/servers` must return `401`.

## 3. Realtime gateway on Cloud Run (decision D3)

One-time: create a runtime service account with only what the gateway needs:

```bash
gcloud iam service-accounts create friday-gateway --project <project>
gcloud projects add-iam-policy-binding <project> \
  --member serviceAccount:friday-gateway@<project>.iam.gserviceaccount.com \
  --role roles/datastore.user
gcloud projects add-iam-policy-binding <project> \
  --member serviceAccount:friday-gateway@<project>.iam.gserviceaccount.com \
  --role roles/firebaseauth.viewer   # verifyIdToken(checkRevoked)
```

Deploy from source (Cloud Build uses `gateway/Dockerfile`):

```bash
gcloud run deploy friday-gateway \
  --source gateway \
  --region asia-south1 \
  --project <project> \
  --service-account friday-gateway@<project>.iam.gserviceaccount.com \
  --min-instances 1 --max-instances 1 \
  --concurrency 1000 \
  --timeout 3600 \
  --no-cpu-throttling \
  --session-affinity \
  --set-env-vars FIREBASE_PROJECT_ID=<project> \
  --allow-unauthenticated
```

Why each flag matters:

| Flag | Reason |
|---|---|
| `--max-instances 1` | **Required.** Routing (`connectorsByServer`) and replay baselines are in process memory; a second instance would split connectors from their apps. |
| `--min-instances 1` + `--no-cpu-throttling` | Heartbeats, the idle sweep and revocation listeners run between requests. |
| `--timeout 3600` | Cloud Run ends WebSockets at the request timeout (max 60 min). The connector reconnects with backoff; the Android app must too (open item). |
| `--allow-unauthenticated` | The gateway authenticates every socket itself (ID token or connector credential). IAM auth would block the app and connectors. |

After deploy, publish the URL for `/health` discovery:

```bash
# Firestore: appConfig/gateway_url = { value: "wss://friday-gateway-<hash>-el.a.run.app" }
```

**Smoke test:** `curl https://<service-url>/` returns
`{"ok":true,"service":"friday-one-gateway"}`. A WebSocket whose first message
is not `auth.*` must close with 4401.

## 4. Android

- **Debug** (Firebase, dev project): put the dev project's config for
  `com.friday.one.debug` at `android/app/src/debug/google-services.json`, then
  `./gradlew :app:assembleDebug`. Overrides: `-PFIREBASE_API_URL=…`,
  `-PFIREBASE_GATEWAY_URL=wss://…` (empty = discover via `/health`).
- **Release** stays on Supabase (`AUTH_PROVIDER=supabase`) until cutover. For
  a Firebase release: `-PAUTH_PROVIDER=firebase -PCONTROL_PLANE_URL=… -PGATEWAY_URL=…`
  with the prod project's config in `src/release/`.

## 5. Connector

No code change. Point existing installs at the new URLs in
`/etc/friday-connector/env` and restart:

```bash
FRIDAY_CONTROL_PLANE_URL=https://asia-south1-<project>.cloudfunctions.net/api
FRIDAY_GATEWAY_URL=wss://friday-gateway-<hash>-el.a.run.app
sudo systemctl restart friday-connector
```

Existing credentials keep working once their hashes are migrated (plan §4).
