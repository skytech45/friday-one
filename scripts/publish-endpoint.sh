#!/bin/bash
# Publish the current quick-tunnel URL to the public discovery gist.
#
# Why this exists: an account-less cloudflared quick tunnel gets a NEW random
# hostname on every restart, and the APK has the old one baked in. Rather than
# rebuilding the app on every restart, the app polls this gist and repoints
# itself. The gist holds ONLY the public base URL - never a token or a secret,
# so it is safe for it to be public.
#
# Run this after cloudflared restarts. infra/systemd/friday-endpoint-publisher.service
# calls it automatically.
set -euo pipefail

GIST_ID="462b9df17f30fd7029e4ead519103f20"
JSON=/home/ubuntu/friday-one/infra/endpoint.json
# Same file tunnel.sh writes (its stderr is redirected here). Must match the
# LOG path in scripts/tunnel.sh and stay inside the tunnel unit's
# ReadWritePaths.
LOG=/home/ubuntu/friday-one/logs/cf-tunnel.log

# cloudflared prints the assigned hostname once on startup.
URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1)
if [ -z "$URL" ]; then
  echo "publish-endpoint: no tunnel URL found in $LOG - is cloudflared running?" >&2
  exit 1
fi

PREV=$(python3 -c "import json;print(json.load(open('$JSON'))['base_url'])" 2>/dev/null || echo "")

cat > "$JSON" <<EOF
{
  "base_url": "$URL",
  "updated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "app": "friday-one"
}
EOF

if [ "$URL" = "$PREV" ]; then
  echo "publish-endpoint: unchanged ($URL)"
  exit 0
fi

# Positional form: gh updates the gist file whose name matches the local
# basename (endpoint.json). (-f is a RENAME flag, not a content flag — using
# it here made gh look for a gist file literally named after the path.)
gh gist edit "$GIST_ID" "$JSON" >/dev/null
echo "publish-endpoint: updated $PREV -> $URL"

# Verify the change is actually publicly visible rather than trusting gh's exit code.
RAW="https://gist.githubusercontent.com/skytech45/$GIST_ID/raw/endpoint.json"
for i in $(seq 1 10); do
  NOW=$(curl -s --max-time 10 "$RAW" | python3 -c "import json,sys;print(json.load(sys.stdin)['base_url'])" 2>/dev/null || echo "")
  [ "$NOW" = "$URL" ] && { echo "publish-endpoint: verified live at $RAW"; exit 0; }
  sleep 3
done
echo "publish-endpoint: WARNING - gist did not reflect $URL after 30s (CDN cache?)" >&2
exit 0
