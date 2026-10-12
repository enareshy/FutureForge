#!/usr/bin/env bash
# Stop the local development stack. Named volumes (persistent data) are
# preserved unless --volumes is passed explicitly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker compose --env-file .env down "$@"
