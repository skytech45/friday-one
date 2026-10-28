#!/usr/bin/env bash
# Build the connector as a single self-contained Node bundle + checksums
# (plan v2.0 §3: versioned, immutable release assets).
set -euo pipefail
cd "$(dirname "$0")"
VER="${1:?version required}"
OUT="release/friday-connector-${VER}"
mkdir -p release
npx esbuild src/index.ts --bundle --platform=node --target=node22 \
  --format=esm --outfile="${OUT}.js" --minify \
  --define:__FRIDAY_VERSION__="\"${VER}\"" \
  --banner:js="import { createRequire as __fridayCreateRequire } from 'node:module'; const require = __fridayCreateRequire(import.meta.url);"
# CommonJS dependencies (ws, qrcode) call require() at runtime; an ESM bundle
# has none unless the banner provides it. Without it the bundle crashed at
# startup with "Dynamic require of \"fs\" is not supported" (v0.6.0, v0.9.0).
# Smoke-run the artifact so a broken bundle can never be published again.
node "${OUT}.js" version >/dev/null || { echo "bundle does not start: ${OUT}.js" >&2; exit 1; }
node -e "require('node:fs').chmodSync('${OUT}.js', 0o755)" 2>/dev/null || true
sha256sum "${OUT}.js" > "${OUT}.js.sha256"
echo "built ${OUT}.js"
cat "${OUT}.js.sha256"
