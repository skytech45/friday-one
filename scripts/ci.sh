#!/usr/bin/env bash
# Local CI gate (plan v2.0) — mirrors .github/workflows/ci.yml.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

for c in gateway connector control-plane; do
  echo "== typecheck $c =="
  ( cd "$c" && npm install --ignore-scripts >/dev/null 2>&1 || npm install --ignore-scripts; npx tsc --noEmit )
done

echo "== connector bundle builds =="
( cd connector && bash build-release.sh 0.0.0-local >/dev/null && rm -rf release )

echo "== gitleaks (full history; false positives in .gitleaksignore) =="
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --source "$REPO_ROOT" --no-banner --redact
elif command -v docker >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  sudo -n docker run --rm -v "$REPO_ROOT:/repo" zricethezav/gitleaks:latest detect --source /repo --no-banner --redact
else
  echo "SKIP: gitleaks not available (CI runs it)"
fi

echo "== CI GATE: ALL GREEN =="
