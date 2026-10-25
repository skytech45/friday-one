#!/usr/bin/env bash
# F-21: the vendored terminal assets must match the hashes recorded in
# THIRD-PARTY.md. A silent vendor swap is exactly how unreviewed code ships.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/android/app/src/main/assets/terminal"

check() {
  local file="$1" expected="$2"
  local actual
  actual="$(sha256sum "$DIR/$file" | cut -d' ' -f1)"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL  $file: sha256 $actual != recorded $expected" >&2
    exit 1
  fi
  echo "PASS  $file"
}

check xterm.js    7a88e46a58847d3f17109e3d48cc8aa056a01997d00ceb76035f63370712d858
check addon-fit.js 3e9ae6f6965ee1269d5574b905cf1bf559c2f44c784255b0034a71387e7719c9
check xterm.css   ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6
check index.html  6bdd65a8316498f87b4d86bba6cdcf90fd613963755660f272a61cefd6ad8c6d
echo "vendor hashes OK"
