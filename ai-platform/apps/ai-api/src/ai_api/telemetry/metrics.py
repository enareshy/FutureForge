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


def record_event_published(*, event_type: str) -> None:
    EVENTS_PUBLISHED.labels(event_type=event_type).inc()


def record_event_consumed(*, consumer_group: str, outcome: str) -> None:
    EVENTS_CONSUMED.labels(consumer_group=consumer_group, outcome=outcome).inc()


def record_index_job(*, status: str) -> None:
    INDEX_JOBS.labels(status=status).inc()


def render_metrics() -> tuple[bytes, str]:
    """Return the latest metrics exposition and its content type."""
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST
