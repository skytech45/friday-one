#!/usr/bin/env bash
# FRIDAY Connector installer (plan v2.0 §3).
# Pinned, checksum-verified install. sudo is required ONLY to create the
# service user and systemd unit — the connector itself never runs as root.
#
# Usage:
#   install.sh enroll            # interactive enrollment (prints QR/code)
#   install.sh status|upgrade|rollback|revoke|uninstall
set -euo pipefail

REPO="skytech45/friday-one"
VERSION="${FRIDAY_CONNECTOR_VERSION:-v0.3.0}"   # PINNED — never "latest" unverified
INSTALL_DIR="/opt/friday-connector"
SERVICE_USER="friday-connector"
BIN="$INSTALL_DIR/friday-connector.js"
ENVF="$INSTALL_DIR/connector.env"

need_root() { [ "$(id -u)" -eq 0 ] || { echo "run with sudo (creates the service user + unit only)" >&2; exit 1; }; }

download_and_verify() {
  need_root
  local arch; arch="$(uname -m)"; case "$arch" in x86_64) arch="x64";; aarch64|arm64) arch="arm64";; *) echo "unsupported arch: $arch" >&2; exit 1;; esac
  local name="friday-connector-${VERSION}-linux-${arch}.js"
  local url="https://github.com/$REPO/releases/download/$VERSION/$name"
  echo "downloading $url"
  curl -fsSL -o "/tmp/$name" "$url"
  curl -fsSL -o "/tmp/$name.sha256" "$url.sha256"
  ( cd /tmp && sha256sum -c "$name.sha256" ) || { echo "CHECKSUM MISMATCH — aborting (tampered or wrong version)" >&2; exit 1; }
  install -m 0755 "/tmp/$name" "$BIN"
  rm -f "/tmp/$name" "/tmp/$name.sha256"
}

create_service() {
  need_root
  id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -M -d /var/lib/friday-connector -s /usr/sbin/nologin "$SERVICE_USER"
  mkdir -p /etc/friday-connector "$INSTALL_DIR"
  chmod 0750 /etc/friday-connector "$INSTALL_DIR"
  cat > "$ENVF" <<'EOF'
# FRIDAY Connector environment — fill GATEWAY/CONTROL_PLANE before starting.
FRIDAY_CONTROL_PLANE_URL=https://friday-one-control-plane-cotts1-2550.vercel.app
FRIDAY_GATEWAY_URL=wss://rugs-ada-legislature-literacy.trycloudflare.com
FRIDAY_CREDENTIAL_FILE=/etc/friday-connector/credential
FRIDAY_POLICY_DIR=/etc/friday-connector/policies
EOF
  mkdir -p /etc/friday-connector/policies
  cat > /etc/friday-connector/policies/policies.json <<'EOF'
{"version": 1, "rules": []}
EOF
  chown -R "$SERVICE_USER:$SERVICE_USER" /etc/friday-connector
  cat > /etc/systemd/system/friday-connector.service <<EOF
[Unit]
Description=FRIDAY Connector (outbound WSS execution gate)
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
EnvironmentFile=$ENVF
ExecStart=$(command -v node) $BIN run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/etc/friday-connector
ProtectHome=read-only
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF
  cat > /usr/local/bin/fridayone <<'EOF'
#!/usr/bin/env bash
# FRIDAY One server terminal pairing & management tool
set -euo pipefail
if [ -f /etc/friday-connector/credential ] && [ "${1:-}" != "enroll" ] && [ "${1:-}" != "pair" ]; then
  systemctl status friday-connector --no-pager
  echo ""
  echo "FRIDAY Connector is installed and active."
  echo "To re-pair with a new enrollment token, run: fridayone pair"
  exit 0
fi

sudo /opt/friday-connector/install.sh enroll "${1:-}"
EOF
  chmod 0755 /usr/local/bin/fridayone
  systemctl daemon-reload
}

case "${1:-install}" in
  install)
    need_root
    if [ ! -f "$BIN" ]; then download_and_verify; create_service; fi
    echo "=========================================================="
    echo "  FRIDAY Connector framework installed successfully."
    echo "  Type 'fridayone' on this terminal to start pairing!"
    echo "=========================================================="
    ;;
  pair|enroll)
    need_root
    if [ ! -f "$BIN" ]; then download_and_verify; create_service; fi
    TOKEN="${2:-}"
    if [ -z "$TOKEN" ]; then
      echo "=========================================================="
      echo "  FRIDAY One Server Pairing"
      echo "=========================================================="
      echo "Enter the one-time enrollment token from your FRIDAY One app:"
      read -r TOKEN
    fi
    # Enrollment runs as the service user; the credential lands 0600.
    sudo -u "$SERVICE_USER" env FRIDAY_CONTROL_PLANE_URL="$(grep FRIDAY_CONTROL_PLANE_URL "$ENVF" | cut -d= -f2)" \
      FRIDAY_CREDENTIAL_FILE=/etc/friday-connector/credential \
      node "$BIN" enroll "$TOKEN"
    systemctl enable --now friday-connector
    echo "=========================================================="
    echo "  Connector paired & service running in background ✓"
    echo "=========================================================="
    ;;
  status)    systemctl status friday-connector --no-pager ;;
  upgrade)   need_root; download_and_verify; systemctl restart friday-connector; echo "upgraded to $VERSION" ;;
  rollback)  need_root; VERSION="${2:?version to roll back to}" download_and_verify; systemctl restart friday-connector ;;
  revoke)
    need_root
    rm -f /etc/friday-connector/credential
    systemctl restart friday-connector || true
    echo "local credential removed; also revoke the server in the app."
    ;;
  uninstall)
    need_root
    systemctl disable --now friday-connector || true
    rm -f /etc/systemd/system/friday-connector.service "$BIN" "$ENVF" /usr/local/bin/fridayone
    rm -rf /etc/friday-connector
    systemctl daemon-reload
    echo "connector removed (service user kept; delete with: userdel -r $SERVICE_USER)"
    ;;
  *) echo "usage: install.sh [install|pair|status|upgrade|rollback <ver>|revoke|uninstall]" ;;
esac
