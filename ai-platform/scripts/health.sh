#!/usr/bin/env bash
# Report the health of the local development dependencies.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

fail=0

echo "== PostgreSQL & pgvector =="
if PGPASSWORD="${POSTGRES_PASSWORD:-helix}" \
    psql -h "${POSTGRES_HOST:-127.0.0.1}" -p "${POSTGRES_PORT:-5432}" \
      -U "${POSTGRES_USER:-helix}" -d "${POSTGRES_DB:-helix}" -tAc \
      "SELECT extversion FROM pg_extension WHERE extname = 'vector';" 2>/dev/null | grep -q .; then
  echo "  pgvector: OK"
else
  echo "  pgvector: MISSING"
  fail=1
fi

echo "== AI schema =="
if PGPASSWORD="${POSTGRES_PASSWORD:-helix}" \
    psql -h "${POSTGRES_HOST:-127.0.0.1}" -p "${POSTGRES_PORT:-5432}" \
      -U "${POSTGRES_USER:-helix}" -d "${POSTGRES_DB:-helix}" -tAc \
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = '${AI_DB_SCHEMA:-ai}';" 2>/dev/null | grep -q 1; then
  echo "  schema '${AI_DB_SCHEMA:-ai}': OK"
else
  echo "  schema '${AI_DB_SCHEMA:-ai}': not created yet (run 'make migrate')"
fi

echo "== Containers =="
if docker info >/dev/null 2>&1; then
  docker compose --env-file .env ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null || true
else
  echo "  docker daemon: not running"
  fail=1
fi

exit "$fail"
