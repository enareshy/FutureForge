#!/usr/bin/env bash
# Create/refresh the ConfigMaps and Secret consumed by the in-cluster
# monitoring stack (infrastructure/kubernetes/monitoring).
#
# The canonical files stay in infrastructure/monitoring/prometheus/; this script
# turns them into cluster objects, mirroring scripts/k8s-migrations-configmap.sh.
#
# Usage:
#   AI_NAMESPACE=observability ./scripts/k8s-monitoring-config.sh
#
# Preconditions:
#   * `ai-api-secrets` already exists in the AI platform namespace; the metrics
#     bearer token is copied from it so Prometheus scrapes with the same value
#     the API and workers validate.
#
# The token is never printed. It is copied server-side into a Secret in the
# observability namespace.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AI_NAMESPACE="${AI_NAMESPACE:-enterprise-ai}"
OBS_NAMESPACE="${OBS_NAMESPACE:-observability}"
PROM_DIR="$ROOT/infrastructure/monitoring/prometheus"

for binary in kubectl; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "$binary is required but was not found on PATH" >&2
    exit 1
  fi
done

for file in prometheus-kubernetes.yml backup-alerts.yml alertmanager.yml; do
  if [ ! -f "$PROM_DIR/$file" ]; then
    echo "missing $PROM_DIR/$file" >&2
    exit 1
  fi
done

kubectl create namespace "$OBS_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

kubectl -n "$OBS_NAMESPACE" create configmap ai-prometheus-config \
  --from-file=prometheus.yml="$PROM_DIR/prometheus-kubernetes.yml" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$OBS_NAMESPACE" create configmap ai-prometheus-rules \
  --from-file=backup-alerts.yml="$PROM_DIR/backup-alerts.yml" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$OBS_NAMESPACE" create configmap ai-alertmanager-config \
  --from-file=alertmanager.yml="$PROM_DIR/alertmanager.yml" \
  --dry-run=client -o yaml | kubectl apply -f -

TOKEN_B64="$(kubectl -n "$AI_NAMESPACE" get secret ai-api-secrets \
  -o jsonpath='{.data.AI_METRICS_AUTH_TOKEN}')"
if [ -z "$TOKEN_B64" ]; then
  echo "ai-api-secrets has no AI_METRICS_AUTH_TOKEN; refusing to create an empty scrape token" >&2
  exit 1
fi

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: ai-metrics-token
  namespace: $OBS_NAMESPACE
  labels:
    app.kubernetes.io/name: prometheus
    app.kubernetes.io/part-of: enterprise-ai-platform
type: Opaque
data:
  token: $TOKEN_B64
EOF

echo "monitoring config refreshed in namespace '$OBS_NAMESPACE'"
