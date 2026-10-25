#!/usr/bin/env bash
# Build the connector as a single self-contained Node bundle + checksums
# (plan v2.0 §3: versioned, immutable release assets).
set -euo pipefail
cd "$(dirname "$0")"
VER="${1:?version required}"
OUT="release/friday-connector-${VER}"
mkdir -p release
npx esbuild src/index.ts --bundle --platform=node --target=node22 \
  --format=esm --outfile="${OUT}.js" --minify
node -e "require('node:fs').chmodSync('${OUT}.js', 0o755)" 2>/dev/null || true
sha256sum "${OUT}.js" > "${OUT}.js.sha256"
echo "built ${OUT}.js"
cat "${OUT}.js.sha256"
