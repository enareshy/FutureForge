#!/usr/bin/env bash
# Apply versioned SQL migrations to the shared PostgreSQL instance.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${POSTGRES_HOST:=127.0.0.1}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DB:=helix}"
: "${POSTGRES_USER:=helix}"
: "${POSTGRES_PASSWORD:=}"
: "${AI_DB_SCHEMA:=ai}"
# Prefer a dedicated non-owner migration login. When provisioned, it is a
# member of ai_owner but has no direct DDL or table access.
: "${AI_MIGRATION_DB_USER:=${POSTGRES_USER}}"
: "${AI_MIGRATION_DB_PASSWORD:=${POSTGRES_PASSWORD}}"
: "${AI_DB_ROLE_PROFILE:=}"
: "${AI_MIGRATION_ROLE:=}"
: "${AI_MIGRATION_STOP_AFTER:=}"

if [ "$AI_DB_ROLE_PROFILE" = "migrate" ]; then
  : "${AI_MIGRATION_ROLE:=ai_owner}"
fi
case "$AI_MIGRATION_ROLE" in
  ""|ai_owner) ;;
  *)
    echo "refusing unsafe AI_MIGRATION_ROLE='$AI_MIGRATION_ROLE'" >&2
    exit 1
    ;;
esac

if [ -n "$AI_MIGRATION_DB_PASSWORD" ]; then
  export PGPASSWORD="$AI_MIGRATION_DB_PASSWORD"
fi
# Migrations run inside the trusted owner boundary. Data backfills in versioned
# migrations must not be silently filtered by tenant RLS; application and
# worker sessions never receive these options.
export PGOPTIONS="${PGOPTIONS:-} -c ai.system_access=on"
if [ -n "$AI_MIGRATION_ROLE" ]; then
  export PGOPTIONS="$PGOPTIONS -c role=$AI_MIGRATION_ROLE"
fi
# -w: never prompt; missing credentials fail instead of hanging a deploy.
PSQL=(psql -w -v ON_ERROR_STOP=1 -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$AI_MIGRATION_DB_USER" -d "$POSTGRES_DB")

"${PSQL[@]}" -q \
  -c "CREATE SCHEMA IF NOT EXISTS ${AI_DB_SCHEMA};" \
  -c "CREATE TABLE IF NOT EXISTS ${AI_DB_SCHEMA}.schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text NOT NULL,
        description text);"

applied=0
for f in "$ROOT"/migrations/*.sql; do
  [ -e "$f" ] || continue
  version="$(basename "$f")"
  if [ -n "$AI_MIGRATION_STOP_AFTER" ] && [ "$version" != "$AI_MIGRATION_STOP_AFTER" ] \
    && [ "$(printf '%s\n%s\n' "$AI_MIGRATION_STOP_AFTER" "$version" | sort | head -n1)" = "$AI_MIGRATION_STOP_AFTER" ]; then
    echo "stop  after ${AI_MIGRATION_STOP_AFTER} (fresh-install provisioning window)"
    break
  fi
  if [ "$("${PSQL[@]}" -tAc "SELECT 1 FROM ${AI_DB_SCHEMA}.schema_migrations WHERE version = '${version}'")" = "1" ]; then
    echo "skip  ${version}"
    continue
  fi
  echo "apply ${version}"
  "${PSQL[@]}" -q --single-transaction -f "$f"
  checksum="$(sha256sum "$f" | awk '{print $1}')"
  "${PSQL[@]}" -q -c "INSERT INTO ${AI_DB_SCHEMA}.schema_migrations(version, checksum) VALUES ('${version}', '${checksum}')"
  applied=$((applied + 1))
done

echo "migrations applied: ${applied}"
