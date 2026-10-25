# FRIDAY One — Remaining Work

**Last updated:** 2026-10-25
**State:** 4 findings open, plus RR-05 (shared host); RR-09 mitigated
**Rule:** each item ships with a regression test and is re-executed before it is
called done. A fix that has only been described is not a fix.

Completed work is in [`task-complete.md`](task-complete.md). Full detail for every
finding is in [`audit/findings.md`](audit/findings.md); the reasoning behind the
ordering is in [`audit/remediation-roadmap.md`](audit/remediation-roadmap.md).

---

## P0 — do before the service is exposed to the internet again

*(F-14 is DONE — 2026-10-25. The keystore lives at `~/.android-keys/` on the
deployment host, outside the repo; `FRIDAY-One-v0.7-release.apk` is signed with
it and verified by `apksigner`. The owner should back that keystore up
off-host — losing it means every future update needs a reinstall.)*

### 1. F-22 → F-01 · Stable hostname, then wire the client's security

**Order matters:** pinning a Cloudflare **quick tunnel** is pointless — it issues
a new certificate on every restart. The named tunnel must land first or the pins
churn constantly and pinning gets disabled "temporarily" and never restored.

**2a. F-22 — named tunnel + authenticated discovery**

- `scripts/setup-named-tunnel.sh` is written but unexecuted. It requires **DNS
  delegation of `knistudio.in` to Cloudflare at GoDaddy** — an owner action, and
  the script exits early and says so if the zone is not delegated.
- Then: bake `https://friday.knistudio.in` into the APK as `FRIDAY_BASE_URL` and
  drop the gist fetch from startup (or keep it only as a signed fallback).
- Current state (updated 2026-10-25): the API and tunnel units **are installed
  and live** — the app reaches the backend through the quick-tunnel URL
  published to the discovery gist. The named tunnel still needs the DNS
  delegation for pins to be meaningful (2a below).

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

### 2. F-16 · Give the terminal a dedicated unprivileged account

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
| 4 | **F-20** | **DONE 2026-10-25.** `friday-one` is public (owner's choice), so Actions minutes are unlimited: the pipeline runs green on every push — audit, typecheck, 20 unit tests, Android test job, gitleaks, and the full 74-check e2e + F-09 suite against a real `postgres:16-alpine`. `scripts/ci.sh` also gates every push locally via the pre-push hook. (An earlier transfer to a second GitHub account failed server-side and is moot — CI works without it.) |
| 5 | F-23 | Retention policy for unlinked crash reports and a delete endpoint. Unlinked reports are never served now (F-12 is done), but they still accumulate unbounded. |

---

## Operational blockers (not code)

Both are in [`audit/residual-risk-register.md`](audit/residual-risk-register.md)
and neither will show up as an incident until the day it matters.

### RR-09 · No backup, no restore, no history — **MITIGATED 2026-10-25**

Done: off-host git remote (private `skytech45/friday-one`, deploy-key scoped),
nightly `pg_dump -Fc` pushed to a second private repo
(`skytech45/friday-one-backups`) with full git-history retention, a 04:35
systemd timer (`friday-one-backup.timer`), and a **restore drill that passed**
(6 tables / 3 users / 3 devices verified from the dump). Remaining: snapshot
the Postgres volume before every migration (manual, Phase 1+ discipline).

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
   isolate it properly (item 2), remove `shell` from `COMMANDS` and keep only
   `hermes` and `opencode`, or require a second factor for that specific kind.
2. **Keep `/auth/register` live, or provision only via `seed-owner.ts`?**
   Removing it eliminates a whole class of risk and lets the client drop its
   "Create account" mode.
3. **Move the control plane to its own host?** (RR-05)
4. **Back up (or replace) the release keystore.** It was generated 2026-10-25 at
   `~/.android-keys/friday-release.jks` on the deployment host. Copy it to
   off-host storage; losing it permanently locks out in-place app updates.

---

## Suggested order

| Batch | Items | Why together |
|---|---|---|
| 1 | F-22 (needs DNS), then F-01 | Pins are meaningless without a stable hostname. (F-14 is done — `FRIDAY-One-v0.7-release.apk` is release-signed.) |
| 2 | F-16, then F-23 | Terminal OS account isolation; crash-report retention |
| 3 | F-20 finish | Accept the repo transfer to `skyedu-ai`; verify Actions runs. (F-11/F-12/F-14/F-15/F-17/F-21/F-24/F-25/F-26 are done.) |
| 4 | RR-05 | Operational, not code (RR-09 is mitigated) |
