#!/bin/bash
# Finish the Cloudflare named-tunnel setup for friday.knistudio.in.
#
# Run this ONLY after knistudio.in's nameservers have been changed to the two
# Cloudflare-assigned ones at GoDaddy and the zone shows "Active" in the
# Cloudflare dashboard. It is idempotent: safe to re-run.
#
# Steps 1-3 (Cloudflare account, add zone, change nameservers at GoDaddy) are
# manual and must be done by the account owner - they need a Cloudflare login
# and a GoDaddy login, which this script deliberately does not touch.
set -euo pipefail

DOMAIN="knistudio.in"
HOSTNAME_FQDN="friday.knistudio.in"
TUNNEL_NAME="friday-one"
API_ORIGIN="http://127.0.0.1:8788"
CFG="$HOME/.cloudflared/config.yml"

echo "=== 1. zone reachable? ==="
NS=$(dig +short NS "$DOMAIN" @1.1.1.1)
echo "nameservers: $NS"
if ! grep -qi cloudflare <<<"$NS"; then
  echo "STOP: $DOMAIN is not delegated to Cloudflare yet."
  echo "Change the nameservers at GoDaddy first, then re-run."
  exit 1
fi

echo
echo "=== 2. authenticate cloudflared ==="
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "A browser URL will be printed. Open it, pick $DOMAIN, and authorise."
  cloudflared tunnel login
else
  echo "already authenticated"
fi

echo
echo "=== 3. create the tunnel (idempotent) ==="
if cloudflared tunnel list 2>/dev/null | grep -qw "$TUNNEL_NAME"; then
  echo "tunnel '$TUNNEL_NAME' already exists"
else
  cloudflared tunnel create "$TUNNEL_NAME"
fi

TUNNEL_ID=$(cloudflared tunnel list -o json 2>/dev/null \
  | python3 -c "import json,sys;print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$TUNNEL_NAME'))")
echo "tunnel id: $TUNNEL_ID"

echo
echo "=== 4. write config.yml ==="
mkdir -p "$HOME/.cloudflared"
cat > "$CFG" <<YAML
# Route the public hostname to the local API. The API stays bound to
# 127.0.0.1: nothing is exposed on a public port.
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $HOSTNAME_FQDN
    service: $API_ORIGIN
  - service: http_status:404
YAML
echo "wrote $CFG"

echo
echo "=== 5. route DNS ==="
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_FQDN" || \
  echo "(DNS route may already exist - continuing)"

echo
echo "=== 6. install systemd unit ==="
# Deliberately NOT reusing infra/systemd/friday-one-tunnel.service: that unit
# runs `tunnel.sh`, i.e. an account-less quick tunnel. A named tunnel must run
# `cloudflared tunnel run` against config.yml, so the two are not
# interchangeable and copying the quick-tunnel unit here would silently keep
# the old random-URL behaviour.
sudo tee /etc/systemd/system/friday-one-tunnel.service >/dev/null <<UNIT
[Unit]
Description=FRIDAY One Cloudflare named tunnel (friday.knistudio.in)
After=friday-one-api.service network-online.target
Requires=friday-one-api.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
ExecStart=/usr/local/bin/cloudflared tunnel --config $CFG run $TUNNEL_NAME
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now friday-one-tunnel.service

echo
echo "=== 7. verify through the public hostname ==="
sleep 8
for i in $(seq 1 12); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$HOSTNAME_FQDN/health" || true)
  echo "  attempt $i -> $CODE"
  [ "$CODE" = "200" ] && break
  sleep 8
done

echo
if [ "${CODE:-}" = "200" ]; then
  echo "OK: https://$HOSTNAME_FQDN is live."
  echo
  echo "Rebuild the APK against the permanent URL:"
  echo "  cd /home/ubuntu/friday-one/android && \\"
  echo "    FRIDAY_BASE_URL=https://$HOSTNAME_FQDN flock /tmp/gradle.lock ./build.sh debug"
else
  echo "Tunnel configured but /health did not return 200 yet."
  echo "Check: systemctl status friday-one-tunnel; journalctl -u friday-one-tunnel -n 50"
fi
