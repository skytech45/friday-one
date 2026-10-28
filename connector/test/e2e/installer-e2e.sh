#!/usr/bin/env bash
# Installer + fridayone + connector end-to-end test on a real Linux host with
# systemd (GitHub Actions ubuntu runner). DESTRUCTIVE to the host's
# friday-connector install: never run it on a production VPS.
#
#   sudo env PATH="$PATH" bash connector/test/e2e/installer-e2e.sh
#
# Uses a local release mirror (built from this checkout) and the fake
# backend (real protocol). Proves: verified install, real pairing through
# fridayone setup, gateway authentication, reconnect after a drop, restart
# recovery, revocation stops the service, idempotent re-install, upgrade
# keeps config, checksum tampering fails closed, uninstall --purge.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONNECTOR="$(cd "$HERE/../.." && pwd)"
VERSION="v0.0.1"
TOKEN="e2e-enrollment-token-0123456789abcdef"
CREDENTIAL="e2e-connector-credential-0123456789abcdefghijklmnop"
WORK="$(mktemp -d)"; MIRROR="$WORK/mirror"; PORTS="$WORK/ports.json"
PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "ok - $1"; }
nope() { FAIL=$((FAIL + 1)); echo "not ok - $1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/    | /' | tail -40; }
has()  { printf '%s' "$1" | grep -qF -- "$2"; }
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.argv[1]];process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))})' "$1"; }
cleanup() {
  [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null
  [ -n "${MIRROR_PID:-}" ] && kill "$MIRROR_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || { echo "run as root (CI only)"; exit 2; }

# ------------------------------------------------------------ release mirror
mkdir -p "$MIRROR/$VERSION"
(cd "$CONNECTOR" && bash build-release.sh "$VERSION" >/dev/null) || { echo "build failed"; exit 1; }
for arch in x64 arm64; do
  cp "$CONNECTOR/release/friday-connector-$VERSION.js" "$MIRROR/$VERSION/friday-connector-$VERSION-linux-$arch.js"
done
rm -rf "$CONNECTOR/release"
sed "s/^FRIDAY_CLI_VERSION=\"dev\"/FRIDAY_CLI_VERSION=\"$VERSION\"/" "$CONNECTOR/cli/fridayone" > "$MIRROR/$VERSION/fridayone"
sed -E "s/^VERSION=\"\\\$\{FRIDAY_CONNECTOR_VERSION:-v[0-9][^}]*\}\"/VERSION=\"\${FRIDAY_CONNECTOR_VERSION:-$VERSION}\"/" "$CONNECTOR/install.sh" > "$MIRROR/$VERSION/install.sh"
(cd "$MIRROR/$VERSION" && for f in *; do sha256sum "$f" > "$f.sha256"; done)
python3 -m http.server 18765 --bind 127.0.0.1 --directory "$MIRROR" >/dev/null 2>&1 & MIRROR_PID=$!
export FRIDAY_RELEASE_BASE_URL="http://127.0.0.1:18765"

# ---------------------------------------------------------------- backend
(cd "$CONNECTOR" && node test/e2e/fake-backend.mjs "$PORTS") & BACKEND_PID=$!
for _ in $(seq 1 50); do [ -s "$PORTS" ] && break; sleep 0.2; done
HTTP="http://127.0.0.1:$(json http < "$PORTS")"
backend() { curl -fsS -X "${2:-GET}" "$HTTP/__control/$1"; }
sleep 1

# ---------------------------------------------------------------- install
out="$(bash "$MIRROR/$VERSION/install.sh" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && has "$out" "checksums verified" && ok "install: verified download and install" || nope "install (rc=$rc)" "$out"
id -u friday-connector >/dev/null 2>&1 && ok "unprivileged service account created" || nope "service account"
[ "$(getent passwd friday-connector | cut -d: -f7)" = /usr/sbin/nologin ] && ok "service account has no login shell" || nope "nologin"
has "$(fridayone --version)" "fridayone $VERSION" && ok "fridayone --version is the release tag" || nope "cli version" "$(fridayone --version 2>&1)"
[ "$(systemctl is-active friday-connector)" != active ] && ok "service not started before pairing" || nope "started unpaired"
fridayone status >/dev/null 2>&1; [ $? -ne 0 ] && ok "status before pairing is non-zero" || nope "status unpaired"

# ------------------------------------------------------------------ setup
mkdir -p /srv/friday-e2e
out="$(printf '%s\n\n/srv/friday-e2e\n%s\n' "$HTTP" "$TOKEN" | FRIDAY_ALLOW_INSECURE_LOCAL=1 FRIDAY_CONNECT_TIMEOUT=45 fridayone setup 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && has "$out" "Gateway connected"; then ok "setup: real pairing, then gateway-authenticated connection"; else nope "setup (rc=$rc)" "$out$(journalctl -u friday-connector -n 30 --no-pager)"; fi
has "$out" "1234 5678 9012 3456" && ok "setup shows the numeric pairing code (QR fallback)" || nope "pairing code shown" "$out"
st="$(backend state)"
[ "$(printf '%s' "$st" | json authOk)" -ge 1 ] && ok "fake gateway saw an authenticated connector" || nope "gateway auth" "$st"
[ "$(printf '%s' "$st" | json tokenInUrl)" != true ] && ok "enrollment token never sent in a URL" || nope "token in URL" "$st"

cred=/etc/friday-connector/credential
[ "$(stat -c '%a %U' "$cred")" = "600 friday-connector" ] && ok "credential is 0600, owned by the service account" || nope "credential perms" "$(stat -c '%a %U' "$cred")"
[ "$(stat -c '%a %U:%G' /etc/friday-connector/connector.env)" = "640 root:friday-connector" ] && ok "config is 0640 root:friday-connector" || nope "env perms" "$(stat -c '%a %U:%G' /etc/friday-connector/connector.env)"
pid="$(systemctl show -p MainPID --value friday-connector)"
[ "$(ps -o user= -p "$pid" | tr -d ' ')" = friday-connector ] && ok "connector runs as friday-connector, not root" || nope "process user" "$(ps -o user=,cmd= -p "$pid")"
listen="$(ss -ltnpH 2>/dev/null | grep "pid=$pid," || true)"
[ -z "$listen" ] && ok "connector opens no inbound listening port" || nope "inbound listener" "$listen"
out="$(fridayone status 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && has "$out" "connected as server" && ok "fridayone status: connected" || nope "status" "$out"
out="$(FRIDAY_ALLOW_INSECURE_LOCAL=1 fridayone doctor 2>&1)"; rc=$?
{ has "$out" "gateway authenticated this connector" && has "$out" "bundle checksum matches"; } && ok "fridayone doctor: auth + integrity checks pass" || nope "doctor (rc=$rc)" "$out"

# Reusing the enrollment token must fail and must not disturb the live pairing.
out="$(printf 'y\n%s\n\n/srv/friday-e2e\n%s\n' "$HTTP" "$TOKEN" | FRIDAY_ALLOW_INSECURE_LOCAL=1 fridayone setup 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && has "$out" "pairing failed" && ok "a reused enrollment token is rejected" || nope "token reuse (rc=$rc)" "$out"
[ "$(fridayone status >/dev/null 2>&1; echo $?)" -eq 0 ] && ok "failed re-pair leaves the working connection intact" || nope "intact after reuse"

# ------------------------------------------------- reconnect and restarts
before="$(backend state | json authOk)"
backend drop POST >/dev/null
for _ in $(seq 1 60); do [ "$(backend state | json authOk)" -gt "$before" ] && break; sleep 1; done
[ "$(backend state | json authOk)" -gt "$before" ] && ok "connector reconnects after the gateway drops it" || nope "reconnect after drop" "$(journalctl -u friday-connector -n 20 --no-pager)"
systemctl restart friday-connector
for _ in $(seq 1 30); do fridayone status >/dev/null 2>&1 && break; sleep 1; done
fridayone status >/dev/null 2>&1 && ok "service restart (reboot path) reconnects" || nope "restart recovery"
[ "$(systemctl is-enabled friday-connector)" = enabled ] && ok "service enabled at boot" || nope "enabled"

# --------------------------------------------------------------- revocation
backend revoke POST >/dev/null
for _ in $(seq 1 30); do [ "$(systemctl is-active friday-connector)" != active ] && break; sleep 1; done
sleep 25 # longer than RestartSec: a restart loop would show up here
st="$(backend state)"
[ "$(systemctl is-active friday-connector)" != active ] && ok "revoked connector stops (exit 78, no restart)" || nope "still active after revoke"
[ "$(systemctl show -p NRestarts --value friday-connector)" = 0 ] && ok "no restart loop after revocation" || nope "restarts after revoke" "$(systemctl show -p NRestarts friday-connector)"
[ "$(printf '%s' "$st" | json authRefused)" -le 1 ] && ok "no reconnect hammering with a dead credential" || nope "auth refused count" "$st"
out="$(fridayone status 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && has "$out" "revoked" && ok "status reports the revocation" || nope "status revoked" "$out"

# ------------------------------------------------- re-install and upgrade
cp /etc/friday-connector/connector.env "$WORK/env.before"
out="$(bash "$MIRROR/$VERSION/install.sh" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && [ "$(grep -c '^friday-connector:' /etc/passwd)" = 1 ] && ok "re-running install is idempotent (one account)" || nope "re-install" "$out"
cmp -s "$WORK/env.before" /etc/friday-connector/connector.env && ok "re-install keeps configuration" || nope "config changed by re-install"
out="$(bash "$MIRROR/$VERSION/install.sh" upgrade 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && cmp -s "$WORK/env.before" /etc/friday-connector/connector.env && ok "upgrade keeps configuration" || nope "upgrade" "$out"

# ---------------------------------------------------- integrity failure
before_sum="$(sha256sum /opt/friday-connector/friday-connector.js | cut -d' ' -f1)"
printf '\n// tampered\n' >> "$MIRROR/$VERSION/friday-connector-$VERSION-linux-x64.js"
printf '\n// tampered\n' >> "$MIRROR/$VERSION/friday-connector-$VERSION-linux-arm64.js"
out="$(bash "$MIRROR/$VERSION/install.sh" upgrade 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && has "$out" "CHECKSUM MISMATCH" && ok "tampered download fails closed" || nope "tamper (rc=$rc)" "$out"
[ "$(sha256sum /opt/friday-connector/friday-connector.js | cut -d' ' -f1)" = "$before_sum" ] && ok "installed connector untouched after a failed download" || nope "binary replaced"

# --------------------------------------------------------------- secrets
logs="$(journalctl -u friday-connector --no-pager 2>/dev/null)"
if has "$logs" "$TOKEN" || has "$logs" "$CREDENTIAL"; then nope "token or credential in the journal"; else ok "journal contains neither the token nor the credential"; fi

# --------------------------------------------------------------- uninstall
out="$(fridayone uninstall --yes --purge 2>&1)"
{ [ ! -e /etc/systemd/system/friday-connector.service ] && [ ! -e /etc/friday-connector ] && ! id -u friday-connector >/dev/null 2>&1 && [ ! -e /usr/local/bin/fridayone ]; } \
  && ok "uninstall --purge removes unit, config, account and CLI" || nope "uninstall" "$out"

echo "# pass $PASS"
echo "# fail $FAIL"
[ "$FAIL" -eq 0 ]
