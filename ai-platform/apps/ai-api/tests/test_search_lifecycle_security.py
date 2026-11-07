"""Phase 3: retrieval-time authorization and index lifecycle security.

The search backend is a retrieval index, not an authorization authority. These
tests cover stale index entries after delete/reindex, ACL tightening,
classification changes, disabled sources, fail-closed ACLs, delete propagation
and reindex label clamping.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal, get_search_backend
from ai_api.config.settings import Settings
from ai_api.domain.errors import ServiceUnavailableError
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.infrastructure.search.opensearch import OpenSearchBackend
from ai_api.main import create_app
from ai_api.security.access_control import AccessControl
from ai_api.security.policies import Principal

TENANT = 1
POWER_USER = frozenset({"*:*"})
RETRIEVAL_ONLY = frozenset({"ai.retrieval:execute"})


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


@contextmanager
def _client(
    repository: InMemoryAiRepository,
    principal: Principal,
    search_backend: object | None = None,
    *,
    raise_server_exceptions: bool = True,
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal
    if search_backend is not None:
        app.dependency_overrides[get_search_backend] = lambda: search_backend
    try:
        with TestClient(app, raise_server_exceptions=raise_server_exceptions) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _principal(
    username: str = "tester",
    permissions: frozenset[str] = POWER_USER,
    roles: frozenset[str] = frozenset(),
) -> Principal:
    return Principal(
        user_id=username,
        username=username,
        tenant_id=TENANT,
        permissions=permissions,
        roles=roles,
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


def _search(client: TestClient, query: str, mode: str = "semantic") -> dict:
    response = client.post(
        "/api/v1/ai/search", json={"query": query, "mode": mode}
    )
    assert response.status_code == 200
    return response.json()


def _candidate(chunk: dict, **overrides: Any) -> dict[str, Any]:
    candidate = {
        "chunk_id": chunk["id"],
        "document_id": chunk["document_id"],
        "source_id": 1,
        "chunk_index": chunk["chunk_index"],
        "content": chunk["content"],
        "classification": chunk.get("classification", "internal"),
        "acl": chunk.get("acl", {}),
        "title": "stale",
        "mime_type": "text/plain",
        "external_id": "stale",
        "document_status": "indexed",
        "source_code": "stale-source",
        "score": 1.0,
    }
    candidate.update(overrides)
    return candidate


class _StaleBackend:
    name = "stale"

    def __init__(self, candidates: list[dict[str, Any]]) -> None:
        self._candidates = candidates

    async def search(self, tenant_id: int, query: str, *, limit: int):
        return list(self._candidates)

    async def index_document(self, tenant_id: int, document: dict, chunks: list) -> None:
        return None

    async def delete_document(self, tenant_id: int, document_id: int, **kwargs: Any) -> None:
        return None

    async def delete_source(self, tenant_id: int, source_id: int) -> None:
        return None

    async def status(self) -> dict:
        return {"backend": self.name, "available": True}


class _RecordingBackend(_StaleBackend):
    name = "recording"

    def __init__(self, *, fail_delete: bool = False) -> None:
        super().__init__([])
        self.fail_delete = fail_delete
        self.deleted_documents: list[dict[str, Any]] = []
        self.deleted_sources: list[tuple[int, int]] = []
        self.indexed_documents: list[dict[str, Any]] = []

    async def index_document(self, tenant_id: int, document: dict, chunks: list) -> None:
        self.indexed_documents.append(dict(document))

    async def delete_document(
        self,
        tenant_id: int,
        document_id: int,
        *,
        source_id: int | None = None,
        external_id: str | None = None,
    ) -> None:
        if self.fail_delete:
            raise ServiceUnavailableError("search backend down")
        self.deleted_documents.append(
            {
                "tenant_id": tenant_id,
                "document_id": document_id,
                "source_id": source_id,
                "external_id": external_id,
            }
        )

    async def delete_source(self, tenant_id: int, source_id: int) -> None:
        if self.fail_delete:
            raise ServiceUnavailableError("search backend down")
        self.deleted_sources.append((tenant_id, source_id))


def test_ingestion_propagates_stable_identity_to_search_index(
    repository: InMemoryAiRepository,
) -> None:
    backend = _RecordingBackend()
    with _client(repository, _principal("admin"), backend) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump lubrication"}])

    indexed = backend.indexed_documents[0]
    assert indexed["external_id"] == "pump"
    assert indexed["source_id"] == repository._sources[0]["id"]
    assert indexed["title"] == "pump"
    assert indexed["classification"] == "internal"
    assert indexed["status"] == "indexed"


def test_deleted_document_candidate_is_revalidated_against_live_state(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump lubrication"}])

    chunk = repository._chunks[0]
    stale_backend = _StaleBackend([_candidate(chunk)])
    assert repository._documents[0]["id"] == chunk["document_id"]
    asyncio.run(repository.delete_document(TENANT, chunk["document_id"]))

    with _client(
        repository, _principal("reader", RETRIEVAL_ONLY), stale_backend
    ) as client:
        body = _search(client, "pump", mode="lexical")
    assert body["count"] == 0
    assert body["results"] == []


def test_reindexed_chunk_id_absent_from_live_state_is_dropped(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        source = _ingest(
            client, "ops", [{"external_id": "pump", "text": "pump lubrication"}]
        )
    old_chunk = dict(repository._chunks[0])
    with _client(repository, _principal("admin")) as client:
        response = client.post(
            f"/api/v1/ai/knowledge/sources/{source['id']}/reindex"
        )
        assert response.status_code == 200

    stale_backend = _StaleBackend([_candidate(old_chunk)])
    with _client(
        repository, _principal("reader", RETRIEVAL_ONLY), stale_backend
    ) as client:
        body = _search(client, "pump", mode="lexical")
    assert body["count"] == 0


def test_live_acl_tightening_overrides_indexed_acl(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "ops",
            [
                {
                    "external_id": "pump",
                    "text": "pump lubrication",
                    "acl": {"users": ["alice"]},
                }
            ],
        )

    alice = _principal("alice", RETRIEVAL_ONLY)
    with _client(repository, alice) as client:
        assert _search(client, "pump")["count"] == 1

    repository._documents[0]["acl"] = {"users": ["bob"]}

    with _client(repository, alice) as client:
        assert _search(client, "pump")["count"] == 0


def test_live_classification_increase_blocks_retrieval(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(
            client,
            "ops",
            [{"external_id": "pump", "text": "pump lubrication"}],
        )

    reader = _principal("alice", RETRIEVAL_ONLY)
    with _client(repository, reader) as client:
        assert _search(client, "pump")["count"] == 1

    repository._documents[0]["classification"] = "restricted"

    with _client(repository, reader) as client:
        assert _search(client, "pump")["count"] == 0


def test_disabled_source_is_not_retrievable(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump lubrication"}])

    repository._sources[0]["status"] = "disabled"

    with _client(repository, _principal("alice", RETRIEVAL_ONLY)) as client:
        assert _search(client, "pump")["count"] == 0


def test_unknown_acl_keys_fail_closed() -> None:
    access = AccessControl()
    principal = _principal("alice", RETRIEVAL_ONLY)

    assert access.allows(principal, {}) is True
    assert access.allows(principal, {"roles": ["admin"]}) is False
    assert access.allows(principal, {"role": ["admin"]}) is False
    assert access.allows(principal, {"teams": ["ops"]}) is False
    assert access.allows(principal, {"roles": ["admin"], "role": ["admin"]}) is False


def test_reindex_clamps_labels_to_live_document_and_never_restores_stale_acl(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        source = _ingest(
            client,
            "ops",
            [
                {
                    "external_id": "pump",
                    "text": "pump lubrication",
                    "acl": {"users": ["alice"]},
                }
            ],
        )

    repository._documents[0]["classification"] = "confidential"
    repository._documents[0]["acl"] = {"users": ["bob"]}
    assert repository._chunks[0]["acl"] == {"users": ["alice"]}

    with _client(repository, _principal("admin")) as client:
        response = client.post(
            f"/api/v1/ai/knowledge/sources/{source['id']}/reindex"
        )
        assert response.status_code == 200

    document = repository._documents[0]
    assert document["classification"] == "confidential"
    assert document["acl"] == {"users": ["bob"]}
    assert repository._chunks
    assert all(
        chunk["classification"] == "confidential"
        and chunk["acl"] == {"users": ["bob"]}
        for chunk in repository._chunks
    )


def test_delete_document_propagates_stable_identity_to_search(
    repository: InMemoryAiRepository,
) -> None:
    backend = _RecordingBackend()
    with _client(repository, _principal("admin"), backend) as client:
        source = _ingest(
            client, "ops", [{"external_id": "pump", "text": "pump lubrication"}]
        )
        document = repository._documents[0]
        response = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")
        assert response.status_code == 204

    assert backend.deleted_documents == [
        {
            "tenant_id": TENANT,
            "document_id": document["id"],
            "source_id": source["id"],
            "external_id": "pump",
        }
    ]


def test_delete_source_propagates_to_search(
    repository: InMemoryAiRepository,
) -> None:
    backend = _RecordingBackend()
    with _client(repository, _principal("admin"), backend) as client:
        source = _ingest(
            client, "ops", [{"external_id": "pump", "text": "pump lubrication"}]
        )
        response = client.delete(f"/api/v1/ai/knowledge/sources/{source['id']}")
        assert response.status_code == 204

    assert backend.deleted_sources == [(TENANT, source["id"])]


def test_delete_fails_closed_when_search_delete_fails(
    repository: InMemoryAiRepository,
) -> None:
    backend = _RecordingBackend(fail_delete=True)
    with _client(repository, _principal("admin"), backend) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump lubrication"}])
        document = repository._documents[0]
        response = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")
        assert response.status_code == 503

    assert repository._documents[0]["id"] == document["id"]


class _FakeIndices:
    def __init__(self) -> None:
        self.created = False

    async def exists(self, *, index: str) -> bool:
        return True

    async def create(self, *, index: str, body: dict) -> None:
        self.created = True


class _FakeOpenSearchClient:
    def __init__(self) -> None:
        self.indices = _FakeIndices()
        self.delete_queries: list[dict[str, Any]] = []
        self.bulk_calls: list[dict[str, Any]] = []

    async def delete_by_query(self, **kwargs: Any) -> None:
        self.delete_queries.append(kwargs)

    async def bulk(self, **kwargs: Any) -> None:
        self.bulk_calls.append(kwargs)


def _opensearch_backend() -> tuple[OpenSearchBackend, _FakeOpenSearchClient]:
    backend = OpenSearchBackend(Settings())
    client = _FakeOpenSearchClient()
    backend._client = client
    backend._index_ready = True
    return backend, client


@pytest.mark.asyncio
async def test_opensearch_delete_uses_stable_identity() -> None:
    backend, client = _opensearch_backend()
    await backend.delete_document(
        1, 99, source_id=7, external_id="manual"
    )
    filters = client.delete_queries[-1]["body"]["query"]["bool"]["filter"]
    assert {"term": {"tenant_id": 1}} in filters
    assert {"term": {"source_id": 7}} in filters
    assert {"term": {"external_id": "manual"}} in filters
    assert {"term": {"document_id": 99}} not in filters


@pytest.mark.asyncio
async def test_opensearch_index_removes_previous_chunks_by_identity() -> None:
    backend, client = _opensearch_backend()
    await backend.index_document(
        1,
        {
            "id": 5,
            "source_id": 7,
            "external_id": "manual",
            "title": "Manual",
        },
        [{"id": 10, "chunk_index": 0, "content": "text"}],
    )
    filters = client.delete_queries[-1]["body"]["query"]["bool"]["filter"]
    assert {"term": {"source_id": 7}} in filters
    assert {"term": {"external_id": "manual"}} in filters
    assert client.bulk_calls


@pytest.mark.asyncio
async def test_opensearch_delete_source_scopes_by_tenant() -> None:
    backend, client = _opensearch_backend()
    await backend.delete_source(1, 7)
    filters = client.delete_queries[-1]["body"]["query"]["bool"]["filter"]
    assert {"term": {"tenant_id": 1}} in filters
    assert {"term": {"source_id": 7}} in filters


class _FlakyDeleteBackend(_RecordingBackend):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    async def delete_document(
        self,
        tenant_id: int,
        document_id: int,
        *,
        source_id: int | None = None,
        external_id: str | None = None,
    ) -> None:
        self.calls += 1
        if self.calls == 1:
            raise ServiceUnavailableError("delete-by-query interrupted")
        await super().delete_document(
            tenant_id,
            document_id,
            source_id=source_id,
            external_id=external_id,
        )


class _DeleteFalseRepository(InMemoryAiRepository):
    async def delete_document(self, tenant_id: int, document_id: int) -> bool:
        return False


class _DeleteRaisesOnceRepository(InMemoryAiRepository):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    async def delete_document(self, tenant_id: int, document_id: int) -> bool:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("database write failed")
        return await super().delete_document(tenant_id, document_id)


class _AuthzFailureRepository(InMemoryAiRepository):
    async def get_authoritative_chunks(self, tenant_id: int, chunk_ids: list[int]):
        raise RuntimeError("authorization lookup unavailable")


class _AckFailureRepository(InMemoryAiRepository):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    async def set_document_search_state(self, *args, **kwargs):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("state acknowledgement failed")
        return await super().set_document_search_state(*args, **kwargs)


class _FailSecondReplaceRepository(InMemoryAiRepository):
    def __init__(self) -> None:
        super().__init__()
        self.fail_next = False
        self.replace_calls = 0

    async def create_or_replace_document(self, tenant_id: int, data: dict):
        if self.fail_next:
            self.replace_calls += 1
            if self.replace_calls == 2:
                raise RuntimeError("reindex interrupted")
        return await super().create_or_replace_document(tenant_id, data)


def test_partial_delete_failure_is_retryable(
    repository: InMemoryAiRepository,
) -> None:
    backend = _FlakyDeleteBackend()
    with _client(repository, _principal("admin"), backend) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump lubrication"}])
        document = repository._documents[0]
        first = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")
        assert first.status_code == 503
        assert repository._documents[0]["id"] == document["id"]

        second = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")
        assert second.status_code == 204

    assert backend.calls == 2
    assert backend.deleted_documents


def test_database_delete_not_committed_is_reported() -> None:
    repository = _DeleteFalseRepository()
    backend = _RecordingBackend()
    with _client(repository, _principal("admin"), backend) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump lubrication"}])
        document = repository._documents[0]
        response = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")

    assert response.status_code == 409
    assert backend.deleted_documents
    assert repository._documents[0]["id"] == document["id"]


def test_database_delete_exception_after_search_delete_is_retryable() -> None:
    repository = _DeleteRaisesOnceRepository()
    backend = _RecordingBackend()
    with _client(
        repository,
        _principal("admin"),
        backend,
        raise_server_exceptions=False,
    ) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump lubrication"}])
        document = repository._documents[0]
        first = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")
        assert first.status_code == 500
        assert repository._documents[0]["id"] == document["id"]

        second = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")
        assert second.status_code == 204

    assert len(backend.deleted_documents) == 2


def test_authoritative_lookup_failure_returns_no_content() -> None:
    repository = _AuthzFailureRepository()
    with _client(repository, _principal("admin")) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump lubrication"}])

    with _client(
        repository,
        _principal("alice", RETRIEVAL_ONLY),
        raise_server_exceptions=False,
    ) as client:
        response = client.post(
            "/api/v1/ai/search", json={"query": "pump", "mode": "semantic"}
        )

    assert response.status_code == 500
    assert "pump lubrication" not in response.text


def test_search_ack_failure_is_reconcilable() -> None:
    repository = _AckFailureRepository()
    with _client(repository, _principal("admin")) as client:
        source = _ingest(
            client, "ops", [{"external_id": "pump", "text": "pump lubrication"}]
        )
        assert repository._documents[0]["error_class"] is not None
        reconcile = client.post("/api/v1/ai/knowledge/reconcile", json={})
        assert reconcile.status_code == 200
        assert reconcile.json()["sources_queued"] == 1
        assert source["id"]


def test_reindex_halfway_failure_is_safe_to_retry() -> None:
    repository = _FailSecondReplaceRepository()
    with _client(repository, _principal("admin")) as client:
        source = _ingest(
            client,
            "ops",
            [
                {"external_id": "pump", "text": "pump lubrication"},
                {"external_id": "valve", "text": "valve torque"},
            ],
        )
    assert len(repository._documents) == 2

    repository.fail_next = True
    with _client(
        repository, _principal("admin"), raise_server_exceptions=False
    ) as client:
        response = client.post(
            f"/api/v1/ai/knowledge/sources/{source['id']}/reindex"
        )
        assert response.status_code == 500
    assert repository._sources[0]["status"] == "failed"
    assert len(repository._documents) == 2

    repository.fail_next = False
    with _client(repository, _principal("admin")) as client:
        response = client.post(
            f"/api/v1/ai/knowledge/sources/{source['id']}/reindex"
        )
        assert response.status_code == 200

    assert len(repository._documents) == 2
    assert len({doc["external_id"] for doc in repository._documents}) == 2
    assert len(repository._chunks) == 2


class _OrphanBackend(_StaleBackend):
    def __init__(self, documents: list[dict[str, Any]]) -> None:
        super().__init__([])
        self.documents = {int(row["document_id"]): row for row in documents}
        self.deleted_batches: list[list[int]] = []

    async def scan_documents(
        self, tenant_id: int, *, limit: int, after: list[Any] | None = None
    ) -> tuple[list[dict[str, Any]], list[Any] | None]:
        return list(self.documents.values())[:limit], None

    async def delete_documents(self, tenant_id: int, document_ids: list[int]) -> None:
        self.deleted_batches.append(list(document_ids))
        for document_id in document_ids:
            self.documents.pop(document_id, None)


def test_reconciliation_detects_and_idempotently_purges_orphans(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin")) as client:
        live_source = _ingest(
            client, "live", [{"external_id": "pump", "text": "pump lubrication"}]
        )
        disabled_source = _ingest(
            client, "disabled", [{"external_id": "valve", "text": "valve torque"}]
        )
    live_doc = repository._documents[0]
    disabled_doc = repository._documents[1]
    repository._sources[1]["status"] = "disabled"

    backend = _OrphanBackend(
        [
            {
                "document_id": live_doc["id"],
                "source_id": live_source["id"],
                "external_id": "pump",
            },
            {
                "document_id": 9001,
                "source_id": live_source["id"],
                "external_id": "deleted-doc",
            },
            {
                "document_id": 9002,
                "source_id": 7777,
                "external_id": "missing-source",
            },
            {
                "document_id": disabled_doc["id"],
                "source_id": disabled_source["id"],
                "external_id": "valve",
            },
        ]
    )

    with _client(repository, _principal("admin"), backend) as client:
        report = client.post(
            "/api/v1/ai/knowledge/reconcile", json={"scan_orphans": True}
        ).json()
    assert report["orphans_detected"] == 2
    assert report["orphan_document_ids"] == [9001, 9002]
    assert report["missing_source_ids"] == [7777]
    assert report["disabled_source_ids"] == [disabled_source["id"]]
    assert report["orphans_deleted"] == 0
    assert backend.deleted_batches == []

    with _client(repository, _principal("admin"), backend) as client:
        report = client.post(
            "/api/v1/ai/knowledge/reconcile",
            json={"scan_orphans": True, "purge_orphans": True},
        ).json()
    assert report["orphans_deleted"] == 2
    assert backend.deleted_batches == [[9001, 9002]]

    with _client(repository, _principal("admin"), backend) as client:
        report = client.post(
            "/api/v1/ai/knowledge/reconcile",
            json={"scan_orphans": True, "purge_orphans": True},
        ).json()
    assert report["orphans_detected"] == 0
    assert backend.deleted_batches == [[9001, 9002]]
