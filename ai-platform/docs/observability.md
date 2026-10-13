# Observability

Metrics, traces and structured logs for the AI platform. The implementation
details are in `PHASE12_OBSERVABILITY.md`; this is the operations-facing
summary.

## Signals

| Signal | Where | Notes |
| --- | --- | --- |
| Metrics | `GET /metrics` (Prometheus exposition) | Always on; excluded from HTTP metrics/logs. |
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
- `ai_tool_calls_total{tool,outcome}`, `ai_tool_call_duration_seconds`
- `ai_events_published_total{event_type}`, `ai_events_consumed_total{consumer_group,outcome}`
- `ai_index_jobs_total{status}`

HTTP labels use the matched route template (never the raw path), and every other
label is a bounded enum — cardinality is controlled.

## Tracing

Manual spans cover `model.chat`, `model.chat.stream`, `model.embed`,
`ai.retrieval.search`, `ai.rag.query` and `ai.agent.tool`; the FastAPI
instrumentor provides the server span. Export is a no-op when disabled.

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
`infrastructure/monitoring/prometheus/prometheus.yml`.

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

## Run the stack

```bash
docker compose --profile observability up -d
curl -s localhost:8000/metrics | head
curl -s localhost:8000/readyz
```
