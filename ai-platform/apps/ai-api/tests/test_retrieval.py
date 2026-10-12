from __future__ import annotations

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
RETRIEVAL_ONLY = frozenset({"ai.retrieval:execute"})


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


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


def _principal(username: str = "tester", permissions: frozenset[str] = POWER_USER) -> Principal:
    return Principal(
        user_id=username, username=username, tenant_id=TENANT, permissions=permissions
    )


def _ingest(client: TestClient, code: str, documents: list[dict]) -> dict:
    source = client.post(
        "/api/v1/ai/knowledge/sources",
        json={"code": code, "name": code, "kind": "manual"},
    ).json()
    response = client.post(
        f"/api/v1/ai/knowledge/sources/{source['id']}/ingest",
        json={"documents": documents},
    )
    assert response.status_code == 202
    assert response.json()["job"]["status"] == "succeeded"
    return source


def test_search_filters_documents_by_acl(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin")) as admin:
        _ingest(
            admin,
            "restricted-ops",
            [
                {
                    "external_id": "pump",
                    "text": "The pump requires quarterly lubrication.",
                    "acl": {"users": ["m.okonkwo"]},
                }
            ],
        )

    with _client(repository, _principal("stranger", RETRIEVAL_ONLY)) as stranger:
        response = stranger.post("/api/v1/ai/search", json={"query": "pump lubrication"})
        assert response.status_code == 200
        assert response.json()["count"] == 0

    with _client(repository, _principal("m.okonkwo", RETRIEVAL_ONLY)) as authorized:
        response = authorized.post("/api/v1/ai/search", json={"query": "pump lubrication"})
        assert response.status_code == 200
        assert response.json()["count"] == 1


def test_search_respects_classification_ceiling(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as admin:
        _ingest(
            admin,
            "classified",
            [
                {
                    "external_id": "secret",
                    "text": "Restricted restructuring strategy for the pump division.",
                    "classification": "restricted",
                }
            ],
        )
        response = admin.post("/api/v1/ai/search", json={"query": "restricted restructuring"})
        assert response.status_code == 200
        assert response.json()["count"] == 0


def test_rag_returns_insufficient_evidence_for_empty_corpus(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        response = client.post("/api/v1/ai/rag/query", json={"query": "what is the policy?"})
        assert response.status_code == 200
        body = response.json()
        assert body["insufficient_evidence"] is True
        assert body["citations"] == []


def test_rag_grounds_answer_with_citations(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "maintenance",
            [
                {
                    "external_id": "pump",
                    "title": "Pump maintenance",
                    "text": "The pump requires quarterly lubrication of its bearings.",
                }
            ],
        )
        response = client.post(
            "/api/v1/ai/rag/query", json={"query": "What maintenance does the pump need?"}
        )
        usage = client.get("/api/v1/ai/usage")

    assert response.status_code == 200
    body = response.json()
    assert body["insufficient_evidence"] is False
    assert body["is_mock"] is True
    assert body["citations"]
    citation = body["citations"][0]
    assert citation["source_code"] == "maintenance"
    assert "pump" in citation["snippet"].lower()
    assert body["confidence"] > 0
    assert usage.json()["quantity"] > 0
