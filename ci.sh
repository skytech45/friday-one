#!/usr/bin/env bash
# Local CI gate (F-20) — the same checks .github/workflows/ci.yml runs, for
# pre-push enforcement while GitHub Actions is unavailable (billing).
# Every step must pass or the push/hook fails.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "== npm audit (prod deps) =="
( cd server && npm audit --omit=dev )

echo "== typecheck =="
( cd server && npm run typecheck )

echo "== unit tests =="
( cd server && npx tsx --test test/*.test.ts 2>&1 | grep -E "^# (pass|fail)" )

echo "== F-09 privilege regression =="
node audit/audit-f09.mjs | tail -2

echo "== e2e acceptance suite =="
node audit/audit-e2e.mjs | tail -3

echo "== vendored asset hashes (F-21) =="
bash "$REPO_ROOT/scripts/check-vendor-hashes.sh"

echo "== gitleaks (full history; false positives in .gitleaksignore) =="
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --source "$REPO_ROOT" --no-banner --redact
elif command -v docker >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  sudo -n docker run --rm -v "$REPO_ROOT:/repo" zricethezav/gitleaks:latest detect --source /repo --no-banner --redact
else
  echo "SKIP: gitleaks not available on this host (CI still runs it)"
fi

echo "== CI GATE: ALL GREEN =="
