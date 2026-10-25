# FRIDAY Connector

The connector runs on every enrolled server. It is the **local execution
gate**: it makes an OUTBOUND authenticated WSS connection to the realtime
gateway, discovers agents, enforces local policy, and executes only what the
policy gate allows (SYSTEM_DESIGN §2, §16.4).

**Status: Phase 1-4 prep (skeleton).** Implemented: config + credential
handling, pairing redemption, protocol envelope schemas, fail-closed policy
gate, outbound WSS client with heartbeat/backoff/resume. NOT yet implemented:
the gateway it talks to (Phase 4), agent adapters (Phase 5), the PTY bridge
migration, durable command state (the control plane's side).

## Layout

| File | Role |
|---|---|
| `src/config.ts` | env + credential file loading (0600 enforced) |
| `src/pairing.ts` | redeem single-use code → revocable credential |
| `src/protocol.ts` | envelope schemas mirroring `docs/REALTIME_PROTOCOL.md` |
| `src/policy.ts` | fail-closed local decision function (§4 precedence) |
| `src/gateway.ts` | outbound WSS, heartbeat, bounded reconnect, resume |
| `friday-connector.service` | systemd unit (unprivileged, hardened) |

## Install (once the control plane + gateway are live)

```bash
# 1. dedicated account (todo F-16 pattern)
sudo useradd -r -m -d /var/lib/friday-connector -s /usr/sbin/nologin friday-connector

# 2. build
cd ~/friday-one/connector && npm ci --ignore-scripts && npm run build

# 3. pairing: create the enrollment in the app, then on the server:
FRIDAY_CONTROL_PLANE_URL=https://<control-plane> \
FRIDAY_CREDENTIAL_FILE=/etc/friday-connector/credential \
FRIDAY_PAIRING_CODE=<single-use-code> node dist/index.js pair

# 4. install & start
sudo cp friday-connector.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now friday-connector
```

## Upgrade / rollback

- Upgrade: `git pull && npm ci && npm run build && sudo systemctl restart friday-connector`.
- Rollback: redeploy the previous git tag the same way; the credential and
  policy files live outside the repo and survive both directions.
- Revocation (lost server): revoke the credential in the app; the gateway
  sends `connector.revoked` and closes 4403; reconnects are refused.

## Security notes

- The credential file must be 0600; `readCredential` refuses to run otherwise.
- The connector NEVER receives backend secrets, Supabase keys, or SSH keys.
- No inbound listener exists; all connections are outbound TLS.
- Unknown inbound event types in high-risk classes are rejected (protocol.ts).
