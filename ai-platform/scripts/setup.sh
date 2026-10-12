#!/usr/bin/env bash
# One-shot local environment bootstrap: env file, docker daemon, lean stack,
# database migrations and a health report.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ -f .env ] || cp .env.example .env
echo "[1/4] environment file ready (.env)"

"$ROOT/scripts/docker-daemon.sh"

echo "[2/4] starting lean stack"
"$ROOT/scripts/up.sh"

echo "[3/4] applying migrations"
"$ROOT/scripts/migrate.sh"

echo "[4/4] health"
"$ROOT/scripts/health.sh"
