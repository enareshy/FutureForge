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
│   ├── worker-deployments.yaml # event consumer, reconciler, indexer, agent
│   ├── worker-services.yaml    # :9100 scrape endpoints for the four workers
│   ├── web-deployment.yaml     # unprivileged nginx console
│   ├── web-service.yaml
│   ├── migration-job.yaml      # applies migrations/*.sql
│   ├── backup-cronjob.yaml     # daily encrypted backup (02:15 UTC)
│   ├── restore-drill-cronjob.yaml # monthly isolated drill (06:00 UTC, day 1)
│   ├── restore-secret.example.yaml # separate ai_restore credential
│   ├── ingress.yaml            # TLS + SSE-friendly timeouts
│   └── networkpolicy.yaml      # default-deny + least-privilege allow rules
├── monitoring/                 # opt-in Prometheus + Alertmanager (namespace observability)
└── overlays/production/        # image tags, replica counts, resources
```

## What is exposed

Only the console (`web` Service) is published through the Ingress. The AI API,
the four background workers, PostgreSQL/pgvector, Redis, object storage,
OpenSearch, Kafka, MLflow and all monitoring consoles stay cluster-internal and
are reached by operators with `kubectl port-forward`. Workers expose
`/healthz`, `/readyz` and `/metrics` on port 9100; see
`docs/WORKER_DEPLOYMENT.md` for their replicas, health semantics and scaling
limits.

## Deploy (outline)

```bash
# 1. Provision the non-owner database roles once (superuser, maintenance window).
#    See infrastructure/db/roles/README.md.
psql -v ON_ERROR_STOP=1 -d "$POSTGRES_DB" \
  -f infrastructure/db/roles/provision_roles.sql

# 2. Real secret (never apply secret.example.yaml in production).
kubectl -n enterprise-ai create secret generic ai-api-secrets \
  --from-literal=AI_API_POSTGRES_PASSWORD='...' \
  --from-literal=AI_WORKER_POSTGRES_PASSWORD='...' \
  --from-literal=AI_BACKUP_POSTGRES_PASSWORD='...' \
  --from-literal=AI_MIGRATION_POSTGRES_PASSWORD='...' \
  --from-literal=LLM_API_KEY='...' \
  --from-literal=AI_METRICS_AUTH_TOKEN="$(openssl rand -hex 32)"

# 2b. Separate credential for the monthly drill's isolated target. Kept out of
#     ai-api-secrets so serving pods never get a role that can create databases.
kubectl -n enterprise-ai create secret generic ai-restore-secret \
  --from-literal=password='...'

# 3. Migration SQL ConfigMap.
AI_NAMESPACE=enterprise-ai ./scripts/k8s-migrations-configmap.sh

# 4. Apply the overlay.
kubectl apply -k infrastructure/kubernetes/overlays/production

# 5. Run the migration Job and watch it finish.
kubectl -n enterprise-ai delete job ai-db-migrate --ignore-not-found
kubectl apply -k infrastructure/kubernetes/overlays/production
kubectl -n enterprise-ai wait --for=condition=complete job/ai-db-migrate --timeout=180s

# 6. Verify the roles, then watch the API, console and reliability workers.
bash scripts/verify-db-roles.sh
kubectl -n enterprise-ai rollout status deploy/ai-api
kubectl -n enterprise-ai rollout status deploy/web
for d in ai-event-consumer ai-reconciler ai-indexer ai-agent-worker; do
  kubectl -n enterprise-ai rollout status "deploy/$d"
done
```

Workers must not start processing before the migration Job succeeds. They keep
readiness at 503 until their first successful cycle, so a missing schema or
unreachable dependency is visible rather than reported healthy.

Full procedures — rollback, backup/restore, disaster recovery — are in
`docs/deployment.md` and `docs/backup-recovery.md`.

## Validation

The `base`, `overlays/production` and `monitoring` kustomizations render cleanly
and pass upstream schema validation. Measured on 2026-10-27 with
`kustomize v5.5.0` and `kubeconform v0.6.7`:

```bash
for target in base overlays/production monitoring; do
  kustomize build "infrastructure/kubernetes/$target" > /tmp/render.yaml
  kubeconform -strict -ignore-missing-schemas -summary /tmp/render.yaml
done
```

Expected: `34 resources` valid for base and production, `11 resources` valid for
monitoring, 0 invalid.

```bash
python3 scripts/validate-k8s.py        # 50 documents in 31 files
python3 scripts/validate-monitoring.py # rules, scrape jobs, routes
```

`validate-k8s.py` checks probes, resources, non-root and NetworkPolicy/Ingress
shape. `validate-monitoring.py` checks that every alert has an `expr`/`for`,
severity and annotations, that the scrape config has an `alerting` block and
bearer-protected `ai-api`/`ai-workers` jobs, and that every worker scrape target
matches a Service in `worker-services.yaml`. Both run in CI. A server-side
`--dry-run=server` and an actual apply still require a real cluster.

## Monitoring and drill

`monitoring/` is a separate, opt-in stack. It is not applied by the production
overlay because the operator must size retention and supply a notification
receiver:

```bash
AI_NAMESPACE=enterprise-ai ./scripts/k8s-monitoring-config.sh
kubectl apply -k infrastructure/kubernetes/monitoring
```

The Alertmanager config shipped here has **no working integration**: alerts
appear in its UI but no human is notified until a real receiver is added. See
`docs/kubernetes-rollout.md` Section 8.

`ai-restore-drill` runs monthly and records a `restore_drill` row, which is what
`AIRestoreDrillStale` evaluates. It does not clean up its target database or
bucket; use `backup_restore.py cleanup --execute` after reviewing the report.
