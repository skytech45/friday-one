#!/usr/bin/env bash
# FRIDAY Connector installer.
#
# Installs a pinned, checksum-verified connector release and the `fridayone`
# CLI, creates the unprivileged service account and a hardened systemd unit.
# It does NOT pair: run `sudo fridayone setup` afterwards.
#
#   sudo bash install.sh            install (or repair) this pinned version
#   sudo bash install.sh upgrade    replace binaries, keep config, restart if running
#   sudo bash install.sh uninstall  hand over to `fridayone uninstall`
#
# Review before running: curl -fsSL <release>/install.sh -o install.sh && less install.sh
# Docs: https://github.com/skytech45/friday-one/blob/master/docs/CONNECTOR_INSTALLATION.md
set -euo pipefail

REPO="skytech45/friday-one"
VERSION="${FRIDAY_CONNECTOR_VERSION:-v0.3.0}"   # PINNED by the release workflow — never "latest" unverified
DEFAULT_CONTROL_PLANE_URL="https://friday-one-control-plane-cotts1-2550.vercel.app"
# Test hook only: a local mirror of the release assets. Real installs use GitHub releases.
BASE_URL="${FRIDAY_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download}/$VERSION"

INSTALL_DIR="/opt/friday-connector"
BUNDLE="$INSTALL_DIR/friday-connector.js"
CONF_DIR="/etc/friday-connector"
ENV_FILE="$CONF_DIR/connector.env"
UNIT_FILE="/etc/systemd/system/friday-connector.service"
CLI_PATH="/usr/local/bin/fridayone"
SERVICE="friday-connector"
SERVICE_USER="friday-connector"
STATE_HOME="/var/lib/friday-connector"
MIN_NODE_MAJOR=20

say()  { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit "${2:-1}"; }

WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT
trap 'fail "interrupted; nothing half-installed was left in place" 130' INT TERM

preflight() {
  [ "$(id -u)" -eq 0 ] || fail "run as root: sudo bash install.sh"
  [ "$(uname -s)" = Linux ] || fail "only Linux is supported"
  command -v systemctl >/dev/null && [ -d /run/systemd/system ] || fail "systemd is required"
  case "$(uname -m)" in
    x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;;
    *) fail "unsupported architecture: $(uname -m) (supported: x86_64, aarch64)";;
  esac
  local id="" ver=""
  if [ -r /etc/os-release ]; then id="$(. /etc/os-release; echo "${ID:-}")"; ver="$(. /etc/os-release; echo "${VERSION_ID:-}")"; fi
  case "$id:$ver" in
    ubuntu:22.04|ubuntu:24.04|debian:12) ;;
    *) [ "${FRIDAY_ALLOW_UNTESTED_OS:-}" = 1 ] || fail "untested OS '$id $ver' (tested: Ubuntu 22.04/24.04, Debian 12); set FRIDAY_ALLOW_UNTESTED_OS=1 to try anyway";;
  esac
  for tool in curl sha256sum useradd install mktemp; do command -v "$tool" >/dev/null || fail "missing required tool: $tool"; done
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || fail "Node.js >= $MIN_NODE_MAJOR is required and was not found. Install it from https://nodejs.org (or your distribution), then re-run. This installer does not add package repositories."
  local major; major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge "$MIN_NODE_MAJOR" ] || fail "Node.js >= $MIN_NODE_MAJOR required (found $("$NODE_BIN" -v))"
  [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid version pin: $VERSION"
}

fetch_verified() { # $1 asset name → $WORK/$1, checksum-verified (fail closed)
  local name="$1"
  curl -fsSL --proto '=https,http' --max-time 120 -o "$WORK/$name" "$BASE_URL/$name" || fail "download failed: $BASE_URL/$name"
  curl -fsSL --proto '=https,http' --max-time 60 -o "$WORK/$name.sha256" "$BASE_URL/$name.sha256" || fail "download failed: $BASE_URL/$name.sha256"
  (cd "$WORK" && sha256sum -c --status "$name.sha256") || fail "CHECKSUM MISMATCH for $name — aborting (tampered download or wrong version)"
}

download() {
  WORK="$(mktemp -d)"
  say "downloading connector $VERSION ($ARCH) and fridayone CLI"
  fetch_verified "friday-connector-$VERSION-linux-$ARCH.js"
  fetch_verified "fridayone"
  "$NODE_BIN" "$WORK/friday-connector-$VERSION-linux-$ARCH.js" version >/dev/null 2>&1 \
    || fail "the downloaded connector does not start on this system (Node.js $("$NODE_BIN" -v))"
  say "checksums verified"
}

ensure_user() {
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir "$STATE_HOME" --shell /usr/sbin/nologin "$SERVICE_USER"
    say "created service account $SERVICE_USER (no login, no sudo)"
  fi
}

install_files() {
  install -d -m 0755 "$INSTALL_DIR"
  # Replace atomically: never leave a half-written binary in place.
  install -m 0755 "$WORK/friday-connector-$VERSION-linux-$ARCH.js" "$BUNDLE.new"
  mv -f "$BUNDLE.new" "$BUNDLE"
  (cd "$INSTALL_DIR" && sha256sum friday-connector.js > friday-connector.js.sha256)
  echo "$VERSION" > "$INSTALL_DIR/VERSION"
  install -m 0755 "$WORK/fridayone" "$CLI_PATH.new"
  mv -f "$CLI_PATH.new" "$CLI_PATH"

  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$CONF_DIR" "$CONF_DIR/policies"
  if [ ! -f "$ENV_FILE" ]; then
    # Defaults only; `fridayone setup` asks and validates. Never overwritten here.
    umask 027
    cat > "$ENV_FILE" <<EOF
# FRIDAY Connector configuration. Edit with: sudo fridayone setup
FRIDAY_CONTROL_PLANE_URL=$DEFAULT_CONTROL_PLANE_URL
FRIDAY_GATEWAY_URL=
FRIDAY_CREDENTIAL_FILE=$CONF_DIR/credential
FRIDAY_POLICY_DIR=$CONF_DIR/policies
FRIDAY_ALLOWED_ROOTS=
EOF
    chown "root:$SERVICE_USER" "$ENV_FILE"; chmod 0640 "$ENV_FILE"
  fi
}

write_unit() {
  cat > "$UNIT_FILE.new" <<EOF
# Installed by FRIDAY One install.sh $VERSION. Local changes belong in
# $UNIT_FILE.d/ (fridayone setup writes project roots there).
[Unit]
Description=FRIDAY One connector (outbound-only gateway client)
Documentation=https://github.com/$REPO/blob/master/docs/CONNECTOR_INSTALLATION.md
After=network-online.target
Wants=network-online.target
# A connector that keeps failing stops after 5 tries in 10 min instead of looping.
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
Environment=HOME=$STATE_HOME
Environment=FRIDAY_STATE_FILE=/run/friday-connector/state.json
ExecStart=$NODE_BIN $BUNDLE run
Restart=on-failure
RestartSec=10
# 78 = not paired / revoked: restarting cannot help.
RestartPreventExitStatus=78
TimeoutStopSec=20
KillMode=mixed
RuntimeDirectory=friday-connector
RuntimeDirectoryMode=0755
# Keep the last state (e.g. "revoked") readable for fridayone status after a stop.
RuntimeDirectoryPreserve=yes
StateDirectory=friday-connector
StateDirectoryMode=0700
UMask=0077

# Hardening: no inbound listener exists; the service needs no privileges.
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$CONF_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
SystemCallArchitectures=native
MemoryMax=1G
TasksMax=256

[Install]
WantedBy=multi-user.target
EOF
  mv -f "$UNIT_FILE.new" "$UNIT_FILE"
  systemctl daemon-reload
}

do_install() {
  preflight; download; ensure_user; install_files; write_unit
  if [ -f "$CONF_DIR/credential" ]; then
    systemctl restart "$SERVICE"
    say "connector $VERSION installed; existing pairing kept and service restarted"
    say "check it: fridayone status"
  else
    say "connector $VERSION installed (not started: not paired yet)"
    say "next: sudo fridayone setup"
  fi
}

do_upgrade() {
  preflight; download; ensure_user
  local was_active; was_active="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
  install_files; write_unit
  if [ "$was_active" = active ]; then systemctl restart "$SERVICE"; say "upgraded to $VERSION and restarted"; else say "upgraded to $VERSION (service was not running)"; fi
}

case "${1:-install}" in
  install) do_install ;;
  upgrade) do_upgrade ;;
  uninstall)
    [ -x "$CLI_PATH" ] || fail "fridayone is not installed; nothing to uninstall"
    exec "$CLI_PATH" uninstall "${@:2}" ;;
  *) fail "usage: sudo bash install.sh [install|upgrade|uninstall]" 2 ;;
esac
