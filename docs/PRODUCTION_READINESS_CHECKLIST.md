# FRIDAY One — Production Readiness Checklist

**Verdict (2026-10-28): NOT production-ready.** Evidence:
[FULL_SYSTEM_AUDIT.md](FULL_SYSTEM_AUDIT.md),
[END_TO_END_TEST_REPORT.md](END_TO_END_TEST_REPORT.md). The Firebase-stack
version of this checklist lives on branch `firebase/migration-phase-0`;
merge both when that branch lands.

## Connector, CLI and installer

| # | Gate | Status |
|---|---|---|
| C-1 | Release bundle starts (A-1) | IMPLEMENTED_NOT_VERIFIED: fixed + smoke-run locally; **published `v0.9.0` FAILED** |
| C-2 | Reconnects after any disconnect (A-2) | VERIFIED (unit); live pending |
| C-3 | `fridayone --help/--version/setup/status/doctor/logs/reconnect/update/uninstall` | VERIFIED with stubs (harness 29/29); real systemd pending CI |
| C-4 | Runs unprivileged, no inbound port, survives restart, no restart loop on revocation | IMPLEMENTED_NOT_VERIFIED (`installer-e2e.sh`, runs on CI) |
| C-5 | Download integrity, fail closed | IMPLEMENTED_NOT_VERIFIED (tamper test on CI); signatures MISSING |
| C-6 | Upgrade preserves config; uninstall safe | IMPLEMENTED_NOT_VERIFIED (CI) |
| C-7 | No secrets in logs, argv, URLs or shell history | VERIFIED (harness) for the token; journal check on CI |
| C-8 | Real release published with these fixes | BLOCKED: needs authorization to push, merge and release |

## Backend and gateway (legacy stack, live)

| # | Gate | Status |
|---|---|---|
| B-1 | F-M9 jobs ownership + F-M14 approval ownership fixes **deployed** | BLOCKED: merged to `master`, owner deploys |
| B-2 | POST enrollment poll deployed (A-8) | IMPLEMENTED_NOT_VERIFIED (control-plane tests 6/6), not deployed |
| B-3 | Stable gateway URL (no quick tunnel) | MISSING on the legacy stack (Cloud Run on the Firebase branch) |

## End-to-end

| # | Gate | Status |
|---|---|---|
| E-1 | App + backend + gateway + connector + agent together on a disposable VPS | BLOCKED: VPS, device, deployed backend |
| E-2 | OpenCode prompt streams to the app | BLOCKED (E-1) |
| E-3 | Hermes | BLOCKED: model provider quota |
| E-4 | Revocation end to end | BLOCKED (E-1); components verified separately |

## Operations

| # | Gate | Status |
|---|---|---|
| O-1 | Release signing key backed up off-host | BLOCKED: owner (`C:\Users\sachi\.android-keys\`) |
| O-2 | License decided | MISSING: no LICENSE file |
| O-3 | Monitoring and alerts | MISSING |
