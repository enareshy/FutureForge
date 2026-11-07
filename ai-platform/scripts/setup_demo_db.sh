#!/usr/bin/env bash
# Reproducibly build an isolated, synthetic demo/pilot PostgreSQL database.
#
# This is for the DEMO ONLY. It refuses to run against anything but an
# explicitly named, dedicated database and never touches the live/shared
# instance. It applies the same fresh-install order used in production:
#
#   0001..0018  -> provision least-privilege roles -> 0019..0026 -> re-grant
#
# Requirements (documented in docs/DEMO_PILOT.md):
#   - PostgreSQL 16 reachable via the PG* variables below
#   - pgvector/citext/pg_trgm available to a superuser
#   - run as a superuser (role provisioning is superuser-only by design)
#
# The application seed data itself is created separately by scripts/seed_demo.py
# through the public API, so this script only prepares an empty, correctly
# provisioned database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=55432}"
: "${PGUSER:=postgres}"
: "${PGPASSWORD:=}"
: "${DEMO_DB:=step12_demo}"
export PGPASSWORD

if [ "$PGUSER" != "postgres" ]; then
  echo "refusing to provision roles as '$PGUSER'; run as a database superuser" >&2
  exit 1
fi
case "$DEMO_DB" in
  helix|postgres|template0|template1)
    echo "refusing to use '$DEMO_DB' as a demo database" >&2
    exit 1
    ;;
esac

PSQL=(psql -w -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$PGUSER")

# migrate.sh sources a .env file when one exists in its root. To guarantee the
# demo never inherits the live/shared connection settings, run it from a
# throwaway copy that contains only the migrations and migrate.sh.
MIGRATE_DIR="$(mktemp -d /tmp/step12-demo-migrate.XXXXXX)"
echo "==> using isolated migration copy at $MIGRATE_DIR"
mkdir -p "$MIGRATE_DIR/scripts"
cp -R "$ROOT/migrations" "$MIGRATE_DIR/migrations"
cp "$ROOT/scripts/migrate.sh" "$MIGRATE_DIR/scripts/migrate.sh"
chmod +x "$MIGRATE_DIR/scripts/migrate.sh"

echo "==> creating dedicated demo database '$DEMO_DB'"
if ! "${PSQL[@]}" -d postgres -qtAc \
  "SELECT 1 FROM pg_database WHERE datname = '${DEMO_DB}'" | grep -q 1; then
  "${PSQL[@]}" -d postgres -q -c "CREATE DATABASE ${DEMO_DB};"
else
  # Never drop an existing database from automation. A non-empty demo DB may
  # hold a curated walkthrough; require an explicit new name instead.
  existing="$("${PSQL[@]}" -d "$DEMO_DB" -qtAc \
    "SELECT to_regclass('ai.schema_migrations') IS NOT NULL")"
  if [ "$existing" = "t" ]; then
    echo "database '$DEMO_DB' is already migrated; choose a fresh DEMO_DB name" >&2
    echo "(refusing to drop or overwrite existing demo data)" >&2
    exit 1
  fi
fi
"${PSQL[@]}" -d "$DEMO_DB" -q -c \
  "CREATE EXTENSION IF NOT EXISTS vector; \
   CREATE EXTENSION IF NOT EXISTS citext; \
   CREATE EXTENSION IF NOT EXISTS pg_trgm;"

run_migrations() {
  local stop_after="$1" user="$2" password="$3" profile="$4"
  (
    cd "$MIGRATE_DIR"
    PGOPTIONS="" \
    POSTGRES_HOST="$PGHOST" POSTGRES_PORT="$PGPORT" \
    POSTGRES_DB="$DEMO_DB" \
    POSTGRES_USER="$user" POSTGRES_PASSWORD="$password" \
    AI_DB_ROLE_PROFILE="$profile" \
    AI_MIGRATION_STOP_AFTER="$stop_after" \
    bash scripts/migrate.sh
  )
}

echo "==> applying migrations 0001..0018"
run_migrations "0018_tenant_row_level_security.sql" "$PGUSER" "$PGPASSWORD" ""

echo "==> provisioning least-privilege roles"
"${PSQL[@]}" -d "$DEMO_DB" -q --single-transaction \
  -f "$ROOT/infrastructure/db/roles/provision_roles.sql"

echo "==> setting demo-only role passwords"
# Demo-only credentials. Never reuse these outside the isolated environment.
"${PSQL[@]}" -d "$DEMO_DB" -q -c "ALTER ROLE ai_api PASSWORD 'api-test'; \
  ALTER ROLE ai_worker PASSWORD 'worker-test'; \
  ALTER ROLE ai_backup PASSWORD 'backup-test'; \
  ALTER ROLE ai_restore PASSWORD 'restore-test'; \
  ALTER ROLE ai_migrate PASSWORD 'migrate-test';"

echo "==> applying migrations 0019..0026 as ai_migrate"
run_migrations "" "ai_migrate" "migrate-test" "migrate"

echo "==> re-granting on newly created objects"
"${PSQL[@]}" -d "$DEMO_DB" -q --single-transaction \
  -f "$ROOT/infrastructure/db/roles/provision_roles.sql"

"${PSQL[@]}" -d "$DEMO_DB" -tAc \
  "SELECT 'migrations=' || count(*) FROM ai.schema_migrations;"
"${PSQL[@]}" -d "$DEMO_DB" -tAc \
  "SELECT 'force_rls=' || count(*) FROM pg_class c \
     JOIN pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = 'ai' AND c.relkind = 'r' \
       AND c.relrowsecurity AND c.relforcerowsecurity;"

echo "==> demo database '$DEMO_DB' is ready (empty)"
echo "    Next: start the API, then run scripts/seed_demo.py"
