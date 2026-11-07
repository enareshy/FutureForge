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

# Prometheus reads the scrape token from a git-ignored file. Without it Docker
# creates an empty directory in its place and every scrape fails with
# "unable to read authorization credentials", so bootstrap it from .env.
token_file="$ROOT/infrastructure/monitoring/prometheus/local-metrics-token"
if [[ ",${PROFILES:-}," == *",observability,"* ]] && [ ! -f "$token_file" ]; then
  token="$(sed -n 's/^AI_METRICS_AUTH_TOKEN=//p' .env | tail -n 1 | tr -d '\r')"
  token="${token%\"}"; token="${token#\"}"
  token="${token%\'}"; token="${token#\'}"
  if [ -z "$token" ]; then
    echo "observability profile needs AI_METRICS_AUTH_TOKEN in .env (empty value found)" >&2
    exit 1
  fi
  printf '%s\n' "$token" > "$token_file"
  chmod 600 "$token_file"
fi

docker compose --env-file .env "${args[@]}" up -d "$@"
docker compose --env-file .env ps
