# FRIDAY One — Security Audit

**Audit date:** 2026-10-23
**Remediation:** 2026-10-24 (in progress)
**Scope:** `~/friday-one` — Android client (Kotlin/Compose), backend (Node/TypeScript/Fastify/PostgreSQL), infrastructure (Ubuntu, systemd, Cloudflare Tunnel)
**Auditor:** Friday (Hermes Agent)
**Status:** remediation in progress — 10 of 26 findings closed, 1 partial, 15 open

This is the entry point. The full report set lives in [`audit/`](audit/).

---

## Verdict

**At audit time: not production-ready.** The backend core is in far better shape
than the client. The path jail, refresh-token rotation, replay rejection,
fingerprint binding, account lockout, device-trust gate and WebSocket
authentication all behaved correctly under adversarial testing. What failed was
the **configuration around a correct core**, and the **entire Android security
layer**, which is implemented but never called.

The four original blockers are now closed. What remains is concentrated in the
client, the deployment, and operational hygiene.

---

## How the audit was performed

Read-only source review, then empirical validation: a harness boots the **real
server code** against a dedicated non-production PostgreSQL role, throwaway
filesystem roots and a dedicated port, and asserts outcomes over the real HTTP
and WebSocket transports.

- No production secret was used as a test input; every value in this report is `[REDACTED]`.
- The production database, `.env` and services were never used as inputs.
- All isolated databases, roles, processes and fixtures were removed afterwards.

**Confidence is stated per finding:** `confirmed` = reproduced by execution;
`likely` = strong source evidence, not executed. Nothing is presented as the
first when it is the second.

---

## Severity distribution (at audit time)

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 3 |
| Medium | 10 |
| Low | 7 |
| Informational | 4 |
| **Total** | **26** |

Test matrix: **89 cases** — 51 PASS, 29 FAIL, 8 GAP, 1 not run. A GAP means no
test existed for that behaviour; a FAIL means the check exposed a defect.

---

## Findings and current status

| ID | Finding | Sev | Status |
|---|---|---|---|
| F-01 | Android client's entire security layer is dead code | Critical | open |
| F-02 | `FS_ROOTS=/home/ubuntu` exposes the whole home dir over HTTP | Critical | **fixed** |
| F-03 | WebSocket access token written to the server log | High | **fixed** |
| F-04 | Registration fails open when `ALLOWED_EMAILS` is unset | High | **fixed** |
| F-05 | `X-Forwarded-For` spoofing resets rate-limit buckets | High | **fixed** |
| F-06 | JWT verification accepts any HMAC algorithm | Medium | **fixed** |
| F-07 | A revoked device keeps a working access token | Medium | **fixed** |
| F-08 | A JWT without an `exp` claim is accepted | Medium | **fixed** |
| F-09 | The database role is a PostgreSQL superuser | Medium | open |
| F-10 | The terminal child inherits the server's secrets | Medium | **fixed** |
| F-11 | Two critical advisories in the JWT chain | Medium | partial |
| F-12 | Unauthenticated crash-report injection into the owner's console | Medium | open |
| F-13 | An untrusted device receives full host telemetry | Medium | open |
| F-14 | The release build is signed with the debug key | Medium | open |
| F-15 | The Android client has no tests | Medium | open |
| F-16 | `NoNewPrivileges` blocks sudo — effective but load-bearing | Low | open |
| F-17 | No resource limits on terminal sessions | Low | open |
| F-18 | `ws` used but not declared as a dependency | Low | **fixed** |
| F-19 | The project is not in version control | Low | **fixed** |
| F-20 | There is no CI | Low | open |
| F-21 | `xterm.js` vendored without provenance | Low | open |
| F-22 | Dead tunnel endpoint; unauthenticated discovery document | Low | open |
| F-23 | Unlinked crash reports retained indefinitely | Info | open |
| F-24 | Device labels are client-controlled | Info | open |
| F-25 | Empty `CORS_ORIGINS` on a publicly reachable API | Info | open |
| F-26 | Owner email in plaintext in the audit log | Info | open |

Full detail — expected vs observed, realistic scenario, root cause, fix and
regression test — is in [`audit/findings.md`](audit/findings.md). Machine-readable
status is in [`audit/findings.json`](audit/findings.json).

---

## The four findings that mattered most

**F-02 — the path jail was correct; its root was wrong.**
`safePath()` properly collapses `..` and symlinks before the containment check.
But `FS_ROOTS` was `/home/ubuntu`, so the jail correctly permitted every file
under the owner's home. Verified: one authenticated request returned
`~/.ssh/authorized_keys`, `~/.hermes/auth.json` and `server/.env` — which
contains `JWT_SECRET`, and `JWT_SECRET` is equivalent to full system control.
*Fixed:* root narrowed to `storage/`, plus a credential denylist inside roots.

**F-01 — the client's security is a set of classes nobody calls.**
`AppLock` (biometric gate), `CertificatePinning`, `DeviceIdentity` (Android
Keystore), `DeviceIntegrityGate` and `NetworkModule` are all implemented and
have **zero call sites**. The server's device-binding columns
(`public_key`, `key_bound_at`, `key_security_level`, `integrity_verdict`) are
never read or written. Net effect: no biometric prompt, no pinning, no device
binding, no token refresh. A stolen phone opens straight into the control plane.
*Open.*

**F-04 — registration failed open.**
With `ALLOWED_EMAILS` empty the allowlist check was skipped entirely, and a
newly registered device is `trusted=true`. Verified end-to-end: anonymous
registration → trusted device → `/fs/download` of the owner's home →
`JWT_SECRET` → `/ws/terminal` → shell. *Fixed:* fails closed with 503.

**F-10 — the terminal handed its own keys to the shell.**
The PTY was spawned with `env: { ...process.env }`, so a live shell held
`JWT_SECRET`, `DATABASE_URL` and `FINGERPRINT_PEPPER`. Any prompt injection into
Hermes or OpenCode could read all three with one `env` command. *Fixed:* secrets
are scrubbed from `process.env` at startup and the child gets an explicit
allowlist. Measured from inside a real terminal: 15 variables, none of the three
secrets present.

---

## Report set

| Document | Contents |
|---|---|
| [`audit/README.md`](audit/README.md) | Reading order and how to reproduce |
| [`audit/security-audit-summary.md`](audit/security-audit-summary.md) | One-page verdict and blockers |
| [`audit/architecture-and-trust-boundaries.md`](audit/architecture-and-trust-boundaries.md) | How the system actually works; where docs disagree with code |
| [`audit/findings.md`](audit/findings.md) | All 26 findings in full |
| [`audit/findings.json`](audit/findings.json) | Machine-readable; source of truth for status |
| [`audit/threat-model.md`](audit/threat-model.md) | Assets, actors, surfaces, 9 abuse cases |
| [`audit/remediation-roadmap.md`](audit/remediation-roadmap.md) | Prioritised fixes, tests, rollback, dependencies |
| [`audit/security-test-matrix.md`](audit/security-test-matrix.md) | 89 cases, expected vs actual |
| [`audit/residual-risk-register.md`](audit/residual-risk-register.md) | 12 risks no patch removes |

Companion documents at the project root:

- [`task-complete.md`](task-complete.md) — what has been done, with evidence
- [`todo.md`](todo.md) — what remains, prioritised

---

## Residual risks worth knowing

Two are flagged as blockers rather than accepted risks, and neither is a code
fix — see [`audit/residual-risk-register.md`](audit/residual-risk-register.md):

- **RR-05** — the control plane shares a host with the Hermes gateway and the
  SwiftFetch admin panel. A compromise of one is a compromise of all.
- **RR-09** — no version control history existed before this audit, no CI, and
  no demonstrated backup/restore for PostgreSQL. A bad migration or a disk
  failure is currently unrecoverable.

The most important honest limitation: **the remote shell is a general-purpose
`bash -l` on the host.** That is the product, not a bug, but it means a
compromised session is a shell on a box that also serves other things.
