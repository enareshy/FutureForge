"""Stage 4 Phase 6: search/retrieval integration with the Stage 3 assistant.

The assistant must reuse the one retrieval pipeline (no direct vector-store
access), carry search filters through, and enrich the RAG context with revision
and lifecycle metadata. Filters can only narrow the already-authorized set.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal
from ai_api.application.services.retrieval_service import RetrievalService
from ai_api.config.settings import Settings
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

POWER_USER = frozenset({"*:*"})


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


def _principal(name: str = "admin") -> Principal:
    return Principal(
        user_id=name,
        username=name,
        tenant_id=1,
        actor_id=1,
        permissions=POWER_USER,
    )


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


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


def test_rag_query_applies_search_filters(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(
            client,
            "policy-a",
            [{"external_id": "PA-1", "text": "Pump policy: lubricate quarterly."}],
        )
        _ingest(
            client,
            "policy-b",
            [{"external_id": "PB-1", "text": "Pump policy: replace annually."}],
        )
        response = client.post(
            "/api/v1/ai/rag/query",
            json={
                "query": "pump policy",
                "filters": [{"field": "source_code", "op": "eq", "value": "policy-a"}],
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["insufficient_evidence"] is False
    assert body["citations"]
    assert {c["source_code"] for c in body["citations"]} == {"policy-a"}


def test_rag_query_accepts_lexical_mode(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(
            client,
            "lexical-src",
            [{"external_id": "LX-1", "text": "Torque the flange bolts to 40 Nm."}],
        )
        response = client.post(
            "/api/v1/ai/rag/query",
            json={"query": "flange bolts torque", "mode": "lexical"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["insufficient_evidence"] is False
    assert body["citations"][0]["source_code"] == "lexical-src"


def test_rag_query_rejects_unknown_filter_field(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        response = client.post(
            "/api/v1/ai/rag/query",
            json={
                "query": "pump",
                "filters": [{"field": "secret_column", "op": "eq", "value": "x"}],
            },
        )
    assert response.status_code == 422


def test_assistant_message_carries_filters_and_citations(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _ingest(
            client,
            "manual-a",
            [{"external_id": "MA-1", "text": "Pump maintenance: quarterly lubrication."}],
        )
        _ingest(
            client,
            "manual-b",
            [{"external_id": "MB-1", "text": "Pump maintenance: annual overhaul."}],
        )
        conversation = client.post(
            "/api/v1/ai/assistant/conversations", json={"title": "pump"}
        ).json()
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation['id']}/messages",
            json={
                "content": "What maintenance does the pump need?",
                "filters": [{"field": "source_code", "op": "eq", "value": "manual-b"}],
            },
        )

    assert response.status_code == 201
    message = response.json()
    assert message["answer_status"] == "answered"
    assert message["sources"]
    assert {s["source_code"] for s in message["sources"]} == {"manual-b"}
    assert all(s["document_id"] is not None for s in message["sources"])


def test_assistant_rejects_unknown_filter_field(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        conversation = client.post(
            "/api/v1/ai/assistant/conversations", json={"title": "x"}
        ).json()
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation['id']}/messages",
            json={
                "content": "pump",
                "filters": [{"field": "owner", "op": "eq", "value": "x"}],
            },
        )
    assert response.status_code == 422


def test_build_context_includes_lifecycle_metadata() -> None:
    service = RetrievalService(
        repository=None,  # type: ignore[arg-type]
        gateway=None,  # type: ignore[arg-type]
        governance=None,  # type: ignore[arg-type]
        audit=None,  # type: ignore[arg-type]
        access=None,  # type: ignore[arg-type]
        settings=Settings(),
    )
    context = service.build_context(
        [
            {
                "source_code": "manual-a",
                "chunk_index": 2,
                "title": "Pump Manual",
                "external_id": "DOC-7",
                "document_status": "indexed",
                "document_updated_at": "2026-10-01T12:00:00+00:00",
                "content": "Lubricate the bearings quarterly.",
            }
        ]
    )
    assert "[1] (manual-a#2" in context
    assert "title=Pump Manual" in context
    assert "id=DOC-7" in context
    assert "status=indexed" in context
    assert "updated=2026-10-01T12:00:00+00:00" in context
    assert "Lubricate the bearings quarterly." in context
