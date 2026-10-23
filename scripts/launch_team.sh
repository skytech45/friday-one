#!/bin/bash
# Launch the FRIDAY One workstreams in parallel via OpenCode.
#
# Concurrency note: this box has 2 cores and every Android build runs aapt2
# through qemu, so the agents each flock /tmp/gradle.lock before building.
# They write code in parallel and serialise only on the compile step.
set -uo pipefail

MODEL="${MODEL:-xkiro/qwen/qwen3.8-max:free}"
ROOT=/home/ubuntu/friday-one
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

COMMON="You are a senior engineer on the FRIDAY One project. Work in $ROOT.
FIRST read $ROOT/docs/SHARED.md and $ROOT/docs/TASKS.md completely - they are the contract.
Then implement ONLY your assigned workstream. Stay strictly inside the files your
workstream owns; other agents are editing this repo concurrently and two agents
editing one file destroys work.
Verify your work for real before reporting: backend must pass 'npx tsc --noEmit';
Android changes must compile via 'cd $ROOT/android && flock /tmp/gradle.lock ./build.sh debug'.
Never report success you did not observe - say plainly what you could not verify.
Do not commit secrets. Do not weaken auth or the filesystem path jail."

run_ws() {
  local name="$1" task="$2"
  echo "[$(date +%H:%M:%S)] START $name"
  ( cd "$ROOT" && opencode run "$COMMON

YOUR WORKSTREAM: $name
$task" --model "$MODEL" > "$LOGS/$name.log" 2>&1 )
  echo "[$(date +%H:%M:%S)] DONE  $name exit=$?"
}

WS1="Implement the file explorer with upload and download, exactly as specified in the
'WS1 - File explorer' section of docs/TASKS.md. Create the feature/files package. The
backend endpoints (/fs/list, /fs/download, /fs/upload) already exist and are verified;
read server/src/routes/files.ts so your client matches it exactly. Do NOT edit
MainActivity.kt, TerminalScreen.kt or data/Api.kt - if you need a new API method, put
it in your own package using a Retrofit interface you declare there."

WS2="Implement the terminal/TUI quality work in the 'WS2 - Terminal' section of
docs/TASKS.md. Vendor the renderer into app/src/main/assets (no runtime CDN). Handle
SGR colour, cursor movement, erase, and the alternate screen buffer - Hermes and
OpenCode are Ink-based TUIs and will look like garbage without alt-screen support.
Create the feature/terminal package. Do NOT edit MainActivity.kt or data/Api.kt."

WS3="Implement the security hardening in the 'WS3 - Security' section of docs/TASKS.md:
certificate pinning (loopback exempt), a biometric app lock that fails closed, root/
tamper detection reported as telemetry rather than a hard block, and an OkHttp
Authenticator doing token refresh bound to the device fingerprint. Create
data/NetworkModule.kt. Do NOT edit MainActivity.kt, Api.kt or SessionStore.kt."

WS4="Implement the backend additions in the 'WS4 - Backend' section of docs/TASKS.md:
HTTP Range support on /fs/download (206), a bounded /fs/search, streaming uploads that
do not buffer the whole file in memory, and node:test tests proving the path jail
rejects traversal and symlink escape. You own server/src except routes/terminal.ts.
'server/.env' has DATABASE_URL and the secrets - read it, never print or commit it.
Prove your tests pass with 'cd server && npx tsx --test test/*.test.ts'."

WS5="Implement the deployment work in the 'WS5 - Deployment' section of docs/TASKS.md:
scripts/run-server.sh, scripts/tunnel.sh, hardened systemd units under infra/systemd/,
and docs/DEPLOY.md documenting both the account-less quick tunnel that is running now
and the permanent named tunnel. Read the existing /etc/systemd/system/friday-console.service
for the hardening pattern to follow. Do not touch the running Tailscale setup."

run_ws ws1 "$WS1" &
run_ws ws2 "$WS2" &
run_ws ws3 "$WS3" &
run_ws ws4 "$WS4" &
run_ws ws5 "$WS5" &

wait
echo "=== ALL WORKSTREAMS FINISHED ==="
for f in "$LOGS"/ws*.log; do echo "$f: $(wc -l < "$f") lines"; done
