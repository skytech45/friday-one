# FRIDAY One — Threat Model

**Date:** 2026-10-23
**Scope:** `~/friday-one` — a private, single-operator Android control client that manages Hermes and OpenCode on an owner-operated Linux host.

---

## 1. System in one paragraph

A single-owner Android app talks to a Fastify backend over a public Cloudflare quick tunnel. The backend holds a PostgreSQL database, exposes a filesystem browser scoped to a configured root, and spawns a remote terminal (Hermes TUI, OpenCode, or a login shell) on the host. Authentication is a password plus a 15-minute JWT and a 30-day opaque refresh token; a "device" is trusted by a database flag. The whole thing is one operator, one phone, one server — and the entire security model reduces to: *who holds a valid session token, and what can that token reach?*

---

## 2. Assets

| # | Asset | Where it lives | Why it matters |
|---|---|---|---|
| A1 | `JWT_SECRET` | `server/.env` (0600) | The single key to the whole system. Possession = mint any token = bypass every authorisation check. |
| A2 | `DATABASE_URL` (DB password) | `server/.env`, `infra/.env` | Database access; the role is a **superuser** (F-09) |
| A3 | `FINGERPRINT_PEPPER` | `server/.env` | Without it, stored device fingerprints can be pre-computed and forged |
| A4 | `~/.hermes/auth.json` | 0600 on disk | Live agent API credentials — the agents can reach the owner's other accounts |
| A5 | `~/.ssh/authorized_keys` | 0600 on disk | Persistent access to the host for whoever holds the key |
| A6 | Device refresh token (30 days) | DataStore on the phone | Long-lived session; replayable on a different device is detected, but replay on the same device is not |
| A7 | Access token (15 minutes) | DataStore + **server journal** | Bearer credential that also opens the terminal |
| A8 | The owner's account + password | scrypt hash in Postgres | Root of trust for all authentication |
| A9 | Terminal sessions | host processes | Arbitrary command execution as `ubuntu` |
| A10 | The agent workloads (Hermes, OpenCode) | host processes | Hold MCP servers, plugins, tool permissions, and the owner's credentials |
| A11 | Host integrity | the Ubuntu box | Contains the other applications (SwiftFetch admin on `:8080`, the Hermes gateway on `:8642/:8644`, Tailscale) |
| A12 | Audit trail | `audit_log` table | The record of who did what — and its `ip` column is attacker-controllable (F-05) |
| A13 | The tunnel hostname | public gist | The address of the system; published by design |
| A14 | The APK | the owner's phone | A release signed with the debug key (F-14) — a known key to everyone |

---

## 3. Actors

| Actor | Capability | Motivation |
|---|---|---|
| **Owner** | Full legitimate access | Operate the box from the phone |
| **Attacker — opportunistic** | Found the tunnel URL (it is published in a public gist) | Free compute, free file storage, a shell on a cloud host |
| **Attacker — targeted** | Knows the owner, targets the host | Credentials, SSH, the other services on the box |
| **Attacker — network position** | On-path between the phone and the tunnel | Session interception (no pinning — F-01) |
| **Physical attacker** | The lost or borrowed phone | Terminal access, no biometric gate (F-01) |
| **Compromised agent** | Hermes or OpenCode acting on hostile input | Prompt injection → tool use → the owner's credentials. Both agents run as `ubuntu` with full filesystem and env access (F-10) |
| **Hostile content** | A file the agent reads, a repo the agent clones, a page the agent fetches | Prompt injection into the agent |
| **Cloudflare / tunnel operator** | Controls DNS and the tunnel edge | Out of scope, but the trust anchor for the app's TLS |

---

## 4. Attack surfaces

| Surface | Entry point | Controls in place | Weakness |
|---|---|---|---|
| **S1 · Public tunnel** | `https://*.trycloudflare.com` | TLS, app-layer auth, registration allowlist | No IP allowlist, no Cloudflare Access, no mTLS, no rate limit on discovery. The hostname is public (F-22) |
| **S2 · Registration** | `POST /auth/register` | `ALLOWED_EMAILS` | Fails **open** when unset (F-04) |
| **S3 · Login** | `POST /auth/login` | scrypt, per-account lockout, per-IP throttle | Per-IP throttle spoofable (F-05); account lockout is a **DoS vector** against the owner |
| **S4 · Session** | `Authorization: Bearer` | 15-minute expiry, refresh rotation + fingerprint binding | No `exp` requirement (F-08), any HMAC alg (F-06), revocation not immediate (F-07), token logged (F-03) |
| **S5 · Filesystem** | `GET/POST /fs/*` | `safePath` containment, trust gate | Root is the whole home dir (F-02); the jail is correct but the target is wrong |
| **S6 · Terminal (WebSocket)** | `GET /ws/terminal` | JWT in query, trust gate, command allowlist | General-purpose `bash -l`; the child inherits the server's secrets (F-10); the token is logged (F-03); no resource caps (F-17) |
| **S7 · Crash reports** | `POST /crash` | Rate limit only | Unauthenticated write into the owner's console (F-12) |
| **S8 · Android client** | The APK on the phone | DataStore, backup excluded, biometric class (unused) | All four security classes are dead code (F-01); release signed with the debug key (F-14); no tests (F-15) |
| **S9 · Discovery** | The public gist | `https://` required, `/health` must answer | Unsigned document — an attacker who can write the gist redirects the whole client (F-22) |
| **S10 · The host** | The agents, the terminal | `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` | Everything runs as `ubuntu`; `docker` group membership is root-equivalent; the API serves the files `ProtectHome` protects (F-02) |

---

## 5. Trust boundaries and what crosses them

```
[ Internet ]  --S1-->  [ Cloudflare edge ]  --S1-->  [ Fastify :8788, 127.0.0.1 ]
                                                            |
             +--S2/S3/S4 (auth)-------------------------------+
             |                                                  |
             +--S5 (files)------------> [ /home/ubuntu ] <-----+
             |                             ^                    |
             |                             | (the SAME dir the |
             |                             |  agents live in)  |
             |                                                  |
             +--S6 (terminal)---------> [ PTY: bash -l ] ------+
             |                             ^                    |
             |                             | inherits:          |
             |                             |  JWT_SECRET,       |
             |                             |  DATABASE_URL      |
             |                             +---> [ .ssh, .hermes, .env ]
             |
             +--S8 (phone) <-------------- [ DataStore on device ]
```

**The two boundaries that matter most, and they are the weak ones:**

1. **Authenticated session → filesystem.** The mechanism (`safePath`) is sound. The *configuration* makes it a full home-directory read. This boundary is effectively open.
2. **Server process → secrets.** `ProtectHome=read-only` stops the *process* from writing; it does not stop the process from *serving* those files over HTTP, which is exactly what `/fs/download` does. The OS boundary is bypassed by an application feature.

**The one boundary that holds:** an authenticated session cannot become **root**, because `NoNewPrivileges=true` is inherited by the terminal child and blocks `sudo`. That single flag is doing more work than any other control in the system, and it is not currently even installed (F-16, F-22).

---

## 6. Abuse cases

### AC-1 · Opportunistic takeover via anonymous registration
**Actor:** opportunistic · **Surface:** S2 · **Precondition:** `ALLOWED_EMAILS` is empty or the deployment omits it.
**Chain:** read the tunnel hostname from the public gist → `POST /auth/register` → receive `trusted: true` → `/fs/download` the owner's home → `server/.env` → `JWT_SECRET` → mint any token → `/ws/terminal?kind=shell` → shell as `ubuntu` → (blocked at root by `NoNewPrivileges`).
**Verified:** the first four links were executed end-to-end in isolation. **Current status:** closed, because `ALLOWED_EMAILS` *is* set — one address. The default is what fails open.

### AC-2 · Token theft → home directory
**Actor:** network position, or anyone with journal access · **Surface:** S1/S4/S6
**Chain:** the WebSocket token is written to the journal (F-03) → read the journal → use the token within its 15-minute life → `/fs/download` `.hermes/auth.json` and `.ssh/authorized_keys` → persistent access to the agent credentials and the host.
**Verified:** the journal write and the file downloads were both executed.

### AC-3 · Lost phone → terminal
**Actor:** physical · **Surface:** S8
**Chain:** the phone is lost → no biometric gate (F-01) → the app opens → the terminal tab → a shell as `ubuntu` → read `.hermes/auth.json`.
**Verified:** the absence of the gate was established by exhaustive call-site analysis. The terminal's capability was executed.

### AC-4 · Revoked device that is not actually revoked
**Actor:** physical or a token thief · **Surface:** S4
**Chain:** revoke the device → the refresh tokens die and the WebSocket is refused (both work) → but the access token still reaches `/system` for up to 15 minutes (F-07).
**Verified:** measured.

### AC-5 · Brute force past the IP throttle
**Actor:** opportunistic · **Surface:** S3
**Chain:** rotate `X-Forwarded-For` → the per-IP throttle never triggers (F-05) → unlimited password guesses against the account.
**Bounded by:** the per-account lockout, which is keyed on the user id in Postgres and survived every test. The lockout steps 1m → 5m → 15m → 60m → 24h, and it is the owner's own account, so this is also a **denial-of-service against the owner**: five wrong passwords lock the owner out for an hour, and repeated lockouts extend to 24 hours.
**Verified:** the XFF bucket reset was measured; the lockout behaviour was measured.

### AC-6 · Prompt injection into the agent
**Actor:** hostile content or a hostile repository · **Surface:** S6, S10
**Chain:** the owner opens the terminal → runs Hermes/OpenCode → the agent reads a malicious `README.md` or a cloned repo → the content instructs the agent to exfiltrate `.hermes/auth.json` or the `JWT_SECRET` from the environment → the agent has the filesystem access of `ubuntu` and the full server env (F-10) → the secrets leave.
**Verified:** the environment inheritance and the file readability were measured from inside the terminal.
**Bounded by:** nothing in the current design. The `NoNewPrivileges` flag blocks the *root* escalation but not the credential theft.

### AC-7 · Redirect the whole client
**Actor:** anyone who can write to the discovery gist · **Surface:** S9
**Chain:** compromise the GitHub account or token that owns the gist → write a new `endpoint.json` pointing at an attacker host that serves `/health` → every installed copy of the app adopts it on next launch → the owner's password and refresh token are posted to the attacker.
**Verified:** the discovery fetch and the two guards (`https://` required, `/health` must answer) were read and confirmed to be insufficient.

### AC-8 · Database escalation
**Actor:** any code execution on the host · **Surface:** S10
**Chain:** the terminal child has `DATABASE_URL` (F-10) → connects as `friday`, a **superuser** (F-09) → `BYPASSRLS`, `CREATEDB`, `CREATEROLE` → reads or rewrites every database on the host, including the data of the other applications.
**Verified:** the role's attributes were inspected live; the credential exposure was measured.

### AC-9 · Replace the app
**Actor:** anyone with the public Android debug key · **Surface:** S8
**Chain:** the release is signed with the well-known debug key (F-14) → an attacker produces an APK signed with the same key → the owner sideloads it (this app is not on the Play Store) → the attacker gets the session tokens.
**Verified:** the build configuration was read. Whether the installed APK is this build was **not** verified — no device was available.

---

## 7. Risk ranking

| Rank | Abuse case | Likelihood | Impact | Existing controls | Net |
|---|---|---|---|---|---|
| 1 | AC-1 anonymous takeover | Low (allowlist set) / High (default) | Critical | none in the default | **Critical** |
| 2 | AC-2 token theft → home dir | Medium | Critical | 15-min TTL | **Critical** |
| 3 | AC-6 prompt injection → credentials | Medium | High | none | **High** |
| 4 | AC-3 lost phone → terminal | Medium | High | none (F-01) | **High** |
| 5 | AC-7 redirect the client | Low | High | https + health check | **Medium** |
| 6 | AC-8 DB escalation via superuser | Low | High | loopback binding | **Medium** |
| 7 | AC-5 brute force / owner lockout | Medium | Medium | per-account lockout | **Low** |
| 8 | AC-4 revocation lag | Low | Low | trust gate | **Low** |
| 9 | AC-9 replace the app | Low | High | none | **Low** |

**The most important structural observation:** the system's security is a single chain, and its weakest link is at the *ends* — the Android client (which cannot be bound to a device) and the file root (which contains the keys to everything). The middle of the chain — the Fastify auth implementation — is genuinely good.

---

## 8. What the model says a single-operator design should do differently

The brief's own framing ("private single-operator application") invites a different architecture than a multi-tenant SaaS:

1. **One owner means one device.** The elaborate device-trust model (fingerprint, approval, revocation) exists because *anyone with the password* could otherwise use the terminal. But the password is already the owner's secret, and the tunnel is the only path in. **A TOTP/passkey in front of the terminal** would be simpler, stronger and cheaper than the entire device-binding apparatus — and it would not depend on a client that cannot be trusted (F-01).
2. **The agents and the control plane should not share a user.** Everything runs as `ubuntu` with the same home directory. A dedicated `friday` user for the server, a dedicated `friday-agent` user for the agents, and a dedicated `friday-file` root for the file API would convert most of the current findings from "app-layer logic" into "OS-enforced", and would make the `sudo` question moot.
3. **The discovery gist should not be a trust anchor.** A fixed hostname with certificate pinning is simpler and stronger.
4. **A general shell is a decision, not a default.** `COMMANDS.shell = "bash -l"` should be an explicit, documented, and deliberately-accepted capability — or removed. The current code is honest about this in its comments, which is to its credit, but the product framing ("Hermes and OpenCode") undersells what is exposed.
