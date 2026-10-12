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

export PGPASSWORD="$POSTGRES_PASSWORD"
PSQL=(psql -v ON_ERROR_STOP=1 -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB")

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
