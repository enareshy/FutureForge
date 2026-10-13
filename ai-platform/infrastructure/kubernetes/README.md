# Kubernetes deployment

Production target for the Enterprise AI Platform. Docker Compose remains the
local-development stack; these manifests target a customer-managed Kubernetes
cluster (any CNI and ingress that support `NetworkPolicy` and `Ingress`).

## Layout

```text
infrastructure/kubernetes/
├── base/                       # environment-agnostic manifests
│   ├── namespace.yaml          # enterprise-ai (restricted pod security)
│   ├── serviceaccount.yaml
│   ├── configmap.yaml          # non-secret env
│   ├── secret.example.yaml     # placeholder — replace with a real Secret
│   ├── ai-api-deployment.yaml  # non-root, probes, resources, read-only rootfs
│   ├── ai-api-service.yaml
│   ├── ai-api-hpa.yaml         # CPU autoscaling 2..6
│   ├── ai-api-pdb.yaml
│   ├── web-deployment.yaml     # unprivileged nginx console
│   ├── web-service.yaml
│   ├── migration-job.yaml      # applies migrations/*.sql
│   ├── ingress.yaml            # TLS + SSE-friendly timeouts
│   └── networkpolicy.yaml      # default-deny + least-privilege allow rules
└── overlays/production/        # image tags, replica counts, resources
```

## What is exposed

Only the console (`web` Service) is published through the Ingress. The AI API,
PostgreSQL/pgvector, Redis, object storage, OpenSearch, Kafka, MLflow and all
monitoring consoles stay cluster-internal and are reached by operators with
`kubectl port-forward`.

## Deploy (outline)

```bash
# 1. Real secret (never apply secret.example.yaml in production).
kubectl -n enterprise-ai create secret generic ai-api-secrets \
  --from-literal=POSTGRES_PASSWORD='...' \
  --from-literal=LLM_API_KEY='...'

# 2. Migration SQL ConfigMap.
AI_NAMESPACE=enterprise-ai ./scripts/k8s-migrations-configmap.sh

# 3. Apply the overlay.
kubectl apply -k infrastructure/kubernetes/overlays/production

# 4. Run the migration Job and watch it finish.
kubectl -n enterprise-ai delete job ai-db-migrate --ignore-not-found
kubectl apply -k infrastructure/kubernetes/overlays/production
kubectl -n enterprise-ai wait --for=condition=complete job/ai-db-migrate --timeout=180s
```

Full procedures — rollback, backup/restore, disaster recovery — are in
`docs/deployment.md` and `docs/backup-recovery.md`.

## Validation

Both the `base` and `overlays/production` kustomizations render cleanly and
pass upstream schema validation. Verified with `kubectl kustomize` and
kubeconform v0.6.7 — **17/17 resources valid** for each:

```bash
kubectl kustomize infrastructure/kubernetes/overlays/production \
  | kubeconform -strict -ignore-missing-schemas -summary -
```

`scripts/validate-k8s.py` provides an additional dependency-free structural
check (probes, resources, non-root, NetworkPolicy/Ingress shape) for
environments without `kubectl`/`kubeconform`. Both run in CI. A server-side
`--dry-run=server` and an actual apply still require a real cluster.
