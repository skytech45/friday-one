# FRIDAY One — Security Audit

**Date:** 2026-10-23 · **Scope:** `~/friday-one` (Android client, backend, infrastructure) · **Status:** proposed remediation — no production file was modified

## Read in this order

| # | Document | What it is |
|---|---|---|
| 1 | `security-audit-summary.md` | The one-page version. Verdict, severity distribution, the blockers, and what to do first. |
| 2 | `architecture-and-trust-boundaries.md` | How the system actually works, where the boundaries are, and where the documentation and the code disagree. |
| 3 | `findings.md` | All 26 findings, each with expected vs observed behaviour, a realistic scenario, the root cause, the fix and a regression test. |
| 4 | `findings.json` | The same findings in machine-readable form. |
| 5 | `threat-model.md` | Assets, actors, attack surfaces, trust boundaries, nine abuse cases, and what a single-operator design should do differently. |
| 6 | `remediation-roadmap.md` | P0–P3 fixes with code, files touched, regression tests, rollback paths and a dependency graph. |
| 7 | `security-test-matrix.md` | 89 test cases with expected vs actual results. |
| 8 | `residual-risk-register.md` | The 12 risks that remain after every fix lands — and the two that should be treated as blockers. |

## Headline

**Not production-ready.** Two P0 items, three P1 items, and one design decision that needs a human.

- **The server core is solid.** The path jail, refresh-token rotation, replay rejection, fingerprint binding, account lockout, the trust gate and the WebSocket auth all survived every adversarial test. `tsc` is clean and the 15 server tests pass.
- **The client is not.** All four Android security classes — biometric gate, certificate pinning, device identity, network module — are implemented and never called. The server's device-binding columns are never read or written.
- **The configuration is what breaks it.** `FS_ROOTS=/home/ubuntu` makes a correct jail serve the owner's SSH keys, agent credentials and the JWT secret. The registration allowlist fails open when unset. The WebSocket token is written to the log. The rate limiter is keyed on a header the client controls.

## The four blockers

| ID | Finding | One line |
|---|---|---|
| F-02 | `FS_ROOTS=/home/ubuntu` | One authenticated request downloads `~/.ssh/authorized_keys`, `~/.hermes/auth.json` and `server/.env`. |
| F-01 | Dead Android security layer | No biometric gate, no pinning, no device binding, no token refresh in the shipped app. |
| F-03 | Token in the log | Every terminal connection writes a live 15-minute bearer token to the journal. |
| F-04 | Fail-open registration | With `ALLOWED_EMAILS` unset, an anonymous party registers a fully trusted device. |

## Method and boundaries

- Read-only source review plus **empirical validation** against a dedicated non-production PostgreSQL role and throwaway filesystem roots.
- **The production database, the production `.env` and the production services were not used as inputs and were not modified.**
- No production secret was used as a test input; no production file was changed; no production port was bound.
- The harnesses in this directory are self-cleaning and were removed after the audit. They create their own role, database and port, then drop all three.
- Every secret, password, key and endpoint value in these reports is redacted.

## Caveats

- **No device was available.** The Android findings are source-level conclusions, not runtime observations. The instrumented tests in the roadmap would confirm them.
- **The service is not running** (`friday-one-api.service` is not installed; the tunnel returns HTTP 530), so nothing could be validated against the live deployment.
- **The load and concurrency limits were not tested**, by instruction. F-17 is source-evidence only.
- **Git history could not be scanned** — the project is not a repository (F-19).

## Reproducing the audit

The harnesses are here. Each creates its own isolated role and database and cleans up after itself:

```bash
cd ~/friday-one/audit
# The full end-to-end suite against the real server code
node audit-e2e.mjs
# The JWT acceptance matrix (all 15 variants must be rejected after R-05)
node audit-algtest.mjs
# The focused probes
node audit-probes.mjs
node audit-race.mjs          # concurrent refresh rotation
node audit-nnp.mjs           # NoNewPrivileges propagation to the terminal child
node audit-emptysecret.mjs   # empty JWT_SECRET behaviour
```

Each needs the Postgres container to be up and the audit role to be creatable. They never touch the `friday` database.
