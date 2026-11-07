from __future__ import annotations

from fastapi.testclient import TestClient


def test_liveness(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_v1_health(client: TestClient) -> None:
    response = client.get("/api/v1/ai/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "ai-api"
    assert body["components"]["api"] == "ok"


def test_request_id_is_echoed(client: TestClient) -> None:
    response = client.get("/api/v1/ai/health", headers={"x-request-id": "test-123"})
    assert response.headers["x-request-id"] == "test-123"


def test_request_id_is_generated(client: TestClient) -> None:
    response = client.get("/api/v1/ai/health")
    assert response.headers.get("x-request-id")


def test_openapi_documents_health(client: TestClient) -> None:
    response = client.get("/api/v1/ai/openapi.json")
    assert response.status_code == 200
    spec = response.json()
    assert "/api/v1/ai/health" in spec["paths"]
