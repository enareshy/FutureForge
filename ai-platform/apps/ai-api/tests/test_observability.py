from __future__ import annotations

from fastapi.testclient import TestClient

from ai_api.telemetry.langfuse import LangfusePublisher
from ai_api.telemetry.logging import (
    bind_log_context,
    clear_log_context,
    request_id_var,
    tenant_id_var,
    user_id_var,
)
from ai_api.telemetry.metrics import (
    normalize_path,
    observe_model_call,
    observe_retrieval,
    observe_tool_call,
    record_event_consumed,
    record_event_published,
    record_http_request,
    record_index_job,
    render_metrics,
)


def test_metrics_endpoint_exposes_prometheus_text(client: TestClient) -> None:
    client.get("/healthz")
    response = client.get("/metrics")
    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    body = response.text
    assert "ai_http_requests_total" in body
    assert "ai_model_calls_total" in body


def test_liveness_and_readiness(client: TestClient) -> None:
    assert client.get("/healthz").json() == {"status": "ok"}
    ready = client.get("/readyz")
    assert ready.status_code == 200
    payload = ready.json()
    assert payload["status"] == "ok"
    assert payload["checks"]["database"] == "in_memory"
    assert payload["checks"]["telemetry"]["metrics"] == "enabled"


def test_request_id_header_is_echoed(client: TestClient) -> None:
    response = client.get("/healthz", headers={"x-request-id": "abc123"})
    assert response.headers.get("x-request-id") == "abc123"


def test_normalize_path_collapses_identifiers() -> None:
    assert normalize_path("/api/v1/ai/knowledge/sources/42") == (
        "/api/v1/ai/knowledge/sources/{id}"
    )
    uuid_path = "/x/123e4567-e89b-12d3-a456-426614174000/y"
    assert normalize_path(uuid_path) == "/x/{id}/y"


def test_metric_helpers_do_not_raise() -> None:
    record_http_request(method="GET", path="/x", status=200, duration_seconds=0.01)
    observe_model_call(
        operation="chat",
        provider="mock",
        model="mock-chat",
        duration_seconds=0.02,
        outcome="success",
        input_tokens=10,
        output_tokens=5,
        cost_usd=0.0,
    )
    observe_retrieval(operation="search", outcome="success", duration_seconds=0.01, result_count=3)
    observe_tool_call(tool="knowledge.search", outcome="success", duration_seconds=0.01)
    record_event_published(event_type="ai.request.completed")
    record_event_consumed(consumer_group="default", outcome="delivered")
    record_index_job(status="succeeded")
    payload, content_type = render_metrics()
    assert payload
    assert content_type


def test_langfuse_disabled_without_keys() -> None:
    publisher = LangfusePublisher(host="", public_key="", secret_key="")
    assert publisher.enabled is False
    publisher.emit_generation(
        model="mock-chat",
        provider="mock",
        operation="chat",
        latency_ms=12,
        input_tokens=3,
        output_tokens=4,
    )
    publisher.emit_score(trace_id="t", name="quality", value=1.0)
    assert publisher._worker is None


def test_langfuse_enabled_with_keys() -> None:
    publisher = LangfusePublisher(
        host="http://langfuse.local", public_key="pk", secret_key="sk"
    )
    assert publisher.enabled is True
    assert publisher._auth.startswith("Basic ")


def test_log_context_binding_and_clearing() -> None:
    token = request_id_var.set("req-1")
    try:
        bind_log_context(tenant_id=7, user_id="u-9", auth_source="enterprise")
        assert tenant_id_var.get() == 7
        assert user_id_var.get() == "u-9"
        assert request_id_var.get() == "req-1"
    finally:
        clear_log_context()
        request_id_var.reset(token)
    assert tenant_id_var.get() is None
    assert user_id_var.get() is None
