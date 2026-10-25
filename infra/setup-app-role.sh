#!/usr/bin/env bash
# Create (or rotate the password of) the least-privilege application role
# that the API server connects with — F-09. The container bootstrap role
# (POSTGRES_USER=friday) is a PostgreSQL superuser; the server must never
# connect with it. This script:
#
#   1. creates the friday_app role with LOGIN only — no SUPERUSER, CREATEDB,
#      CREATEROLE, REPLICATION or BYPASSRLS;
#   2. grants it CONNECT + DML on the existing schema and, via default
#      privileges, on everything the bootstrap role creates afterwards;
#   3. prints the DATABASE_URL line to put in server/.env (the bootstrap URL
#      moves to MIGRATE_DATABASE_URL, which only migrate.ts reads).
#
# Idempotent. Password: pass APP_ROLE_PASSWORD=... to pin one (rotation),
# otherwise a fresh one is generated. The generated password is NOT stored
# anywhere by this script — capture the printed URL when you run it.
set -euo pipefail

APP_PW="${APP_ROLE_PASSWORD:-$(openssl rand -hex 24)}"
CONTAINER="${FRIDAY_PG_CONTAINER:-friday-pg}"

sudo -n docker exec -i "$CONTAINER" psql -U friday -d friday <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'friday_app') THEN
    CREATE ROLE friday_app LOGIN PASSWORD '$APP_PW';
  ELSE
    ALTER ROLE friday_app LOGIN PASSWORD '$APP_PW';
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE friday TO friday_app;
GRANT USAGE ON SCHEMA public TO friday_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO friday_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO friday_app;
ALTER DEFAULT PRIVILEGES FOR ROLE friday IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO friday_app;
ALTER DEFAULT PRIVILEGES FOR ROLE friday IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO friday_app;
SQL

HOST="127.0.0.1"; PORT="5433"  # pinned by infra/docker-compose.yml
echo
echo "Put this in server/.env as DATABASE_URL (and move the bootstrap URL to MIGRATE_DATABASE_URL):"
echo "DATABASE_URL=postgres://friday_app:${APP_PW}@${HOST}:${PORT}/friday"
