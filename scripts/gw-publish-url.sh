#!/usr/bin/env bash
# Publish the CURRENT gateway tunnel URL into Supabase app_config (key:
# gateway_url). Runs after the gateway tunnel is up; clients discover the
# gateway dynamically via GET /api/v1/config — no APK rebuild on tunnel churn.
#
# Requires the service key at ~/.config/friday-cloud/vercel.json (0600).
set -euo pipefail

LOG=/home/ubuntu/friday-one/logs/gw-tunnel.log
CFG=/home/ubuntu/.config/friday-cloud/vercel.json

URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1)
if [ -z "$URL" ]; then
  echo "gw-publish: no tunnel URL found in $LOG" >&2
  exit 1
fi

export $(python3 - "$CFG" "$URL" <<PYEOF
import json, pathlib, sys
cfg = json.loads(pathlib.Path(sys.argv[1]).read_text())
url = sys.argv[2]
prev = cfg.get("published_gateway_url")
if prev == url:
    print("GW_URL_UNCHANGED=1")
else:
    print("GW_URL_CHANGED=1")
    print("SB_URL=" + cfg["supabase_url"])
    print("SB_KEY=" + cfg["supabase_secret_key"])
    cfg["published_gateway_url"] = url
    pathlib.Path(sys.argv[1]).write_text(json.dumps(cfg, indent=2))
PYEOF
)

if [ "${GW_URL_UNCHANGED:-0}" = "1" ]; then
  echo "gw-publish: unchanged ($URL)"
  exit 0
fi

curl -s -X POST "$SB_URL/rest/v1/app_config" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
  -H "content-type: application/json" \
  -H "Prefer: resolution=merge-duplicates" \
  -d "{\"key\":\"gateway_url\",\"value\":\"$URL\",\"updated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
  -o /dev/null -w "gw-publish: %{http_code} $URL\n"
