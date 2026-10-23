#!/usr/bin/env bash
# Start a Cloudflare quick tunnel to expose the local API.
# No account or login required — cloudflared generates a random *.trycloudflare.com
# hostname each time. This is fine for development; see docs/DEPLOY.md for production.
set -euo pipefail

API_PORT="${FRIDAY_API_PORT:-8787}"

# Wait for the API to accept connections before opening the tunnel.
# Prevents cloudflared from erroring out during server startup.
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

exec /usr/local/bin/cloudflared tunnel --url "http://127.0.0.1:${API_PORT}"

</content>