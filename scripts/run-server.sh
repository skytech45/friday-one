#!/usr/bin/env bash
# Start the FRIDAY One API server.
# Loads server/.env via Node's process.loadEnvFile (see server/src/env.ts),
# runs pending migrations, then execs the built server.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

cd "$SERVER_DIR"

# Install deps if node_modules is missing (first boot)
if [ ! -d node_modules ]; then
  npm ci --ignore-scripts
fi

# Run database migrations (idempotent — migrate.ts uses IF NOT EXISTS / ON CONFLICT)
npx tsx src/migrate.ts

# Start the API. It binds to 127.0.0.1:8787 by default (see server/src/index.ts).
# The tunnel is what exposes it; the server never listens on a public interface.
exec npx tsx src/index.ts
