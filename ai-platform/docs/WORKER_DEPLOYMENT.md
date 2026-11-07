# Reliability worker deployment

The API queues durable work; dedicated workers execute it. This document covers
the four Stage 1-6 workers, their deployment model, health, metrics and
operational limits.

## Workloads

| Deployment | Module | Replicas | Grace | Coordination |
| --- | --- | --- | --- | --- |
| `ai-event-consumer` | `ai_api.workers.event_consumer --watch` | 1 | 60s | Per-`(event, group)` delivery rows; no atomic claim, so one consumer only |
| `ai-reconciler` | `ai_api.workers.reconciler --watch` | 1 | 300s | No global lease yet; single replica, `purge_orphans=false` |
| `ai-indexer` | `ai_api.workers.indexer --watch` | 1 | 300s | Job lease exists, but queued selection is not atomic; one indexer only |
| `ai-agent-worker` | `ai_api.workers.agent --watch` | 1 | 300s | `FOR UPDATE SKIP LOCKED` claim + lease/generation fencing; safe to scale after verification |

All run the `enterprise-ai-platform/ai-api` image with an explicit module
command. Starting a worker never starts the HTTP API or its lifespan hooks.
Migrations are a separate `Job` (`ai-db-migrate`) and must complete first.

`AI_INGEST_INLINE=false` in the base ConfigMap, so the API does not execute
index jobs inside request handling. The indexer owns that queue.

## Prerequisites

1. `ai-db-migrate` completed (`ai.schema_migrations` includes every migration).
2. `ai-api-config` and the real `ai-api-secrets` exist in the namespace.
3. PostgreSQL, object storage, and the configured search backend are reachable.
   Kafka is only needed when `EVENT_BUS_PROVIDER=kafka`.
4. The release image tag is pinned in the production overlay.

## Kubernetes

```bash
# Migrations ConfigMap and the effective overlay.
AI_NAMESPACE=enterprise-ai ./scripts/k8s-migrations-configmap.sh
kubectl apply -k infrastructure/kubernetes/overlays/production

# Migrations must finish before workers process anything.
kubectl -n enterprise-ai delete job ai-db-migrate --ignore-not-found
kubectl apply -k infrastructure/kubernetes/overlays/production
kubectl -n enterprise-ai wait --for=condition=complete job/ai-db-migrate --timeout=180s

for d in ai-event-consumer ai-reconciler ai-indexer ai-agent-worker; do
  kubectl -n enterprise-ai rollout status "deploy/$d" --timeout=180s
done
```

Verify:

```bash
kubectl -n enterprise-ai get deploy -l app.kubernetes.io/component=worker
kubectl -n enterprise-ai get pods -l app.kubernetes.io/component=worker
kubectl -n enterprise-ai logs deploy/ai-event-consumer --tail=50
kubectl -n enterprise-ai logs deploy/ai-indexer --tail=50
```

Probe a worker locally through the API-free health port:

```bash
kubectl -n enterprise-ai port-forward deploy/ai-indexer 9103:9100
curl -s localhost:9103/healthz
curl -s localhost:9103/readyz
curl -s -H "Authorization: Bearer $AI_METRICS_AUTH_TOKEN" localhost:9103/metrics | grep '^ai_worker_'
```

`/readyz` returns 503 until the first cycle succeeds and whenever the last
success is older than the worker's staleness window (the indexer window accounts
for a full batch of timed-out jobs), so it is not a dummy
process check. `/healthz` only reports that the process is alive; inactivity is
surfaced by readiness and the last-success metric.

Render and validate without a cluster:

```bash
kustomize build infrastructure/kubernetes/base > /tmp/workers-base.yaml
kustomize build infrastructure/kubernetes/overlays/production > /tmp/workers-prod.yaml
kubeconform -strict -ignore-missing-schemas -summary /tmp/workers-base.yaml /tmp/workers-prod.yaml
python scripts/validate-k8s.py
```

## Docker Compose (local)

The host PostgreSQL instance is reached at `host.docker.internal`; the defaults
match `compose.yaml`.

```bash
# Backing services.
docker compose up -d redis objectstore

# Build and start the workers.
docker compose --profile workers up -d --build event-consumer reconciler indexer agent

docker compose --profile workers ps
curl -s localhost:9101/readyz   # event consumer
curl -s localhost:9102/readyz   # reconciler
curl -s localhost:9103/readyz   # indexer
curl -s localhost:9104/readyz   # agent
docker compose --profile workers logs -f event-consumer
```

Run the host API with `AI_INGEST_INLINE=false` while these workers are up,
otherwise the API and the indexer can both process the same queued job.

Override `POSTGRES_HOST`, `WORKER_POSTGRES_USER`,
`WORKER_POSTGRES_PASSWORD`, `LLM_*`, `S3_*` or `SEARCH_PROVIDER` through the
environment or `.env`. Compose defaults workers to the `ai_worker` role and
`AI_DB_ROLE_PROFILE=worker`; provision it first (see
`infrastructure/db/roles/README.md`). Compose is a development aid; it does not
prove Kubernetes production behaviour.

## Configuration

Worker settings live in the existing ConfigMap/Secret; no worker-specific secret
is introduced.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_REPOSITORY` | `postgres` | Workers use the same repository as the API |
| `AI_INGEST_INLINE` | `false` (cluster) | Keep ingestion out of API requests |
| `AI_WORKER_BATCH_SIZE` / `AI_WORKER_POLL_SECONDS` | `10` / `5` | Indexer and agent batches |
| `AI_EVENT_BATCH_SIZE` / `AI_EVENT_POLL_SECONDS` | `20` / `5` | Consumer batch and idle poll |
| `AI_EVENT_MAX_ATTEMPTS` | `5` | Retries before dead-lettering |
| `AI_RECONCILE_INTERVAL_SECONDS` | `300` | Reconciliation cadence |
| `AI_RECONCILE_DRY_RUN` / `AI_RECONCILE_PURGE_ORPHANS` | `false` / `false` | Explicit safety posture |
| `AI_JOB_LEASE_SECONDS` | `300` | Reclaim window after a killed indexer |
| `AI_AGENT_EXECUTION_LEASE_SECONDS` | `120` | Agent lease/reclaim window |

## Observability

Workers expose `/metrics` on port 9100 in Kubernetes (9101-9104 on the Compose
host). Each worker has a ClusterIP Service in `worker-services.yaml` selecting
its pod label on the `metrics` port, and the pods also carry
`prometheus.io/scrape`/`port`/`path` annotations for pod-discovery scrapers. The
`allow-metrics-scrape` NetworkPolicy permits ingress from the observability
namespace only. `/metrics` also requires
`Authorization: Bearer <AI_METRICS_AUTH_TOKEN>`; an empty token returns 503 and a
wrong token returns 401. `/healthz` and `/readyz` stay anonymous for probes. The
token is supplied through `ai-api-secrets` (`envFrom`) to every worker; the
Kubernetes scrape job reads the same value from the `ai-metrics-token` Secret
that `scripts/k8s-monitoring-config.sh` copies, and the Compose Prometheus job
reads `infrastructure/monitoring/prometheus/local-metrics-token`.

| Metric | Meaning |
| --- | --- |
| `ai_worker_last_success_timestamp_seconds{worker}` | Last completed cycle |
| `ai_worker_consecutive_failures{worker}` | Consecutive failed cycles |
| `ai_worker_cycles_total{worker,outcome}` | Cycle outcomes |
| `ai_worker_shutdowns_total{worker}` | Graceful stops |
| `ai_event_delivery_backlog{state}` | Pending/delayed/dead deliveries |
| `ai_event_delivery_oldest_pending_seconds` | Age of the oldest due event |
| `ai_index_jobs_current{status}` | Index queue by status |
| `ai_security_refresh_overdue` | Security refreshes past the staleness window |
| `ai_index_reconcile_runs_total{outcome}` | Reconciliation outcomes |

Suggested alerts (require the opt-in `infrastructure/kubernetes/monitoring/`
stack plus a real receiver; see `docs/kubernetes-rollout.md` Section 8):

```promql
time() - ai_worker_last_success_timestamp_seconds > 600
ai_worker_consecutive_failures > 2
ai_event_delivery_backlog{state="dead"} > 0
ai_event_delivery_oldest_pending_seconds > 300
ai_index_jobs_current{status="queued"} > 100
ai_security_refresh_overdue > 0
```

## Shutdown and failure behaviour

- `SIGTERM` stops the loop after the current batch; the event consumer only marks
  a delivery after the handler returns, so an interrupted handler is redelivered.
- A killed indexer leaves a job leased; `reclaim_stale_jobs` requeues it after
  the lease expires. Indexing is idempotent.
- An agent execution keeps its lease/generation fence; another replica reclaims
  it only after expiry and the old worker cannot commit.
- The reconciler never deletes authoritative rows and only purges search
  entries when `AI_RECONCILE_PURGE_ORPHANS=true`.

## Scaling constraints

Do not raise replicas for `ai-event-consumer`, `ai-reconciler` or `ai-indexer`
until the following are implemented:

- an atomic delivery claim (or advisory lock) for the event outbox;
- a PostgreSQL advisory lock or lease for the reconciler;
- `FOR UPDATE SKIP LOCKED` job selection for the indexer.

The agent worker can be scaled beyond one replica because claims are fenced, but
validate with a real cluster before changing the manifest. No worker HPA is
provided.

## Known gaps

- No live Kubernetes cluster was available, so these manifests are rendered and
  schema-validated but pods were not started here.
- No reconciler scheduler lease (single replica mitigates the race).
- Alertmanager ships with an inert receiver; alert delivery is unverified until
  an operator configures and tests a real integration.
- OpenSearch remains non-default; the deployed `SEARCH_PROVIDER` is `postgres`.
