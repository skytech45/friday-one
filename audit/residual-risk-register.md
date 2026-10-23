# FRIDAY One — Residual Risk Register

**Date:** 2026-10-23
**Purpose:** the risks that remain *after* every remediation in `remediation-roadmap.md` is applied. These are not findings — they are the properties of the design that no patch removes. Each entry states what the risk is, why it cannot be fixed in code, and what the owner is accepting by choosing this design.

---

## RR-01 · A single-owner system has a single point of failure: the password

**Accepted risk** · **Owner:** the account holder

The entire trust model reduces to one password (plus the 30-day refresh token on the phone). Lose the phone and the password together and the system is locked out; there is no recovery path, no second factor, no backup code, and the account lockout escalates to 24 hours after repeated failures — which means a stale password can lock the owner out of their own control plane for a day.

**Why it cannot be patched:** any recovery mechanism is itself an authentication mechanism, and a weaker one. The current state is honest: it is a single-factor system pretending to be multi-device.

**Mitigation options**
- A TOTP or passkey as the second factor on the terminal route only (see the threat model, §8) — this also resolves the reason the device-binding apparatus exists.
- A documented, encrypted, offline recovery file generated at `seed-owner` time and stored somewhere other than the phone.

**Owner acceptance:** the owner is accepting that the phone plus the password is the whole perimeter.

---

## RR-02 · The tunnel is a public, unauthenticated-by-network endpoint

**Accepted risk** · **Owner:** the operator

Even with the named tunnel, the server is reachable from the entire internet. The hostname is public by necessity — the app must find it. Every request therefore costs a full authentication attempt, and the app is one config change away from being an internet-facing password entry point.

**Why it cannot be patched:** the app's discovery model requires a publicly resolvable host.

**Mitigations that remain after remediation**
- The registration allowlist is closed by default (R-02) — an anonymous attacker cannot create an account.
- The account lockout bounds online guessing (R-07 fixes the IP throttle around it).
- The tunnel's own rate limiting sits in front of the app.
- The published URL is discoverable, but the *content* is not: every route requires a valid token.

**Residual:** a targeted attacker can always reach the login endpoint and lock the owner out (the lockout is a DoS vector against a single-user service, and the R-07 fix does not help because the account lockout is by design). **A single-user service cannot distinguish an attacker from the owner at the lockout layer.** Mitigation: a short lockout for the first few failures and a long one only after, plus an alerting channel so the owner learns about a lockout rather than discovering it.

---

## RR-03 · The remote terminal is a general-purpose shell on the host

**Accepted risk** · **Owner:** the operator — **this is the product**

`COMMANDS.shell = "bash -l"` is a deliberate, documented capability. No amount of hardening turns a root-adjacent shell into a limited one. Even after R-10 gives it a dedicated unprivileged account, the holder of a valid session gets an interactive shell on the owner's box.

**Why it cannot be patched:** it *is* the feature. The threat model's honest framing: the terminal is a remote command execution service for a single, trusted operator, with authentication as its perimeter.

**What remains after remediation**
- The child runs as a dedicated uid with no sudo and no docker group.
- Its environment contains no secrets.
- Its `HOME` is a dedicated directory, so `~/.hermes/auth.json` and `~/.ssh/authorized_keys` are not readable.
- The file API root is separate from the terminal's home.
- `NoNewPrivileges=true` remains as a backstop.

**Residual:** a shell is a shell. A vulnerability in `bash`, in a command the owner runs, or in a tool the agent invokes is still a code-execution path. The Hermes/OpenCode agents add a *second* execution surface: the agent runs with the same capabilities as the shell.

**The alternative** (see the roadmap): restrict the terminal to `kind=hermes` and `kind=opencode` and remove `kind=shell`. This materially shrinks the surface, at the cost of the owner's ability to run arbitrary commands from the phone. **This is a product decision the owner must make explicitly.**

---

## RR-04 · The agents run with the owner's ambient authority

**Accepted risk** · **Owner:** the operator

Hermes and OpenCode are spawned by the server and run as the service account. Whatever they can reach, a prompt injection in any content they read can reach. R-10 and R-11 remove the *server's* secrets from their reach, but the agent still has the owner's file access, the owner's network egress, and its own configured tools (MCP servers, plugins, skills) — which may each hold credentials of their own.

**Why it cannot be patched:** the agent is a general-purpose assistant with tool access. Isolating it fully means isolating it from the work it is meant to do.

**What remains after remediation**
- No `JWT_SECRET`, no `DATABASE_URL` in the agent's environment (R-09, R-11).
- A dedicated `HOME` with no SSH keys and no other agents' credentials.
- The file API root is separate from the agent's home.

**Residual:** prompt injection against a tool-using agent is a *known unsolved problem*, not a bug to be fixed. The durable mitigations are the agent's own permission model and the owner's judgement about what it points at. The app should not be sold as being immune to this.

---

## RR-05 · A single-user control plane is a high-value target with a known address

**Accepted risk** · **Owner:** the operator

The system grants remote shell access to a cloud host. The address is public. The value of a successful compromise is high (the box hosts the owner's other services: the Hermes gateway, the SwiftFetch admin panel, the Tailscale node). A determined attacker will look for it.

**Why it cannot be patched:** the app needs a reachable address, and the app's owner needs a shell on a machine that hosts other things.

**What remains after remediation**
- The shell is unprivileged and isolated.
- The file API no longer serves the home directory.
- The database role is no longer a superuser.
- The API binds to loopback and is reached only through the tunnel.
- The `friday-one-api.service` unit is hardened (`ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges`, `PrivateTmp`, `RestrictSUIDSGID`).

**Residual:** the host is still a single point of failure for the owner's other services. **The strongest recommendation in this audit is to move the FRIDAY One control plane onto a host that does not also serve anything else.** The isolation guarantees in the systemd unit apply to the service, not to the box.

---

## RR-06 · Certificate pinning is a maintenance liability

**Accepted risk** · **Owner:** the operator

Pinning a tunnel certificate means an expiry or a certificate rotation bricks the app until a new APK is built and installed. The upstream Cloudflare quick tunnel issues a *new certificate on every restart*, so pinning the quick tunnel's hostname is operationally infeasible — which is exactly why R-12 (a named tunnel with a stable certificate) must precede R-04 (pinning).

**Why it cannot be patched:** pinning is inherently brittle. The mitigation is the rotation procedure, which the codebase already documents.

**Residual**
- A missed rotation = an outage until the app is updated.
- The pin list must ship a backup pin.
- If the operator later reverts to a quick tunnel, pinning must be removed rather than silently bypassed — and the code's "pin only if the list is non-empty" rule means an empty list silently disables pinning with no error.

**Recommendation:** treat an empty pin list as a build failure, not a runtime no-op.

---

## RR-07 · The `ubuntu` account's `NOPASSWD: ALL` remains a standing risk

**Accepted risk** · **Owner:** the operator

`NoNewPrivileges` is the only thing preventing the terminal from reaching root. The underlying sudoers rule — `(ALL) NOPASSWD: ALL` for the account the server runs as — is unchanged. Any future deployment that runs the server outside the hardened unit, or any other process running as `ubuntu`, can escalate to root immediately.

**Why it cannot be patched:** `ubuntu` is the owner's primary account and is used for ordinary work. Removing passwordless sudo from it is a personal-workflow decision, not a code change.

**What remains after remediation**
- The `NoNewPrivileges` inheritance, verified empirically (D17).
- A startup assertion in the server that refuses to serve the terminal when `NoNewPrivs` is 0 and `TERMINAL_ENABLED=true`.
- The `docker` group membership removed (group membership is root-equivalent and survives `NoNewPrivileges`).

**Residual:** a process running as `ubuntu` outside the hardened unit can still escalate. **This is the strongest argument for R-10** — a dedicated service account with no sudo and no supplementary groups makes the question moot.

---

## RR-08 · The audit trail's IP column is not trustworthy

**Accepted risk** · **Owner:** the operator

Until R-07 lands, `audit_log.ip` records the client-supplied `X-Forwarded-For`. Historical rows are attacker-controlled and have no forensic value. The *event* records (who, what, when) remain valid; the *where* does not.

**Why it cannot be patched:** the historical data cannot be repaired, only discarded.

**Mitigation:** purge or annotate the historical rows; after R-07, the column becomes reliable for the first time.

**Residual:** for any incident before the fix, the log proves *that* an event occurred but not *from where*.

---

## RR-09 · No backups, no history, no rollback

**Accepted risk** · **Owner:** the operator

The project is not in version control (F-19), there is no CI (F-20), and there is no evidence of a Postgres backup strategy. The `docker-compose.yml` defines no volume backup. A bad migration, a mistaken `DROP`, or a disk failure on the provider is an **unrecoverable loss** of the session table, the device-binding table, and the audit log.

**Why it cannot be patched:** this is an operational decision, not a code defect. It is also the risk most likely to be *ignored* because nothing fails loudly while it is unaddressed.

**Mitigation (R-16 + additions)**
- `git init`, `.gitignore`, an initial commit, a `pre-audit` tag.
- An off-host git remote.
- A nightly `pg_dump` to an off-host location, with a restore that has been **tested at least once**.
- A snapshot of the Postgres volume before every migration.

**Residual:** a backup that has never been restored is a hypothesis, not a backup.

---

## RR-10 · The discovery mechanism remains a trust anchor unless R-12 is taken

**Accepted risk** · **Owner:** the operator

If R-12 (named tunnel) is not done, the app must find its server, and the current mechanism is an unsigned public document. R-12 removes the need for discovery; without it, the discovery document remains a single point of redirection.

**Why it cannot be patched:** a document fetched over HTTPS from a fixed URL is only as trustworthy as that URL's account.

**Mitigation if R-12 is deferred**
- Sign the discovery document and verify the signature in the client.
- Or pin the accepted hostnames to an allowlist in the APK, so the document can only select among pre-approved hosts.
- Or accept the risk explicitly, with the understanding that a GitHub compromise redirects the app.

**Residual:** the document is read from a gist whose ownership depends on a single GitHub account. That account should have hardware-key 2FA.

---

## RR-11 · Single-instance, single-build, no failover

**Accepted risk** · **Owner:** the operator

There is one server, one Postgres, one tunnel, one phone. There is no failover, no backup path, and no second factor for the device-binding flow. The `friday_audit` harness proved the app works with a single dedicated database role and no superuser, but it proved nothing about horizontal scale — and the app does not need scale.

**Why it cannot be patched:** a personal control plane does not need HA; it needs a backup and a restore procedure.

**Mitigation:** the backup measures in RR-09. A second tunnel endpoint for manual failover is cheap insurance if the owner wants it.

**Residual:** a provider outage means no access to the host. Remote-out-of-band recovery (a physical console, or a Tailscale-only fallback path) is the only realistic mitigation.

---

## RR-12 · The `trust` model is a boolean on a database row

**Accepted risk** · **Owner:** the operator

Device trust is a single `devices.trusted` boolean. It is set to `true` at registration and can only be flipped by an authenticated owner. There is no concept of "this device can do X but not Y", no per-device scoping, and no expiry. A trusted device is trusted for everything the owner can do.

**Why it cannot be patched:** it is a deliberately simple model for a single operator, and it is a reasonable one. The risk it carries — a stolen or shared phone with a trusted device record — is managed by the app lock, which is currently unwired (F-01).

**Residual:** until the biometric gate is wired, "the device is trusted" means only "the token came from a registration that was allowlisted". After R-04, it means "the phone was unlocked by its owner recently". That is a meaningful improvement, and it is the one that makes the rest of the model coherent.

---

## Summary: what the owner is accepting

| # | Residual risk | Acceptable today? | Becomes acceptable when |
|---|---|---|---|
| RR-01 | Single-factor perimeter | Yes, with a documented recovery | A second factor exists for the terminal |
| RR-02 | Public endpoint | Yes | The allowlist is closed by default (R-02) |
| RR-03 | General-purpose remote shell | **A product decision** | R-10 is done, or `kind=shell` is removed |
| RR-04 | Agents hold ambient authority | Partly | R-09 and R-11 remove the server's secrets from reach |
| RR-05 | High-value target on a shared host | **No** | The control plane moves to its own host |
| RR-06 | Pinning is brittle | Yes | R-12 precedes R-04 |
| RR-07 | Standing passwordless sudo | Yes, reluctantly | R-10, or a startup assertion on `NoNewPrivs` |
| RR-08 | Untrustworthy audit IPs | Yes | R-07 |
| RR-09 | No backups, no history | **No** | R-16 + a tested restore |
| RR-10 | Gist discovery as a trust anchor | Only with R-12 | R-12, or a signed document |
| RR-11 | Single instance, no failover | Yes | A tested restore exists |
| RR-12 | Trust is a single boolean | Yes | R-04 wires the biometric gate |

**Two entries should be treated as blockers rather than accepted risks: RR-05 (the control plane shares a host with other services) and RR-09 (no backups).** Neither is a code fix, and neither will show up as an incident until the day it matters.
