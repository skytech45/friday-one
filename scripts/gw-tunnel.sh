#!/usr/bin/env bash
# Second quick tunnel: exposes the realtime gateway (127.0.0.1:8790) so the
# Android app can reach the WSS. Same hostname-churn caveat as the API tunnel.
set -euo pipefail
GW_PORT="${FRIDAY_GW_PORT:-8790}"
LOG=/home/ubuntu/friday-one/logs/gw-tunnel.log
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${GW_PORT}/" >/dev/null 2>&1; then break; fi
  sleep 1
done
exec /usr/local/bin/cloudflared tunnel --url "http://127.0.0.1:${GW_PORT}" 2>"$LOG"
