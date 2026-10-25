# FRIDAY One — Remaining Work

**Last updated:** 2026-10-25
**State:** 12 findings open, plus 2 operational blockers
**Rule:** each item ships with a regression test and is re-executed before it is
called done. A fix that has only been described is not a fix.

Completed work is in [`task-complete.md`](task-complete.md). Full detail for every
finding is in [`audit/findings.md`](audit/findings.md); the reasoning behind the
ordering is in [`audit/remediation-roadmap.md`](audit/remediation-roadmap.md).

---

## P0 — do before the service is exposed to the internet again

### 1. F-14 · Sign the release APK with a real key

**Why first:** it is the cheapest item on this list, it needs no other change,
and every build distributed with the debug key is signature-worthless.

`android/app/build.gradle.kts:32-39` currently does:

```kotlin
release {
    // "a real release keystore belongs in CI secrets, never in the repo."
    signingConfig = signingConfigs.getByName("debug")
}
```

The comment states the right intent; the code does the opposite. The Android
debug certificate's private key is public, so anyone can produce an "update"
signed with the same key.

**Do:**
1. Create a release keystore **outside the repo**:
   `keytool -genkeypair -v -keystore ~/.android-keys/friday-release.jks -alias friday -keyalg RSA -keysize 4096 -validity 10000`
2. Add a `release` signing config reading `RELEASE_STORE_FILE`, `RELEASE_STORE_PASSWORD`,
   `RELEASE_KEY_ALIAS`, `RELEASE_KEY_PASSWORD` from Gradle properties (never literals).
3. Point `buildTypes.release` at it.
4. Add `android/key.properties` and `*.jks` to `.gitignore` (already covers
   `android/key.properties`).

**Verify:** `apksigner verify --print-certs app-release.apk` shows the release
certificate and **not** the debug digest.
**Blocks:** nothing. **Blocked by:** nothing — the owner must supply the keystore.

---

### 2. F-22 → F-01 · Stable hostname, then wire the client's security

**Order matters:** pinning a Cloudflare **quick tunnel** is pointless — it issues
a new certificate on every restart. The named tunnel must land first or the pins
churn constantly and pinning gets disabled "temporarily" and never restored.

**2a. F-22 — named tunnel + authenticated discovery**

- `scripts/setup-named-tunnel.sh` is written but unexecuted. It requires **DNS
  delegation of `knistudio.in` to Cloudflare at GoDaddy** — an owner action, and
  the script exits early and says so if the zone is not delegated.
- Then: bake `https://friday.knistudio.in` into the APK as `FRIDAY_BASE_URL` and
  drop the gist fetch from startup (or keep it only as a signed fallback).
- Current state: the published quick-tunnel URL returns **HTTP 530**, and
  `friday-one-api.service` / `friday-one-tunnel.service` are **not installed**
  (`systemctl` reports `not-found`). Nothing is deployed.

**2b. F-01 — wire what already exists**

All of this is implemented and has **zero call sites**:

- `MainActivity.kt` — call `AppLock.authenticate()` before rendering the dashboard
  when a session exists; on Denied/Error, show the lock screen.
- `MainActivity.kt` — call `DeviceIntegrityGate().evaluate()` at startup and send
  the verdict with register/login (the DB columns already exist).
- `CertificatePinning.kt` — populate `TUNNEL_PINS` with the real SPKI pins of the
  stable hostname (the rotation procedure is already documented in the class).
- Replace every `ApiClient.create(...)` call with
  `NetworkModule.createApi(context, baseUrl, sessionStore)`.
- `Api.kt` — register `TokenRefreshAuthenticator` on the shared OkHttp client.

**Verify:** instrumented tests — biometric prompt required before the dashboard;
a non-loopback host with an untrusted certificate fails the handshake; no
`ApiClient.create` call remains in `MainActivity`.
**Blocked by:** the DNS delegation (2a) for the pins to be meaningful.

**Owner decision:** if the client hardening is *not* going to be done, the docs
must be corrected to remove the pinning/biometric/binding claims. Shipping a doc
that describes controls the binary does not have is itself a finding.

---

## P1 — real risk, no owner blocker

### 3. F-16 · Give the terminal a dedicated unprivileged account

`NoNewPrivileges=true` is currently the single control between an authenticated
session and root, and it only works because `sudo` is blocked. It does **not**
stop reading `~/.hermes/auth.json`, `~/.ssh/authorized_keys` or `server/.env` —
and the terminal still runs as `ubuntu`, so `HOME` redirection is not a boundary
(the R-09 harness records the owner's home as **READABLE** by absolute path).

**Do:**
1. Create a `friday-agent` account: no sudo, no `docker` group, its own home.
2. Spawn the terminal via `setpriv --reuid=… --regid=… --clear-groups`.
3. Move Hermes and OpenCode's state under that account.
4. **Remove `ubuntu` from the `docker` group** — group membership is
   root-equivalent and survives `NoNewPrivileges`.
5. Add a startup assertion: refuse to serve the terminal when
   `/proc/self/status` shows `NoNewPrivs: 0` and the terminal is enabled.

**Verify:** from inside a terminal session — `id -u` is the agent uid,
`sudo -n id` fails, `docker ps` fails, and `~/.hermes/auth.json` is unreadable.
**Note:** this moves the owner's agent setup. Plan the migration.

---

## P2 — hygiene and the long tail

| # | Finding | Action |
|---|---|---|
| 5 | **F-20** | CI pipeline: `npm ci`, `npm audit --audit-level=high`, `tsc --noEmit`, the unit suite, `gitleaks`, Android lint + unit tests, and an `apksigner` release-signature assertion. Run `audit/audit-e2e.mjs` as an integration job — it is self-cleaning. |
| 6 | **F-15** | Android tests. JVM: `DeviceIdentity` fingerprint stability, `CertificatePinning` loopback/apply decision, `SessionStore.isExpiring` boundaries, `jsString` escaping. Instrumented: biometric gate, WebView origin policy. `junit` is declared and unused today; there are no `src/test` or `src/androidTest` directories at all. |
| 7 | **F-17** | Resource limits: cap concurrent terminal sessions, add a per-connection output budget, use `socket.pause()/resume()` for backpressure, and add `MemoryMax=` / `TasksMax=` to the systemd unit. |
| 8 | **F-21** | Record the vendored `xterm.js` version and SHA-256 in `assets/terminal/THIRD-PARTY.md`, add a CI hash check, and ship or strip the `sourceMappingURL` comment (the map is absent). |
| 9 | F-24 | Derive `platform` from the verified device key; render `name` as user-supplied. |
| 10 | F-25 | Keep `CORS_ORIGINS` explicit and never `*`; document that the API is not browser-facing. |
| 11 | F-26 | Stop storing the owner email in the audit `detail`; drop the hardcoded personal name in `seed-owner.ts`. |
| 12 | F-23 | Retention policy for unlinked crash reports and a delete endpoint. Unlinked reports are never served now (F-12 is done), but they still accumulate unbounded. |

---

## Operational blockers (not code)

Both are in [`audit/residual-risk-register.md`](audit/residual-risk-register.md)
and neither will show up as an incident until the day it matters.

### RR-09 · No backup, no restore, no history

There is version control now, but no off-host remote, no `pg_dump` schedule, and
no evidence that a restore has ever been performed. A bad migration or a disk
failure is currently unrecoverable.

**Do:** add an off-host git remote; schedule a nightly `pg_dump` to off-host
storage; **restore it once and prove it works.** A backup that has never been
restored is a hypothesis.

### RR-05 · The control plane shares a host with other services

This box also runs the Hermes gateway and the SwiftFetch admin panel. A
compromise of the control plane is a compromise of all of them.

**Do:** move the FRIDAY One control plane to its own host. The systemd hardening
protects the *service*, not the *box*.

---

## Decisions only the owner can make

These are not tasks I can complete unilaterally.

1. **Keep `kind=shell` (a general `bash -l`) or remove it?**
   The roadmap deliberately does not remove it silently. Options: keep it and
   isolate it properly (item 3), remove `shell` from `COMMANDS` and keep only
   `hermes` and `opencode`, or require a second factor for that specific kind.
2. **Keep `/auth/register` live, or provision only via `seed-owner.ts`?**
   Removing it eliminates a whole class of risk and lets the client drop its
   "Create account" mode.
3. **Move the control plane to its own host?** (RR-05)
4. **Supply the release keystore** (item 1).

---

## Suggested order

| Batch | Items | Why together |
|---|---|---|
| 1 | F-14 | No owner input, no dependencies, immediate risk reduction. (F-09 is done — committed as `2bb194b`.) |
| 2 | F-22 (needs DNS), then F-01 | Pins are meaningless without a stable hostname |
| 3 | F-16, F-17 | Isolation and resource caps; touches the deployment. (F-11 and F-12 are done — commits `60e5b1f`, `5dfdb00`.) |
| 4 | F-20, F-15, F-21, F-24, F-25, F-26 | Hygiene; CI first so the rest is enforced |
| 5 | RR-09, RR-05 | Operational, not code |
