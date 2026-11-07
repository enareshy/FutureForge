#!/usr/bin/env bash
# Verify the least-privilege PostgreSQL roles against a provisioned database.
#
# Requires one DSN per role. The suite connects as the real roles and checks
# ownership, role attributes, tenant isolation, and the system-access boundary.
# Passwords are read from the DSNs and are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

required=(
  AI_ROLE_API_DSN
  AI_ROLE_WORKER_DSN
  AI_ROLE_BACKUP_DSN
  AI_ROLE_RESTORE_DSN
  AI_ROLE_MIGRATE_DSN
)
missing=()
for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done
if [ "${#missing[@]}" -ne 0 ]; then
  echo "missing required environment: ${missing[*]}" >&2
  echo "export AI_TEST_ROLE_DB=1 and one DSN per role" >&2
  exit 2
fi
# Fail closed: in this script a missing DSN must never look like a pass.
export AI_TEST_ROLE_DB=1
export AI_REQUIRE_ROLE_DB=1

cd "$ROOT/apps/ai-api"
exec python3 -m pytest -o addopts="" tests/test_db_roles.py "$@"
