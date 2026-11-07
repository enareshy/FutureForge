from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal, get_search_backend
from ai_api.domain.errors import ServiceUnavailableError
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
POWER_USER = frozenset({"*:*"})
RETRIEVAL_ONLY = frozenset({"ai.retrieval:execute"})


@contextmanager
def _client(
    repository: InMemoryAiRepository,
    principal: Principal,
    search_backend: object | None = None,
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal
    if search_backend is not None:
        app.dependency_overrides[get_search_backend] = lambda: search_backend
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


class _UnavailableBackend:
    """Search backend that reports itself as unavailable (dependency down)."""

    name = "unavailable"

    async def search(self, tenant_id: int, query: str, *, limit: int):
        raise ServiceUnavailableError("lexical backend down")

    async def index_document(self, tenant_id: int, document: dict, chunks: list) -> None:
        raise ServiceUnavailableError("lexical backend down")

    async def delete_document(self, tenant_id: int, document_id: int) -> None:
        raise ServiceUnavailableError("lexical backend down")

    async def status(self) -> dict:
        return {"backend": self.name, "available": False}


def test_search_mode_lexical_only_uses_lexical_backend(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "mixed",
            [
                {"external_id": "pump", "text": "pump lubrication schedule"},
                {"external_id": "valve", "text": "valve torque specification"},
            ],
        )
        response = client.post(
            "/api/v1/ai/search", json={"query": "pump", "mode": "lexical"}
        )

    body = response.json()
    assert response.status_code == 200
    assert body["mode"] == "lexical"
    assert body["fallback"] is False
    assert body["count"] == 1
    assert body["results"][0]["external_id"] == "pump"


def test_search_mode_semantic_reports_semantic(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "sema",
            [{"external_id": "pump", "text": "pump maintenance"}],
        )
        response = client.post(
            "/api/v1/ai/search", json={"query": "pump", "mode": "semantic"}
        )

    body = response.json()
    assert body["mode"] == "semantic"
    assert body["count"] >= 1


def test_search_hybrid_labels_hybrid_when_both_paths_match(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "hyb",
            [{"external_id": "pump", "text": "pump maintenance guide"}],
        )
        response = client.post(
            "/api/v1/ai/search", json={"query": "pump", "mode": "hybrid"}
        )

    body = response.json()
    assert body["mode"] == "hybrid"
    assert body["fallback"] is False


def test_search_reports_fallback_when_lexical_unavailable(
    repository: InMemoryAiRepository,
) -> None:
    with _client(
        repository, _principal("admin"), search_backend=_UnavailableBackend()
    ) as client:
        _ingest(
            client,
            "fb",
            [{"external_id": "pump", "text": "pump maintenance guide"}],
        )
        response = client.post(
            "/api/v1/ai/search", json={"query": "pump", "mode": "hybrid"}
        )

    body = response.json()
    assert response.status_code == 200
    assert body["mode"] == "semantic"
    assert body["fallback"] is True
    assert body["count"] >= 1


def test_search_results_include_document_metadata(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "meta",
            [
                {
                    "external_id": "DOC-123",
                    "title": "Pump manual",
                    "mime_type": "text/markdown",
                    "text": "pump maintenance",
                }
            ],
        )
        response = client.post("/api/v1/ai/search", json={"query": "pump"})

    result = response.json()["results"][0]
    assert result["title"] == "Pump manual"
    assert result["mime_type"] == "text/markdown"
    assert result["external_id"] == "DOC-123"
    assert result["document_status"] == "indexed"
    assert result["document_created_at"] is not None


def test_search_filter_by_mime_type(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "filter",
            [
                {
                    "external_id": "a",
                    "mime_type": "text/plain",
                    "text": "pump common reference",
                },
                {
                    "external_id": "b",
                    "mime_type": "text/markdown",
                    "text": "pump common reference",
                },
            ],
        )
        response = client.post(
            "/api/v1/ai/search",
            json={
                "query": "pump",
                "mode": "lexical",
                "filters": [
                    {"field": "mime_type", "op": "eq", "value": "text/plain"}
                ],
            },
        )

    body = response.json()
    assert body["count"] == 1
    assert body["total"] == 1
    assert body["results"][0]["mime_type"] == "text/plain"


def test_search_filter_in_operator(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "inop",
            [
                {"external_id": "a", "mime_type": "text/plain", "text": "pump common"},
                {"external_id": "b", "mime_type": "text/markdown", "text": "pump common"},
                {"external_id": "c", "mime_type": "text/csv", "text": "pump common"},
            ],
        )
        response = client.post(
            "/api/v1/ai/search",
            json={
                "query": "pump",
                "mode": "lexical",
                "filters": [
                    {
                        "field": "mime_type",
                        "op": "in",
                        "value": ["text/plain", "text/csv"],
                    }
                ],
            },
        )

    assert response.json()["count"] == 2


def test_search_rejects_unknown_filter_field(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        response = client.post(
            "/api/v1/ai/search",
            json={
                "query": "pump",
                "filters": [{"field": "secret_column", "op": "eq", "value": "x"}],
            },
        )
    assert response.status_code == 422


def test_search_rejects_disallowed_operator(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin")) as client:
        response = client.post(
            "/api/v1/ai/search",
            json={
                "query": "pump",
                "filters": [{"field": "mime_type", "op": "gte", "value": "a"}],
            },
        )
    assert response.status_code == 422


def test_search_rejects_typed_value_mismatch(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        response = client.post(
            "/api/v1/ai/search",
            json={
                "query": "pump",
                "filters": [{"field": "source_id", "op": "eq", "value": "not-a-number"}],
            },
        )
    assert response.status_code == 422


def test_search_pagination(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "pages",
            [
                {"external_id": f"doc-{i}", "text": f"common knowledge item {i}"}
                for i in range(3)
            ],
        )
        first = client.post(
            "/api/v1/ai/search",
            json={"query": "common", "mode": "lexical", "limit": 1, "page": 1},
        ).json()
        second = client.post(
            "/api/v1/ai/search",
            json={"query": "common", "mode": "lexical", "limit": 1, "page": 2},
        ).json()

    assert first["total"] == 3
    assert first["count"] == 1
    assert second["page"] == 2
    assert second["count"] == 1
    assert first["results"][0]["external_id"] != second["results"][0]["external_id"]


def test_search_sort_by_title(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "sorted",
            [
                {"external_id": "g", "title": "Gamma", "text": "common subject"},
                {"external_id": "a", "title": "Alpha", "text": "common subject"},
                {"external_id": "b", "title": "Beta", "text": "common subject"},
            ],
        )
        response = client.post(
            "/api/v1/ai/search",
            json={"query": "common", "mode": "lexical", "sort": "title"},
        )

    titles = [r["title"] for r in response.json()["results"]]
    assert titles == ["Alpha", "Beta", "Gamma"]


def test_search_backward_compatible_default_request(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(client, "compat", [{"external_id": "pump", "text": "pump guide"}])
        response = client.post("/api/v1/ai/search", json={"query": "pump"})

    body = response.json()
    assert set({"query", "count", "results"}).issubset(body)
    assert body["query"] == "pump"
    assert body["count"] >= 1


def test_search_consolidates_chunks_into_document_results(
    repository: InMemoryAiRepository,
) -> None:
    # A long document is chunked into several passages, all matching the query;
    # the search UI must return one document-level result, not one per chunk.
    long_text = "common maintenance guidance. " * 80
    with _client(repository, _principal("admin")) as client:
        _ingest(client, "longdoc", [{"external_id": "long-1", "text": long_text}])
        response = client.post(
            "/api/v1/ai/search", json={"query": "common", "mode": "lexical"}
        )

    body = response.json()
    assert body["total"] == 1
    assert body["count"] == 1
    result = body["results"][0]
    assert result["external_id"] == "long-1"
    assert result["hit_count"] >= 2
    assert len(result["matched_chunks"]) == result["hit_count"]


def test_search_exact_identifier_boost_ranks_identifier_first(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "ids",
            [
                {"external_id": "VALVE-2026-001", "text": "valve assembly valve"},
                {"external_id": "generic-valve", "text": "valve assembly valve"},
            ],
        )
        response = client.post(
            "/api/v1/ai/search",
            json={"query": "VALVE-2026-001", "mode": "hybrid"},
        )

    results = response.json()["results"]
    assert results[0]["external_id"] == "VALVE-2026-001"
    assert results[0]["score_components"]["exact"] == 1.0


def test_search_results_include_score_components(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(client, "comp", [{"external_id": "c1", "text": "phrase matching doc"}])
        response = client.post(
            "/api/v1/ai/search", json={"query": "phrase matching", "mode": "lexical"}
        )

    components = response.json()["results"][0]["score_components"]
    assert set(components) == {"base", "exact", "phrase", "title", "freshness"}
    assert components["phrase"] == 1.0
