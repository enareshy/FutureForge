from __future__ import annotations

from fastapi.testclient import TestClient


def test_unknown_route_uses_error_envelope(client: TestClient) -> None:
    response = client.get("/api/v1/ai/does-not-exist")
    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "not_found"
    assert body["error"]["request_id"]


def test_method_not_allowed_uses_error_envelope(client: TestClient) -> None:
    response = client.post("/api/v1/ai/health")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method_not_allowed"
