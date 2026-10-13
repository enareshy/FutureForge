#!/usr/bin/env bash
# Create/refresh the `ai-migrations` ConfigMap from the versioned SQL files.
#
# The migration Job mounts this ConfigMap at /migrations. Run this before
# applying the Kubernetes base/overlay so the Job has the SQL it needs.
#
# Usage:
#   AI_NAMESPACE=enterprise-ai ./scripts/k8s-migrations-configmap.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAMESPACE="${AI_NAMESPACE:-enterprise-ai}"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required but was not found on PATH" >&2
  exit 1
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

kubectl -n "$NAMESPACE" create configmap ai-migrations \
  --from-file="$ROOT/migrations/" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "ai-migrations ConfigMap refreshed in namespace '$NAMESPACE'"
