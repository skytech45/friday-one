# FRIDAY One — End-to-End Test Report

**Date:** 2026-10-28 · **Branch:** `feat/fridayone-cli` · Machine: Windows 11,
Node 22.23.2, Git Bash (no systemd, no WSL, no Docker). Results below were
actually executed; anything not run says so.

## 1. Results run on this branch

| Suite | Command | Result |
|---|---|---|
| Connector unit + lifecycle | `cd connector && npm test` | **10/12**; the 2 failures are the long-standing Windows-only PATH tests (pass on Linux CI) |
| — lifecycle tests (new) | `npx tsx --test src/lifecycle.test.ts` | **4/4**: state file atomic + redacted; 4403 fatal vs reconnect after a normal close (**failed before fix A-2**); POST poll |
| Control plane | `cd control-plane && npm test` | **6/6** (F-M9 jobs ownership 4, POST poll 2) |
| `fridayone` CLI harness | `cd connector && bash test/cli/cli-harness.sh` | **29/29** (stubbed systemd/runuser; fake backend). Mutation check: allowing query strings in URLs → 1 failure |
| Connector bundle smoke | `bash build-release.sh v9.9.9-test` + run | `version` → tag; `agents` lists adapters; unpaired `run` exits 78 with state `unpaired` |
| Published bundles | ran `v0.6.0` and `v0.9.0` release assets | **FAILED**: both crash with `Dynamic require of "fs"` (A-1) |

## 2. Linux CI (GitHub Actions, ubuntu-24.04, real systemd)

Run [40636455675](https://github.com/skytech45/friday-one/actions/runs/40636455675) at `dd99059` — **all jobs green**:

| Suite | Result |
|---|---|
| `connector/test/e2e/installer-e2e.sh` (Tests F + C + E on real systemd, as root on the runner) | **32/32**: verified install; real pairing via `fridayone setup`; gateway authentication; token never in a URL; credential 0600 / config 0640; runs as `friday-connector`; no inbound port; status/doctor; reused token rejected; reconnect after a gateway drop; restart recovery; enabled at boot; revocation stops the service (exit 78) with **no restart loop** and no reconnect hammering; idempotent re-install; upgrade keeps config; tampered download fails closed and leaves the installed binary untouched; no token/credential in the journal; `uninstall --purge` |
| Connector unit + lifecycle (Linux) | **12/12** |
| CLI harness (Linux) | **29/29** |
| ShellCheck (install.sh, fridayone, test scripts) | clean (first run flagged one `ls | grep` in the harness; fixed in `dd99059`) |

## 3. Results from the Firebase migration branch (emulator, 2026-10-27; CI green)

Rules 34/34 (Test G), functions API 21/21 (Tests A, B and E on the API
side), gateway 15/15 (Tests C and E on the gateway side, replay and
duplicates), migration tooling 22, Android 25 (Firebase sign-in states,
reconnect). CI run [40505895763](https://github.com/skytech45/friday-one/actions/runs/40505895763).

## 4. Brief's test matrix

| Test | Status | Evidence / blocker |
|---|---|---|
| A Authentication | PARTIAL | API + gateway token checks VERIFIED on emulator; device sign-in BLOCKED (Firebase console steps) |
| B Pairing | PARTIAL | API state machine VERIFIED (emulator); VPS side via `fridayone setup`: harness VERIFIED (stubbed), real systemd pending CI; app scan/claim on a device not run |
| C Gateway | PARTIAL | reconnect after a gateway drop and service restart VERIFIED (CI, fake gateway); live gateway not tested |
| D Agent operation | BLOCKED | no VPS with OpenCode/Hermes here; policy gate verified (`dispatch.test.ts`, migration CI) |
| E Revocation | PARTIAL | API A-4, gateway G-3 VERIFIED (emulator); connector + systemd behaviour VERIFIED (CI); live end to end not run |
| F Installer | VERIFIED (CI, real systemd) | installer-e2e.sh 32/32; reboot = service restart path (a real reboot was not performed) |
| G Firebase authorization | VERIFIED (emulator) | rules 34/34, API ownership tests |

**The Android app, backend, gateway, connector and an agent have not been
tested together.** That is acceptance test E-1 (docs/TESTING.md on the
migration branch) and needs a deployed backend, a VPS and a device.
