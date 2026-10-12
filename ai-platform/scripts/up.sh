#!/usr/bin/env bash
# Bring up the local development stack.
#
# Lean profile (default):
#   ./scripts/up.sh
# Extra Compose profiles (comma separated):
#   PROFILES=observability ./scripts/up.sh
#   PROFILES=search,events   ./scripts/up.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ -f .env ] || cp .env.example .env

"$ROOT/scripts/docker-daemon.sh"

args=()
if [ -n "${PROFILES:-}" ]; then
  IFS=',' read -ra list <<<"${PROFILES}"
  for p in "${list[@]}"; do
    [ -n "$p" ] && args+=(--profile "$p")
  done
fi

docker compose --env-file .env "${args[@]}" up -d "$@"
docker compose --env-file .env ps
