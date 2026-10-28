#!/usr/bin/env bash
# fridayone CLI tests with stubbed system tools (runs without root or systemd,
# including on Windows Git Bash). The real-systemd path is covered by
# test/e2e/installer-e2e.sh on Linux CI.
#
#   bash test/cli/cli-harness.sh        (from connector/, after npm ci)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONNECTOR="$(cd "$HERE/../.." && pwd)"
CLI="$CONNECTOR/cli/fridayone"
TOKEN="e2e-enrollment-token-0123456789abcdef"
PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "ok - $1"; }
nope() { FAIL=$((FAIL + 1)); echo "not ok - $1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/    | /' | head -40; }
has()  { printf '%s' "$1" | grep -qF -- "$2"; }

R="$(mktemp -d)"; STUBS="$R/.stubs"; LOG="$R/.stub.log"
cleanup() { [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null; rm -rf "$R"; }
trap cleanup EXIT

# ------------------------------------------------------------------ fixture
mkdir -p "$STUBS" "$R/etc/friday-connector/policies" "$R/etc/systemd/system" "$R/opt/friday-connector" \
         "$R/usr/local/bin" "$R/run/friday-connector" "$R/srv/app" "$R/var/lib/friday-connector"
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' > "$R/etc/os-release"
(cd "$CONNECTOR" && bash build-release.sh v0.0.0 >/dev/null) || { echo "bundle build failed"; exit 1; }
cp "$CONNECTOR/release/friday-connector-v0.0.0.js" "$R/opt/friday-connector/friday-connector.js"
rm -rf "$CONNECTOR/release"
echo "[Unit]" > "$R/etc/systemd/system/friday-connector.service"

PORTS="$R/.ports.json"
(cd "$CONNECTOR" && FAKE_ADVERTISE_SCHEME=http node test/e2e/fake-backend.mjs "$PORTS") & BACKEND_PID=$!
for _ in $(seq 1 50); do [ -s "$PORTS" ] && break; sleep 0.2; done
HTTP_PORT="$(node -p "require('$PORTS'.replace(/\\\\/g,'/')).http" 2>/dev/null || node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).http))" "$PORTS")"
WS_PORT="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).ws))" "$PORTS")"
CP="http://127.0.0.1:$HTTP_PORT"
printf 'FRIDAY_CONTROL_PLANE_URL=%s\nFRIDAY_GATEWAY_URL=\nFRIDAY_ALLOWED_ROOTS=\n' "$CP" > "$R/etc/friday-connector/connector.env"

# ------------------------------------------------------------------- stubs
cat > "$STUBS/systemctl" <<EOF
#!/usr/bin/env bash
echo "systemctl \$*" >> "$LOG"
case "\$1" in
  is-active) [ -f "$R/.active" ] && echo active || echo inactive ;;
  is-enabled) echo enabled ;;
  restart)
    touch "$R/.active"
    # Simulates the service authenticating (or being refused) at the gateway.
    case "\${STUB_CONNECT:-connected}" in
      connected) printf '{"state":"connected","serverId":"11111111-2222-4333-8444-555555555555","since":"now","lastError":null}' > "$R/run/friday-connector/state.json" ;;
      revoked)   printf '{"state":"revoked","lastCloseCode":4403,"lastError":"credential_revoked"}' > "$R/run/friday-connector/state.json" ;;
    esac ;;
  disable) rm -f "$R/.active" ;;
esac
exit 0
EOF
cat > "$STUBS/runuser" <<EOF
#!/usr/bin/env bash
# Record argv (the token must never appear here), then simulate enrollment:
# the real connector refuses non-0600 credential files, which Windows cannot express.
echo "runuser \$*" >> "$LOG"
[ "\${FRIDAY_ENROLLMENT_TOKEN:-}" = "$TOKEN" ] || { echo "enrollment session rejected (HTTP 403)" >&2; exit 1; }
printf 'credential-from-stub\n' > "\$FRIDAY_CREDENTIAL_FILE"
echo "paired ✓"
EOF
cat > "$STUBS/journalctl" <<'EOF'
#!/usr/bin/env bash
echo "2026-10-28T10:00:00 connector[1]: auth sent credential=supersecretvalue1234567890abcdefghij"
echo "2026-10-28T10:00:01 connector[1]: [gateway] reconnect in 1200ms (attempt 1)"
EOF
cat > "$STUBS/id" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "-u" ] && [ "${2:-}" = "friday-connector" ] && { echo 999; exit 0; }
[ "$#" -eq 1 ] && [ "$1" = "-u" ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
EOF
printf '#!/usr/bin/env bash\necho "127.0.0.1 $2"\n' > "$STUBS/getent"
printf '#!/usr/bin/env bash\necho "userdel $*" >> "%s"\n' "$LOG" > "$STUBS/userdel"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUBS/chown"
chmod +x "$STUBS"/*

run() { # stdin = answers; prints combined output, returns exit status
  FRIDAY_ROOT="$R" FRIDAY_TEST_ALLOW_NONROOT=1 FRIDAY_ALLOW_INSECURE_LOCAL=1 FRIDAY_CONNECT_TIMEOUT=3 \
    PATH="$STUBS:$PATH" bash "$CLI" "$@" 2>&1
}

# ------------------------------------------------------------------- tests
out="$(run --help)"; has "$out" "fridayone setup" && ok "help lists setup" || nope "help lists setup" "$out"
out="$(run --version)"; { has "$out" "fridayone dev" && has "$out" "connector v0.0.0"; } && ok "version shows CLI and connector" || nope "version" "$out"

out="$(run status)"; rc=$?
[ "$rc" -ne 0 ] && has "$out" "not paired" && ok "status before pairing: not paired, non-zero" || nope "status before pairing" "$out"

out="$(printf '\n\n/srv/app\n%s\n' "$TOKEN" | run setup)"; rc=$?
if [ "$rc" -eq 0 ] && has "$out" "Gateway connected" && has "$out" "connected as server 11111111"; then ok "setup: pairs, starts, reports connection"; else nope "setup happy path (rc=$rc)" "$out"; fi
for stage in "Package installed" "Configuration saved" "Pairing successful" "Gateway authenticated" "Gateway connected"; do
  printf '%s' "$out" | grep -q "✔ $stage" && ok "setup report: $stage" || nope "setup report: $stage" "$out"
done
printf '%s' "$out" | grep -q "✖ Agent available" && ok "setup report: missing agent is reported, not hidden" || nope "agent stage" "$out"
has "$out" "End-to-end command test: not run here" && ok "setup does not claim an end-to-end test it did not run" || nope "e2e honesty" "$out"
env_now="$(cat "$R/etc/friday-connector/connector.env")"
has "$env_now" "FRIDAY_GATEWAY_URL=ws://127.0.0.1:$WS_PORT" && ok "advertised http(s) gateway URL from /health saved as ws(s)" || nope "gateway from health" "$env_now"
has "$env_now" "FRIDAY_ALLOWED_ROOTS=/srv/app" && ok "project root saved" || nope "roots" "$env_now"
grep -q "ReadWritePaths= /srv/app" "$R/etc/systemd/system/friday-connector.service.d/10-project-roots.conf" && ok "systemd drop-in grants only the project root" || nope "drop-in" "$(cat "$R/etc/systemd/system/friday-connector.service.d/10-project-roots.conf" 2>&1)"
if grep -rqF "$TOKEN" "$R/etc" "$LOG" 2>/dev/null || has "$out" "$TOKEN"; then nope "token leaked to config, argv log or output"; else ok "enrollment token never written, echoed or passed in argv"; fi
compgen -G "$R/etc/friday-connector/connector.env.bak.*" >/dev/null && ok "previous config backed up before rewrite" || nope "config backup"

out="$(run status)"; rc=$?
[ "$rc" -eq 0 ] && has "$out" "connected as server" && ok "status: connected, exit 0" || nope "status connected" "$out"

out="$(printf 'y\n\n\n/srv/app\nnot a token!\n' | run setup)"; rc=$?
[ "$rc" -ne 0 ] && has "$out" "does not look like an enrollment token" && ok "setup rejects a malformed token" || nope "malformed token" "$out"
out="$(printf 'N\nhttp://evil.example\n' | run setup)"; rc=$?
[ "$rc" -ne 0 ] && has "$out" "invalid control plane URL" && ok "setup rejects a non-HTTPS control plane" || nope "http URL" "$out"
out="$(printf 'N\n\n\n/etc\n' | run setup)"; rc=$?
[ "$rc" -ne 0 ] && has "$out" "not an allowed project directory: /etc" && ok "setup refuses system paths as project roots" || nope "root /etc" "$out"
out="$(printf 'N\n\nwss://gw.example.test/x?token=abc\n' | run setup)"; rc=$?
[ "$rc" -ne 0 ] && has "$out" "invalid gateway URL" && ok "setup refuses URLs with query strings (no secrets in URLs)" || nope "url query" "$out"

out="$(printf 'y

https://gw.example.test/realtime
/srv/app
%s
' "$TOKEN" | run setup)"; rc=$?
{ [ "$rc" -eq 0 ] && grep -q "^FRIDAY_GATEWAY_URL=wss://gw.example.test/realtime$" "$R/etc/friday-connector/connector.env"; }   && ok "typed https:// gateway URL saved as wss://" || nope "typed https gateway (rc=$rc)" "$out"

out="$(STUB_CONNECT=revoked run reconnect)"; rc=$?
[ "$rc" -eq 78 ] && has "$out" "revoked or expired" && ok "reconnect after revocation: exit 78 with re-pair hint" || nope "revoked reconnect (rc=$rc)" "$out"
out="$(run status)"; rc=$?
[ "$rc" -ne 0 ] && has "$out" "REFUSED" && ok "status reports revocation, non-zero" || nope "status revoked" "$out"

out="$(run logs)"
{ has "$out" "[redacted]" && ! has "$out" "supersecretvalue"; } && ok "logs redact credentials" || nope "logs redaction" "$out"

out="$(run doctor)"; rc=$?
{ has "$out" "control plane HTTPS reachable" && has "$out" "gateway refused this connector" && ! has "$out" "credential-from-stub"; } \
  && ok "doctor checks reachability and auth state without printing the credential" || nope "doctor" "$out"

printf 'ID=fedora\nVERSION_ID="40"\n' > "$R/etc/os-release"
out="$(printf '\n' | run setup)"; rc=$?
[ "$rc" -ne 0 ] && has "$out" "not a tested distribution" && ok "setup refuses untested OS by default" || nope "untested OS" "$out"
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' > "$R/etc/os-release"

out="$(run uninstall --yes)"
{ [ ! -e "$R/opt/friday-connector" ] && [ -f "$R/etc/friday-connector/credential" ]; } && ok "uninstall keeps config unless --purge" || nope "uninstall keep" "$out"
out="$(run uninstall --yes --purge)"
[ ! -e "$R/etc/friday-connector" ] && grep -q "userdel friday-connector" "$LOG" && ok "uninstall --purge removes config and service user" || nope "uninstall purge" "$out"
has "$out" "revoke this server in the FRIDAY One app" && ok "uninstall reminds to revoke server-side" || nope "revoke reminder" "$out"

echo "# pass $PASS"
echo "# fail $FAIL"
[ "$FAIL" -eq 0 ]
