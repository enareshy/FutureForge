#!/usr/bin/env bash
# Validate the Prometheus and Alertmanager configuration files with the upstream
# tools, working around container-only paths.
#
# `prometheus.yml` and `prometheus-kubernetes.yml` reference rule/token files by
# their in-container absolute paths (`/etc/prometheus/...`), which do not exist
# on a CI checkout. Running `promtool check config` directly therefore fails on
# a clean tree even though the config is correct. This script stages a copy of
# each config with the paths rewritten to a temporary directory, then lets
# promtool/amtool resolve them.
#
# Requires `promtool` and `amtool` on PATH (CI installs them; see the
# monitoring-configs job). Prometheus and Alertmanager versions must match the
# image tags in compose.yaml / infrastructure/kubernetes/monitoring.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROM_DIR="$ROOT/infrastructure/monitoring/prometheus"

for binary in promtool amtool; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "$binary is required but was not found on PATH" >&2
    exit 1
  fi
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/rules" "$STAGE/metrics"
cp "$PROM_DIR/backup-alerts.yml" "$STAGE/rules/backup-alerts.yml"
# Placeholder token: promtool only checks that the file exists and is readable.
printf 'ci-placeholder-token\n' > "$STAGE/metrics/metrics-token"

stage_config() {
  local source="$1" target="$2"
  sed \
    -e "s#/etc/prometheus/backup-alerts.yml#$STAGE/rules/backup-alerts.yml#g" \
    -e "s#/etc/prometheus/rules/backup-alerts.yml#$STAGE/rules/backup-alerts.yml#g" \
    -e "s#/etc/prometheus/metrics/metrics-token#$STAGE/metrics/metrics-token#g" \
    -e "s#/etc/prometheus/metrics-token#$STAGE/metrics/metrics-token#g" \
    "$source" > "$target"
}

echo "== promtool check rules =="
promtool check rules "$PROM_DIR/backup-alerts.yml"

for config in prometheus.yml prometheus-kubernetes.yml; do
  echo "== promtool check config: $config =="
  stage_config "$PROM_DIR/$config" "$STAGE/$config"
  promtool check config "$STAGE/$config"
done

echo "== amtool check-config =="
amtool check-config "$PROM_DIR/alertmanager.yml"

echo "Prometheus/Alertmanager configs OK"
