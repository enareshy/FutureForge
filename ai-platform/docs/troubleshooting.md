# Troubleshooting

Symptom → likely cause → fix. Commands assume the local stack (`make`) unless
noted; on Kubernetes, prefix with `kubectl -n enterprise-ai`.

## Startup

**`GET /readyz` returns 503 with `database: error`**
PostgreSQL is unreachable or the `ai` schema is missing.
- Check connectivity: `psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'select 1'`.
- Apply migrations: `make migrate` (or the `ai-db-migrate` Job).
- Confirm pgvector: `SELECT extversion FROM pg_extension WHERE extname='vector';`.

**The container exits immediately / `CreateContainerConfigError`**
A referenced ConfigMap or Secret is missing.
- `ConfigMap ai-api-config` must exist; `Secret ai-api-secrets` must exist
  (the example Secret is a placeholder — create a real one).

**`permission denied` writing during startup**
The runtime filesystem is read-only. Mount an `emptyDir` at `/tmp` (and, for
nginx, `/var/cache/nginx` and `/var/run`). The shipped manifests already do.

## AI API

**`/api/v1/ai/*` returns 401/403**
The enterprise session token is missing, expired, or the principal lacks the
required `ai.*` permission.
- Sign in again through the enterprise console; confirm the token status is
  `active`.
- Check the route's permission mapping in `security/permissions.py` and the
  principal's effective permissions.

**Chat returns `502 provider_error`**
The configured LLM provider failed after retries (or the circuit breaker is
open). If `LLM_PROVIDER=mock` this should not happen — check logs. For a real
provider, verify `LLM_API_KEY`/`LLM_BASE_URL` and the provider status.

**Every answer says "insufficient evidence"**
Retrieval found nothing above `AI_RAG_MIN_SCORE`, or nothing the principal is
authorized to see.
- Confirm documents were ingested and indexed (`ai.indexing_jobs`).
- Confirm the principal has access to the source (ACL is enforced before
  retrieval; an unauthorized document is never returned, by design).
- Lower `AI_RAG_MIN_SCORE` only after confirming relevance is genuinely low.

**Streaming chat never completes**
A proxy is buffering the SSE stream. Set `proxy_buffering off` and a long
`proxy_read_timeout` (the shipped nginx/ingress config does this), or raise the
client timeout.

## Ingestion and indexing

**A document is stuck `pending`**
No indexer is running.
- Inline: ensure `AI_INGEST_INLINE=true` (default in dev).
- Worker: `python -m ai_api.workers.indexer --watch`.
- Inspect `ai.indexing_jobs` status, attempts and last error.

**`ai.indexing_jobs` dead-lettered**
Repeated failures (unreadable file, embedding error). Check `last_error`,
correct the cause, then replay via the API (`POST /knowledge/index` for the
document or the events replay endpoint if event-driven).

## Events

**Events pile up unprocessed**
The consumer is not running or Kafka is unreachable.
- `EVENT_BUS_PROVIDER=database` (default) needs only the database; ensure the
  `event_consumer` worker runs: `python -m ai_api.workers.event_consumer --watch`.
- Check dead letters: `GET /api/v1/ai/events/dead-letters`.

## ML

**`/ml/status` reports `local` instead of `mlflow`**
`ML_TRACKING_BACKEND=auto` and MLflow is unreachable, so the platform fell back
to local metadata-only tracking. Start MLflow or set
`ML_TRACKING_BACKEND=mlflow` to fail loudly instead. This is expected and
honest degradation, not an error.

## Observability

**`/metrics` has no `ai_*` series yet**
Metrics appear after the first matching call. Note that `/metrics`, `/healthz`
and `/readyz` are intentionally excluded from HTTP metrics.

**Traces are missing**
`OTEL_ENABLED=false` by default. Set it to `true` and confirm the collector
endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`). Tracing is fail-open — a broken
collector never fails a request.

## Kubernetes

**Pods `Pending` with `Insufficient cpu/memory`**
The resource requests exceed node capacity. Tune
`overlays/production/ai-api-resources-patch.yaml` or add nodes.

**Pods blocked by `default-deny` NetworkPolicy**
Outbound calls to backing services fail because the service namespace is not
allowed. Add the namespace to
`base/networkpolicy.yaml` (`allow-ai-api-egress-backends`) matching its
`kubernetes.io/metadata.name` label.

**Ingress returns 502**
The `web` Service has no ready endpoints (console not Ready) or its
`AI_API_UPSTREAM` is wrong. Check `kubectl get endpoints web` and the console
logs.

## Live verification & environment blockers

This section is the sign-off record for the Definition of Done. It distinguishes
what was **verified live in this environment** from what is **deliberately not
run here** (and why), so an unmet item is never mistaken for a silent failure.

Verified live on `postgres` @ `be377b6` (2 vCPU / low RAM host):

| Definition-of-Done item | Result | Evidence |
|---|---|---|
| PostgreSQL + pgvector migrations | Pass | `0001`–`0007` applied; `/readyz` 503-on-failure |
| pgvector retrieval roundtrip | Pass | `test_postgres_pgvector_roundtrip` (`AI_TEST_POSTGRES=1`) |
| Redis reachability | Pass | `test_redis_reachable` (`AI_TEST_REDIS=1`) |
| Object storage reachability | Pass | `test_object_storage_reachable` (`AI_TEST_OBJECTSTORAGE=1`) |
| MLflow records an experiment | Pass | server healthy; experiment created; `test_mlflow_reachable` (`AI_TEST_MLFLOW=1`) |
| LLM gateway with labeled mock | Pass | mock provider; streaming + citations tested |
| RAG ingestion → search → cited answer | Pass | hermetic + backend suites |
| React console ↔ FastAPI | Pass | Vite proxy `/api/v1/ai` → API; live `/healthz` 200 |
| Prometheus scrapes the API | Pass | target `up`, 32 `ai_*` series |
| Automated tests | Pass | 134 backend passed / 14 skipped; 23 frontend passed; `ruff` clean |

Not run here — all **profile-gated for RAM (~1 GiB each)**, not defects. Enable
one at a time on a larger host and re-run the matching opt-in test:

```bash
# OpenSearch indexing/search (needs ~2 GiB)
docker compose --profile search up -d
AI_TEST_OPENSEARCH=1 pytest -m integration tests/test_integration_services.py
```

```bash
# Kafka background processing (needs ~1 GiB; also pip install aiokafka)
docker compose --profile events up -d
EVENT_BUS_PROVIDER=kafka AI_TEST_KAFKA=1 pytest -m integration tests/test_integration_services.py
```

```bash
# OTel collector + Prometheus + Grafana
docker compose --profile observability up -d
AI_TEST_OTEL=1 pytest -m integration tests/test_integration_services.py
```

```bash
# Langfuse LLM tracing (needs >= 4 GiB RAM)
docker compose --profile llmops up -d
```

```bash
# Real LLM provider (requires your own provider credentials)
AI_TEST_LIVE_LLM=1 pytest -m integration tests/test_integration_services.py
```

The event bus degrades to the durable database outbox (`EVENT_BUS_PROVIDER=database`,
the default) when Kafka is absent — features keep working; only the Kafka
transport is unverified. MLflow falls back to local metadata-only tracking when
unreachable. Neither fallback is an error.
