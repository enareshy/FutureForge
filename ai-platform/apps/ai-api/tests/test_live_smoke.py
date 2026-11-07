"""Opt-in live smoke tests (Phase 13).

A small suite that verifies a **running** deployment end to end over HTTP. It is
skipped unless ``AI_E2E=1`` is set, and reads its target from the environment:

    AI_E2E=1 \
    AI_E2E_BASE_URL=http://127.0.0.1:8000 \
    AI_E2E_TOKEN=<session-token> \
    pytest -m live tests/test_live_smoke.py

If no token is provided, only the unauthenticated probes run.
"""

from __future__ import annotations

import os

import httpx
import pytest

pytestmark = pytest.mark.live

_BASE_URL = os.environ.get("AI_E2E_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
_TOKEN = os.environ.get("AI_E2E_TOKEN", "")
_METRICS_TOKEN = os.environ.get("AI_METRICS_AUTH_TOKEN", "")


def _require_live() -> None:
    if os.environ.get("AI_E2E", "") != "1":
        pytest.skip("set AI_E2E=1 to run the live smoke suite")


@pytest.fixture()
def client() -> httpx.Client:
    _require_live()
    headers = {"Authorization": f"Bearer {_TOKEN}"} if _TOKEN else {}
    with httpx.Client(base_url=_BASE_URL, headers=headers, timeout=10.0) as http:
        yield http


def test_liveness(client: httpx.Client) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_readiness(client: httpx.Client) -> None:
    response = client.get("/readyz")
    assert response.status_code == 200
    assert response.json()["checks"]["database"] in ("ok", "in_memory")


def test_metrics_requires_authentication() -> None:
    _require_live()
    with httpx.Client(base_url=_BASE_URL, timeout=10.0) as anon:
        response = anon.get("/metrics")
    assert response.status_code == 401


def test_metrics_exposed_with_bearer_token() -> None:
    _require_live()
    if not _METRICS_TOKEN:
        pytest.skip("set AI_METRICS_AUTH_TOKEN to verify the metrics scrape")
    with httpx.Client(
        base_url=_BASE_URL,
        headers={"Authorization": f"Bearer {_METRICS_TOKEN}"},
        timeout=10.0,
    ) as metrics_client:
        response = metrics_client.get("/metrics")
    assert response.status_code == 200
    assert "ai_http_requests_total" in response.text


def test_capabilities_requires_authentication() -> None:
    _require_live()
    with httpx.Client(base_url=_BASE_URL, timeout=10.0) as anon:
        response = anon.get("/api/v1/ai/capabilities")
    assert response.status_code in (401, 403)


def test_authenticated_chat_roundtrip(client: httpx.Client) -> None:
    if not _TOKEN:
        pytest.skip("set AI_E2E_TOKEN to exercise authenticated endpoints")
    response = client.post(
        "/api/v1/ai/chat",
        json={"messages": [{"role": "user", "content": "hello"}], "model": "mock-chat"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["content"]
    assert response.headers.get("x-request-id")


def test_authenticated_search_roundtrip(client: httpx.Client) -> None:
    if not _TOKEN:
        pytest.skip("set AI_E2E_TOKEN to exercise authenticated endpoints")
    response = client.post("/api/v1/ai/search", json={"query": "policy", "limit": 3})
    assert response.status_code == 200
    assert "results" in response.json()
