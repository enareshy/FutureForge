# Observability

Metrics, traces and structured logs for the AI platform. The implementation
details are in `PHASE12_OBSERVABILITY.md`; this is the operations-facing
summary.

## Signals

| Signal | Where | Notes |
| --- | --- | --- |
| Metrics | `GET /metrics` (Prometheus exposition) | Bearer token required; excluded from HTTP metrics/logs. |
| Traces | OpenTelemetry → collector | Off by default (`OTEL_ENABLED=false`); fail-open. |
| Generation traces | Langfuse ingestion API | Optional; off unless host + keys set; fail-open. |
| Logs | stdout (JSON in production) | Correlated by request/tenant/user id. |
| Probes | `/healthz`, `/readyz` | Liveness / readiness. |

## Metrics

Key series (all `ai_`-prefixed, bounded labels):

- `ai_http_requests_total{method,path,status}`, `ai_http_request_duration_seconds`
- `ai_model_calls_total{operation,provider,model,outcome}`, `…_duration_seconds`,
  `ai_model_tokens_total{kind}`, `ai_model_cost_usd_total`
- `ai_retrieval_calls_total{operation,outcome}`, `…_duration_seconds`,
  `ai_retrieval_results`
- `ai_citation_validations_total{operation,status}` (`status` is
  `valid`/`missing`/`invalid`/`not_required`)
- `ai_tool_calls_total{tool,outcome}`, `ai_tool_call_duration_seconds`
- `ai_events_published_total{event_type}`, `ai_events_consumed_total{consumer_group,outcome}`
- `ai_events_publish_failed_total{event_type}`
- `ai_event_delivery_backlog{state="pending|delayed|dead"}`
- `ai_rls_context_missing_total{operation}` and
  `ai_rls_denied_total{operation}`: database tenant-context failures and
  row-level-security denials (bounded operation labels, no tenant/content data;
  see `docs/tenant-isolation.md`)
- `ai_index_jobs_total{status}`, `ai_index_jobs_current{status}`
- `ai_security_refresh_overdue`
- `ai_index_reconcile_runs_total{outcome}`
- `ai_backup_last_run_status{kind}`, `ai_backup_last_success_timestamp_seconds{kind}`,
  `ai_backup_last_duration_seconds{kind}`, `ai_backup_last_artifact_size_bytes{kind}`,
  `ai_backup_last_integrity_ok{kind}`, `ai_backup_last_encrypted{kind}`
  (`kind` is `backup` or `restore_drill`; values are read from
  `ai.backup_runs` at scrape time)

HTTP labels use the matched route template (never the raw path), and every other
label is a bounded enum — cardinality is controlled.

## Tracing

Manual spans cover `model.chat`, `model.chat.stream`, `model.embed`,
`ai.retrieval.search`, `ai.rag.query`, `ai.search.duplicate_scan`,
`ai.index.reconcile` and `ai.agent.tool`; the FastAPI instrumentor provides the
server span. Export is a no-op when disabled.

## Logs

Structured logs carry `request_id` (assigned/echoed from `x-request-id`), and —
for authenticated requests — `tenant_id`, `user_id` and `auth_source`. Secrets,
tokens, prompts and document bodies are never logged; identifiers are recorded
as bounded references.

## Dashboards

Grafana is provisioned from
`infrastructure/monitoring/grafana/provisioning/dashboards/`:

- `ai-platform-overview.json` — HTTP rate/latency, model calls/latency, tokens,
  cost, retrieval, tool executions, event processing, indexing jobs.

Prometheus scrapes the OTel collector (`otel-collector:8889`) and the AI API
directly (`ai-api:8000/metrics`) per
`infrastructure/monitoring/prometheus/prometheus.yml`. The AI API and worker
jobs authenticate with `Authorization: Bearer <AI_METRICS_AUTH_TOKEN>`; the
Compose stack reads `infrastructure/monitoring/prometheus/local-metrics-token`.
Kubernetes scrape configuration must supply the same token from
`ai-api-secrets`.

## Backup and restore signals

Backup metrics are derived from `ai.backup_runs` (migration 0017) and refreshed
by `GET /metrics`. Labels are limited to `kind`; artifacts, tenants, database
names, and secrets are never labels. The API tolerates a metrics refresh failure
by logging a warning and serving the last known values rather than failing the
scrape.

`infrastructure/monitoring/prometheus/backup-alerts.yml` is loaded by
`prometheus.yml` and contains:

- `AIBackupFailed` — latest backup status is failed.
- `AIBackupStale` — no successful backup for 36 hours.
- `AIBackupIntegrityFailed` — latest successful artifact failed integrity checks.
- `AIBackupUnencrypted` — a successful backup was stored unencrypted.
- `AIRestoreDrillStale` — no successful restore drill for 90 days.

The rules are statically valid (`promtool check rules`: 5 rules), and the
Kubernetes stack in `infrastructure/kubernetes/monitoring/` now deploys a
Prometheus and an Alertmanager that load them. Two limits remain and both are
**OPEN** in the gate report:

- **No notification integration.** `alertmanager.yml` ships a single
  `unconfigured` receiver so the config is valid but delivers nothing. Alerts
  are visible in the Alertmanager UI; no human is paged until an operator adds a
  real receiver and captures a receipt (`docs/kubernetes-rollout.md` 8.2).
- **The monitoring stack is not applied by the production overlay.** It is an
  opt-in kustomization with its own PVC, because retention and the receiver are
  operator decisions. Nothing proves a live scrape or a live alert until
  Section 8 is executed.

The scrape side is wired: `worker-services.yaml` gives each worker a stable
`:9100` endpoint, `prometheus-kubernetes.yml` targets them by DNS with the bearer
token, and `allow-metrics-scrape` admits only the `observability` namespace.
`validate-monitoring.py` enforces that every scrape target has a Service. The
Compose `prometheus.yml` remains the local stack and keeps its static
host-gateway targets.

## Workers

Background workers expose the same registry on a port of their choice:

```bash
python -m ai_api.workers.event_consumer --watch --metrics-port 9101
python -m ai_api.workers.indexer --watch --metrics-port 9102
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTEL_ENABLED` | false | Export traces to the collector. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | http://127.0.0.1:4317 | OTLP gRPC endpoint. |
| `OTEL_SERVICE_NAME` | ai-api | Service name. |
| `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | — | Enable Langfuse generation tracing. |
| `AI_METRICS_AUTH_TOKEN` | empty | Bearer token for API/worker `/metrics`; empty returns 503. Production/staging require >= 32 characters. |

## Run the stack

```bash
docker compose --profile observability up -d
curl -s -H "Authorization: Bearer $AI_METRICS_AUTH_TOKEN" localhost:8000/metrics | head
curl -s localhost:8000/readyz
```

## Config validation

The monitoring artifacts are validated in CI (`.github/workflows/ai-platform-ci.yml`):
`scripts/check-prometheus-configs.sh` runs `promtool check rules`,
`promtool check config` on both the Compose and Kubernetes scrape configs, and
`amtool check-config`; `scripts/validate-monitoring.py` checks the alerting
structure and worker-target/Service agreement; `otelcol validate` checks the
collector config; and YAML/JSON parsing covers the Grafana provisioning and
dashboard.

`prometheus.yml` references rule and token files by their container paths
(`/etc/prometheus/...`), so checking it directly on a checkout fails with
"does not point to an existing file". The script stages a copy with those paths
rewritten to a temp directory, which is why CI calls the script instead of
`promtool` directly. Run the same checks locally:

```bash
PATH="/path/to/promtool-dir:/path/to/amtool-dir:$PATH" \
  bash scripts/check-prometheus-configs.sh
python3 scripts/validate-monitoring.py
docker run --rm -v "$PWD/infrastructure/monitoring/otel/otel-collector-config.yaml:/etc/otel/config.yaml" \
  otel/opentelemetry-collector-contrib:0.162.0 validate --config=/etc/otel/config.yaml
```

The unauthenticated scrape path was previously verified live against the
running API: Prometheus scraped `/metrics` (target `up`, 32 `ai_*` series).
Since Batch G the endpoint requires the bearer token; the token-aware
Prometheus jobs are configured but were not re-run against a live Prometheus in
this environment. In the compose dev stack the API runs on the host, so the
`ai-api` job targets `host.docker.internal:8000`
(the `prometheus` service declares a `host-gateway` mapping); in Kubernetes,
point the target at the in-cluster Service or use a ServiceMonitor.
