# FRIDAY One — Backend Work Completed (v2.0 plan)

**Last updated:** 2026-10-25 · **HEAD:** `5fee8c3` · **Live stack:** Vercel control plane + Supabase + gateway (systemd) + connector (paired) + Android v0.6.0

## Live deployment (all verified by execution)

| Component | Where | Status |
|---|---|---|
| Control plane (11 API routes) | `https://friday-one-control-plane-cotts1-2550.vercel.app` | live, P0-hardened |
| Database | Supabase project `tbysxnyuipjwutqxtxvy` (pooler: aws-0-ap-northeast-1), migrations 0001–0004 applied, all 12 tables RLS-on | live |
| Realtime gateway | systemd `friday-gateway` on the host, `127.0.0.1:8790`, exposed via quick tunnel | live, replay-guarded |
| Gateway tunnel | systemd `friday-gw-tunnel` (URL churns on restart until F-22/DNS) | live |
| Connector | running paired on the host (OpenCode agent; Hermes blocked on provider quota) | live |
| GitHub releases | `skytech45/friday-one` — v0.3.0/v0.4.0-app/v0.5.0/v0.6.0 (connector bundles + sha256 + install.sh + APKs) | public |
| CI | typecheck matrix (gateway/connector/control-plane) + connector bundle build + Android assembleRelease + gitleaks | green |

## What was built (chronological, all E2E-verified live)

1. **Phase 0–audit legacy stack** (now removed): security audit, 21/26 findings fixed, legacy Fastify server/Android screens/tunnels decommissioned in the v2 cutover.
2. **Supabase schema** — migrations `infra/supabase/migrations/`: 0001 all 11 entities + RLS on every table (12 adversarial RLS tests pass), 0002 pairing codes, 0003 enrollments state machine, 0004 shared rate-limit store.
3. **Control plane** (`control-plane/`): health, servers list, enrollment create/session/claim (hashed one-time 16–20 digit codes, 10-min expiry, 5-attempt budget, atomic transitions), server revoke, policy CRUD + `/policies/sync` (connector-credential-auth), jobs, audit. Auth: Supabase access tokens verified via JWKS (no shared secret server-side). Deploys via `deploy.py` (REST API).
4. **Realtime gateway** (`gateway/`): authenticated WSS hub — connectors by credential hash (revocation/expiry enforced), apps by Supabase token; per-message ownership re-checks; durable command_jobs (idempotent per server+key) BEFORE dispatch; permission.requested persisted then notified; chat.delta streaming; `ReplayGuard` (message_id LRU dedup + per-identity sequence baseline; stale → close 4400).
5. **Connector** (`connector/`): v2 pairing `enroll` — real scannable QR (`fridayone://pair?e=&c=`) + numeric code, polls, one-time credential pickup (0600 enforced); outbound WSS with heartbeat (15 s → `servers.last_seen_at`), backoff+full jitter; **remote policy fetch immediately before every execution** (fail closed); ACP adapter (drives hermes-acp 0.22.5 AND opencode 2.1.3 — verified initialize/session/prompt streaming on both, execution on OpenCode); single-file esbuild bundle (561 KB) + `install.sh` (pinned version, sha256-verified, unprivileged systemd, enroll/status/upgrade/rollback/revoke/uninstall).
6. **Android (v0.6.0, versionCode 6, signed)**: Supabase email+password login + register page (email-confirmation state handled), Google OAuth fully wired (PKCE + `fridayone://auth-callback` deep link — activates when owner enables the provider), server dashboard (online states), Add Server → install command + token + **QR scan (zxing) or numeric claim**, live agent chat with streaming deltas + inline permission allow/deny, Security screen (policy editor with toggles/delete + add dialog, job history, audit trail, server revoke with confirm).
7. **P0 security hardening (live-tested):** per-IP rate limiting on all pairing routes (shared Supabase fixed-window RPC; Vercel-edge-header IP only; spoofed x-forwarded-for can't bypass; fail-closed 503; env-tunable RL_*); gateway replay protection. Verified: 10×201→429+Retry-After, spoof-no-bypass, dup dropped, stale 4400, valid flow streams end-to-end.

## Key live-test evidence (commands in git history / audit doc)

- Pairing E2E incl. wrong-code 403, no-auth 401, replay 403, one-time pickup
- Policy engine: allow executes ("OK2" streamed), deny → `policy_deny`, no rule → `policy_require_approval`
- Revocation: credential dead immediately (reconnect refused, sync 403), re-pair works
- Malformed envelope → 4400; cross-user submits rejected; logs scanned clean of secrets
- Full audit with evidence: `docs/COMPLETION_AUDIT.md`

## Owner actions still pending

- Google OAuth: enable provider per `docs/GOOGLE_OAUTH_SETUP.md` (app side done)
- SMTP for confirmation emails (built-in sender: 2/hour) — or accept the limit
- Back up `~/.android-keys/` (release keystore) off-host
- Hermes model quota (its provider 429s; pipeline is agent-agnostic meanwhile)
