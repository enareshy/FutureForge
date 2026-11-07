"""Prometheus metrics for the AI platform (Phase 12).

A small, dependency-light instrumentation layer on top of `prometheus-client`.
Metrics are exposed via the ``/metrics`` endpoint (see ``main.py``) for scraping
by Prometheus. Cardinality is kept deliberately low: HTTP labels use the matched
route template (not the raw path) and every other label is a bounded enum
(operation, provider, model, outcome, status).

Secrets and unbounded values (prompt text, document content, user-supplied ids)
are never used as labels.
"""

from __future__ import annotations

import re

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    GCCollector,
    Histogram,
    PlatformCollector,
    ProcessCollector,
    generate_latest,
)

REGISTRY = CollectorRegistry(auto_describe=True)
ProcessCollector(registry=REGISTRY)
PlatformCollector(registry=REGISTRY)
GCCollector(registry=REGISTRY)

# --- HTTP -----------------------------------------------------------------
HTTP_REQUESTS = Counter(
    "ai_http_requests_total",
    "HTTP requests handled by the AI API.",
    ["method", "path", "status"],
    registry=REGISTRY,
)
HTTP_DURATION = Histogram(
    "ai_http_request_duration_seconds",
    "HTTP request latency in seconds.",
    ["method", "path"],
    registry=REGISTRY,
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

# --- Model calls (chat / embedding) --------------------------------------
MODEL_CALLS = Counter(
    "ai_model_calls_total",
    "Model gateway calls.",
    ["operation", "provider", "model", "outcome"],
    registry=REGISTRY,
)
MODEL_DURATION = Histogram(
    "ai_model_call_duration_seconds",
    "Model gateway call latency in seconds.",
    ["operation", "provider", "model"],
    registry=REGISTRY,
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0),
)
MODEL_TOKENS = Counter(
    "ai_model_tokens_total",
    "Tokens consumed, by kind (input/output).",
    ["operation", "provider", "model", "kind"],
    registry=REGISTRY,
)
MODEL_COST = Counter(
    "ai_model_cost_usd_total",
    "Estimated model cost in USD (0 when pricing is not configured).",
    ["provider", "model"],
    registry=REGISTRY,
)

# --- Retrieval ------------------------------------------------------------
RETRIEVAL_CALLS = Counter(
    "ai_retrieval_calls_total",
    "Retrieval/RAG operations.",
    ["operation", "outcome"],
    registry=REGISTRY,
)
RETRIEVAL_DURATION = Histogram(
    "ai_retrieval_duration_seconds",
    "Retrieval/RAG latency in seconds.",
    ["operation"],
    registry=REGISTRY,
    buckets=(0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
)
RETRIEVAL_RESULTS = Histogram(
    "ai_retrieval_results",
    "Number of authorized results returned per retrieval.",
    ["operation"],
    registry=REGISTRY,
    buckets=(0, 1, 2, 3, 5, 8, 13, 21, 50),
)

# --- Citation validation --------------------------------------------------
CITATION_VALIDATIONS = Counter(
    "ai_citation_validations_total",
    "Evidence-grounded answers by citation validation outcome.",
    ["operation", "status"],
    registry=REGISTRY,
)

# --- Tools ----------------------------------------------------------------
TOOL_CALLS = Counter(
    "ai_tool_calls_total",
    "Agent tool executions.",
    ["tool", "outcome"],
    registry=REGISTRY,
)
TOOL_DURATION = Histogram(
    "ai_tool_call_duration_seconds",
    "Agent tool execution latency in seconds.",
    ["tool"],
    registry=REGISTRY,
    buckets=(0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
)

# --- Events (publisher + consumer) ---------------------------------------
EVENTS_PUBLISHED = Counter(
    "ai_events_published_total",
    "Events published to the event bus.",
    ["event_type"],
    registry=REGISTRY,
)
EVENTS_PUBLISH_FAILED = Counter(
    "ai_events_publish_failed_total",
    "Event sink publication failures.",
    ["event_type"],
    registry=REGISTRY,
)
EVENTS_CONSUMED = Counter(
    "ai_events_consumed_total",
    "Events processed by consumer groups, by outcome.",
    ["consumer_group", "outcome"],
    registry=REGISTRY,
)

# --- Indexing jobs --------------------------------------------------------
INDEX_JOBS = Counter(
    "ai_index_jobs_total",
    "Knowledge indexing jobs, by terminal status.",
    ["status"],
    registry=REGISTRY,
)
INDEX_JOBS_BY_STATUS = Gauge(
    "ai_index_jobs_current",
    "Current knowledge indexing jobs, by status.",
    ["status"],
    registry=REGISTRY,
)
SECURITY_REFRESH_OVERDUE = Gauge(
    "ai_security_refresh_overdue",
    "Security-refresh index jobs not completed before the staleness window.",
    registry=REGISTRY,
)
EVENT_BACKLOG = Gauge(
    "ai_event_delivery_backlog",
    "Undelivered event deliveries, by state (pending/delayed/dead).",
    ["state"],
    registry=REGISTRY,
)
EVENT_BACKLOG_OLDEST_SECONDS = Gauge(
    "ai_event_delivery_oldest_pending_seconds",
    "Age of the oldest due-but-undelivered event.",
    registry=REGISTRY,
)
RECONCILE_RUNS = Counter(
    "ai_index_reconcile_runs_total",
    "Automated index reconciliation runs.",
    ["outcome"],
    registry=REGISTRY,
)

# --- Workers --------------------------------------------------------------
WORKER_CYCLES = Counter(
    "ai_worker_cycles_total",
    "Completed worker cycles, by outcome.",
    ["worker", "outcome"],
    registry=REGISTRY,
)
WORKER_LAST_SUCCESS = Gauge(
    "ai_worker_last_success_timestamp_seconds",
    "Unix timestamp of the last successful worker cycle.",
    ["worker"],
    registry=REGISTRY,
)
WORKER_CONSECUTIVE_FAILURES = Gauge(
    "ai_worker_consecutive_failures",
    "Consecutive failed worker cycles since the last success.",
    ["worker"],
    registry=REGISTRY,
)
WORKER_SHUTDOWNS = Counter(
    "ai_worker_shutdowns_total",
    "Graceful worker shutdowns.",
    ["worker"],
    registry=REGISTRY,
)


_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_LONG_ID_RE = re.compile(r"\b[0-9a-fA-F]{24,}\b")
_NUM_ID_RE = re.compile(r"(?<=/)\d+(?=/|$)")


def normalize_path(path: str) -> str:
    """Collapse high-cardinality path segments to keep label cardinality low.

    Route templates are preferred (the middleware uses ``scope['route']`` when
    available); this fallback replaces numeric/uuid/hex ids with ``{id}``.
    """
    path = _UUID_RE.sub("{id}", path)
    path = _LONG_ID_RE.sub("{id}", path)
    return _NUM_ID_RE.sub("{id}", path)


def record_http_request(
    *, method: str, path: str, status: int, duration_seconds: float
) -> None:
    label_path = path or "unknown"
    HTTP_REQUESTS.labels(method=method, path=label_path, status=str(status)).inc()
    HTTP_DURATION.labels(method=method, path=label_path).observe(duration_seconds)


def observe_model_call(
    *,
    operation: str,
    provider: str,
    model: str,
    duration_seconds: float,
    outcome: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cost_usd: float | None = None,
) -> None:
    MODEL_CALLS.labels(operation=operation, provider=provider, model=model, outcome=outcome).inc()
    MODEL_DURATION.labels(operation=operation, provider=provider, model=model).observe(
        duration_seconds
    )
    if input_tokens:
        MODEL_TOKENS.labels(
            operation=operation, provider=provider, model=model, kind="input"
        ).inc(input_tokens)
    if output_tokens:
        MODEL_TOKENS.labels(
            operation=operation, provider=provider, model=model, kind="output"
        ).inc(output_tokens)
    if cost_usd:
        MODEL_COST.labels(provider=provider, model=model).inc(cost_usd)


def observe_retrieval(
    *, operation: str, outcome: str, duration_seconds: float, result_count: int
) -> None:
    RETRIEVAL_CALLS.labels(operation=operation, outcome=outcome).inc()
    RETRIEVAL_DURATION.labels(operation=operation).observe(duration_seconds)
    RETRIEVAL_RESULTS.labels(operation=operation).observe(result_count)


def observe_tool_call(*, tool: str, outcome: str, duration_seconds: float) -> None:
    TOOL_CALLS.labels(tool=tool, outcome=outcome).inc()
    TOOL_DURATION.labels(tool=tool).observe(duration_seconds)


def record_citation_validation(*, operation: str, status: str) -> None:
    CITATION_VALIDATIONS.labels(operation=operation, status=status).inc()


def record_event_published(*, event_type: str) -> None:
    EVENTS_PUBLISHED.labels(event_type=event_type).inc()


def record_event_publish_failed(*, event_type: str) -> None:
    EVENTS_PUBLISH_FAILED.labels(event_type=event_type).inc()


def record_event_consumed(*, consumer_group: str, outcome: str) -> None:
    EVENTS_CONSUMED.labels(consumer_group=consumer_group, outcome=outcome).inc()


def record_index_job(*, status: str) -> None:
    INDEX_JOBS.labels(status=status).inc()


def record_job_metrics(*, by_status: dict[str, int], security_overdue: int) -> None:
    for status, value in by_status.items():
        INDEX_JOBS_BY_STATUS.labels(status=status).set(value)
    SECURITY_REFRESH_OVERDUE.set(security_overdue)


def record_event_backlog(
    *, pending: int, delayed: int, dead: int, oldest_pending_seconds: float = 0.0
) -> None:
    EVENT_BACKLOG.labels(state="pending").set(pending)
    EVENT_BACKLOG.labels(state="delayed").set(delayed)
    EVENT_BACKLOG.labels(state="dead").set(dead)
    EVENT_BACKLOG_OLDEST_SECONDS.set(max(0.0, oldest_pending_seconds))


def record_reconcile(*, outcome: str) -> None:
    RECONCILE_RUNS.labels(outcome=outcome).inc()


def record_worker_cycle(*, worker: str, outcome: str) -> None:
    WORKER_CYCLES.labels(worker=worker, outcome=outcome).inc()


def record_worker_success(*, worker: str, timestamp: float) -> None:
    WORKER_LAST_SUCCESS.labels(worker=worker).set(timestamp)
    WORKER_CONSECUTIVE_FAILURES.labels(worker=worker).set(0)


def record_worker_failure(*, worker: str, consecutive_failures: int) -> None:
    WORKER_CONSECUTIVE_FAILURES.labels(worker=worker).set(consecutive_failures)


def record_worker_shutdown(*, worker: str) -> None:
    WORKER_SHUTDOWNS.labels(worker=worker).inc()


def render_metrics() -> tuple[bytes, str]:
    """Return the latest metrics exposition and its content type."""
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST
