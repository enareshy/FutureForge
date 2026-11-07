from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
POWER_USER = frozenset({"*:*"})


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


@contextmanager
def _client(
    repository: InMemoryAiRepository, principal: Principal
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _principal(username: str = "tester", permissions: frozenset[str] = POWER_USER) -> Principal:
    return Principal(
        user_id=username, username=username, tenant_id=TENANT, permissions=permissions
    )


def test_feedback_roundtrip(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        created = client.post("/api/v1/ai/feedback", json={"rating": 1, "comment": "Helped."})
        assert created.status_code == 200
        body = created.json()
        assert body["rating"] == 1

        listed = client.get("/api/v1/ai/feedback")
        assert listed.status_code == 200
        assert listed.json()["meta"]["total"] == 1

        invalid = client.post("/api/v1/ai/feedback", json={"comment": "   "})
        assert invalid.status_code == 422

        unknown = client.post("/api/v1/ai/feedback", json={"execution_id": 999999, "rating": 0})
        assert unknown.status_code == 404


def test_feedback_requires_capability(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("viewer", frozenset({"ai.usage:read"}))) as viewer:
        denied = viewer.post("/api/v1/ai/feedback", json={"rating": 1})
    assert denied.status_code == 403


def test_providers_registry(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        response = client.get("/api/v1/ai/providers")
    assert response.status_code == 200
    items = response.json()["items"]
    mock = next(item for item in items if item["provider"] == "mock")
    assert mock["available"] is True
    assert mock["is_mock"] is True
    chat = next(model for model in mock["models"] if model["code"] == "mock-chat")
    assert chat["capability"]["supports_streaming"] is True


def test_chat_stream_sse(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        response = client.post(
            "/api/v1/ai/chat/stream",
            json={"messages": [{"role": "user", "content": "Hello streaming"}]},
        )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    body = response.text
    assert "event: delta" in body
    assert "event: done" in body

    done_frames = [
        line
        for line in body.splitlines()
        if line.startswith("data: ") and "content" in line
    ]
    payload = json.loads(done_frames[-1][len("data: ") :])
    assert payload["usage"]["total_tokens"] > 0
    assert payload["is_mock"] is True
    assert payload["request_id"]


def test_chat_stream_requires_capability(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("viewer", frozenset({"ai.agents:read"}))) as viewer:
        response = viewer.post(
            "/api/v1/ai/chat/stream",
            json={"messages": [{"role": "user", "content": "hi"}]},
        )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_chat_stream_unsupported_model(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        response = client.post(
            "/api/v1/ai/chat/stream",
            json={"messages": [{"role": "user", "content": "hi"}], "model": "mock-embed"},
        )
    assert response.status_code == 422
