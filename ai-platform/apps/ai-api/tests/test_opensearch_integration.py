"""Real OpenSearch integration tests (Phase 4).

These tests are opt-in and only run against a dedicated, non-production cluster:

    AI_TEST_OPENSEARCH=1 OPENSEARCH_URL=http://127.0.0.1:9200 \
        pytest -o addopts="" -m integration tests/test_opensearch_integration.py

When ``AI_TEST_OPENSEARCH=1`` is set but the dependency is missing or the cluster
is unreachable, the suite fails instead of silently skipping. Each test uses a
unique ``ai-itest-<uuid>`` index prefix and deletes only that index afterwards.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal, get_search_backend
from ai_api.config.settings import Settings
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.infrastructure.search.opensearch import OpenSearchBackend
from ai_api.main import create_app
from ai_api.security.policies import Principal

pytestmark = pytest.mark.integration

TENANT = 1
POWER_USER = frozenset({"*:*"})
RETRIEVAL_ONLY = frozenset({"ai.retrieval:execute"})


def _enabled() -> bool:
    return os.environ.get("AI_TEST_OPENSEARCH", "") == "1"


@pytest.fixture(scope="session", autouse=True)
def _require_cluster() -> None:
    if not _enabled():
        pytest.skip("set AI_TEST_OPENSEARCH=1 to run real OpenSearch integration tests")
    try:
        import opensearchpy  # noqa: F401, PLC0415
    except ImportError as exc:  # pragma: no cover - depends on environment
        pytest.fail(f"AI_TEST_OPENSEARCH=1 but opensearch-py is not installed: {exc}")

    settings = Settings()
    backend = OpenSearchBackend(settings)

    async def probe() -> None:
        client = backend._ensure_client()
        await client.info()

    try:
        asyncio.run(probe())
    except Exception as exc:  # noqa: BLE001 - explicit failure, never a silent skip
        pytest.fail(
            "AI_TEST_OPENSEARCH=1 but the cluster is unreachable at "
            f"{settings.opensearch_url}: {exc}"
        )


@pytest.fixture()
def backend() -> Iterator[OpenSearchBackend]:
    prefix = f"ai-itest-{uuid.uuid4().hex[:12]}"
    settings = Settings(opensearch_index_prefix=prefix)
    instance = OpenSearchBackend(settings)

    try:
        yield instance
    finally:
        try:
            client = _sync_client(instance)
            if client.indices.exists(index=instance._index):
                client.indices.delete(index=instance._index)
            client.close()
        except Exception:  # noqa: BLE001 - best-effort cleanup of the test index
            pass


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


@contextmanager
def _client(
    repository: InMemoryAiRepository,
    principal: Principal,
    search_backend: OpenSearchBackend,
    *,
    raise_server_exceptions: bool = True,
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    # TestClient owns its event loop; the async OpenSearch client caches an
    # aiohttp session bound to that loop, so force a fresh client per request
    # loop instead of reusing one across closed loops.
    search_backend._client = None
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal
    app.dependency_overrides[get_search_backend] = lambda: search_backend
    try:
        with TestClient(app, raise_server_exceptions=raise_server_exceptions) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _principal(
    username: str = "admin",
    *,
    tenant_id: int = TENANT,
    permissions: frozenset[str] = POWER_USER,
    roles: frozenset[str] = frozenset(),
) -> Principal:
    return Principal(
        user_id=username,
        username=username,
        tenant_id=tenant_id,
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


def _search(client: TestClient, query: str, mode: str = "lexical") -> dict:
    response = client.post(
        "/api/v1/ai/search", json={"query": query, "mode": mode}
    )
    assert response.status_code == 200
    return response.json()


def _sync_client(backend: OpenSearchBackend):
    from opensearchpy import OpenSearch  # noqa: PLC0415 - optional dependency

    settings = backend._settings
    auth = None
    if settings.opensearch_username:
        auth = (
            settings.opensearch_username,
            settings.opensearch_password.get_secret_value(),
        )
    return OpenSearch(
        hosts=[settings.opensearch_url],
        http_auth=auth,
        verify_certs=not settings.opensearch_insecure,
        ssl_show_warn=False,
        timeout=settings.opensearch_timeout_seconds,
    )


def _raw_search(backend: OpenSearchBackend, body: dict) -> dict:
    client = _sync_client(backend)
    try:
        return client.search(index=backend._index, body=body)
    finally:
        client.close()


def _raw_index(backend: OpenSearchBackend, body: dict, doc_id: str) -> None:
    client = _sync_client(backend)
    try:
        client.index(index=backend._index, id=doc_id, body=body, refresh=True)
    finally:
        client.close()


def _raw_chunk(backend: OpenSearchBackend, token: str) -> dict:
    _raw_refresh(backend)
    response = _raw_search(
        backend, {"size": 1, "query": {"term": {"content": token}}}
    )
    hits = response["hits"]["hits"]
    assert hits, f"no indexed chunk matched {token!r}"
    return hits[0]["_source"]


def _raw_refresh(backend: OpenSearchBackend) -> None:
    client = _sync_client(backend)
    try:
        client.indices.refresh(index=backend._index)
    finally:
        client.close()


def _raw_count(backend: OpenSearchBackend, field: str, value: object) -> int:
    _raw_refresh(backend)
    response = _raw_search(
        backend,
        {
            "size": 0,
            "query": {"bool": {"filter": [{"term": {field: value}}]}},
        },
    )
    return int(response["hits"]["total"]["value"])


def test_c1_index_and_search_returns_authoritative_content(
    repository: InMemoryAiRepository, backend: OpenSearchBackend
) -> None:
    token = f"pumptoken{uuid.uuid4().hex[:8]}"
    with _client(repository, _principal(), backend) as client:
        _ingest(
            client,
            "ops",
            [
                {
                    "external_id": "pump",
                    "title": "Pump maintenance",
                    "text": f"{token} requires quarterly lubrication",
                }
            ],
        )
        result = _search(client, token)
        assert result["count"] == 1
        assert result["mode"] == "lexical"
        assert token in result["results"][0]["content"]
        assert result["results"][0]["title"] == "Pump maintenance"

        rag = client.post("/api/v1/ai/rag/query", json={"query": token}).json()

    assert _raw_count(backend, "content", token) >= 1
    assert rag["insufficient_evidence"] is False
    assert any(token in citation["snippet"] for citation in rag["citations"])


def test_c2_document_delete_removes_index_and_retrieval(
    repository: InMemoryAiRepository, backend: OpenSearchBackend
) -> None:
    token = f"deletetoken{uuid.uuid4().hex[:8]}"
    with _client(repository, _principal(), backend) as client:
        _ingest(
            client,
            "ops",
            [{"external_id": "pump", "text": f"{token} pump lubrication"}],
        )
        assert _search(client, token)["count"] == 1
        document_id = repository._documents[0]["id"]
        assert _raw_count(backend, "document_id", document_id) == 1

        deleted = client.delete(f"/api/v1/ai/knowledge/documents/{document_id}")
        assert deleted.status_code == 204

        assert _search(client, token)["count"] == 0
        rag = client.post("/api/v1/ai/rag/query", json={"query": token}).json()
        assert rag["insufficient_evidence"] is True
        assert rag["citations"] == []
        assert client.delete(
            f"/api/v1/ai/knowledge/documents/{document_id}"
        ).status_code == 404

    assert _raw_count(backend, "content", token) == 0


def test_c3_reindex_replaces_chunks_by_stable_identity(
    repository: InMemoryAiRepository, backend: OpenSearchBackend
) -> None:
    token = f"reindextoken{uuid.uuid4().hex[:8]}"
    with _client(repository, _principal(), backend) as client:
        source = _ingest(
            client, "ops", [{"external_id": "pump", "text": f"{token} lubrication"}]
        )
        old_chunk_id = repository._chunks[0]["id"]
        old_document_id = repository._documents[0]["id"]

        for _ in range(2):
            response = client.post(
                f"/api/v1/ai/knowledge/sources/{source['id']}/reindex"
            )
            assert response.status_code == 200

        current_chunk_id = repository._chunks[0]["id"]
        assert current_chunk_id != old_chunk_id
        assert repository._documents[0]["id"] != old_document_id
        result = _search(client, token)
        assert result["count"] == 1
        assert result["results"][0]["chunk_id"] == current_chunk_id

    assert _raw_count(backend, "content", token) == 1
    assert _raw_count(backend, "chunk_id", current_chunk_id) == 1
    assert _raw_count(backend, "chunk_id", old_chunk_id) == 0
    assert _raw_count(backend, "document_id", old_document_id) == 0


def test_c4_tenant_isolation_for_search_delete_and_reindex(
    repository: InMemoryAiRepository, backend: OpenSearchBackend
) -> None:
    token_one = f"tenantone{uuid.uuid4().hex[:8]}"
    token_two = f"tenanttwo{uuid.uuid4().hex[:8]}"
    with _client(repository, _principal("admin", tenant_id=1), backend) as one:
        source_one = _ingest(
            one, "shared", [{"external_id": "shared", "text": token_one}]
        )
    with _client(repository, _principal("admin", tenant_id=2), backend) as two:
        source_two = _ingest(
            two, "shared", [{"external_id": "shared", "text": token_two}]
        )
        doc_two = repository._documents[1]["id"]

    with _client(repository, _principal("alice", tenant_id=1), backend) as one:
        result = _search(one, token_one)
        assert result["count"] == 1
        assert token_one in result["results"][0]["content"]
        assert _search(one, token_two)["count"] == 0
        assert one.delete(
            f"/api/v1/ai/knowledge/documents/{doc_two}"
        ).status_code == 404
        assert one.post(
            f"/api/v1/ai/knowledge/sources/{source_two['id']}/reindex"
        ).status_code == 404
        assert one.delete(
            f"/api/v1/ai/knowledge/sources/{source_two['id']}"
        ).status_code == 404

    with _client(repository, _principal("bob", tenant_id=2), backend) as two:
        assert _search(two, token_two)["count"] == 1
        assert _search(two, token_one)["count"] == 0

    assert _raw_count(backend, "tenant_id", 1) == 1
    assert _raw_count(backend, "tenant_id", 2) == 1
    assert source_one["id"] != source_two["id"]


def test_c5_stale_index_labels_cannot_authorize_retrieval(
    repository: InMemoryAiRepository, backend: OpenSearchBackend
) -> None:
    token = f"acltoken{uuid.uuid4().hex[:8]}"
    with _client(repository, _principal("admin"), backend) as client:
        _ingest(
            client,
            "ops",
            [
                {
                    "external_id": "pump",
                    "text": f"{token} lubrication",
                    "acl": {"users": ["alice"]},
                }
            ],
        )

    alice = _principal("alice", permissions=RETRIEVAL_ONLY)
    with _client(repository, alice, backend) as client:
        assert _search(client, token)["count"] == 1

    repository._documents[0]["acl"] = {"users": ["bob"]}
    repository._chunks[0]["acl"] = {"users": ["bob"]}
    with _client(repository, alice, backend) as client:
        assert _search(client, token)["count"] == 0
    with _client(repository, _principal("bob", permissions=RETRIEVAL_ONLY), backend) as client:
        assert _search(client, token)["count"] == 1

    repository._documents[0]["classification"] = "restricted"
    with _client(repository, _principal("bob", permissions=RETRIEVAL_ONLY), backend) as client:
        assert _search(client, token)["count"] == 0

    repository._documents[0]["classification"] = "internal"
    repository._chunks[0]["classification"] = "internal"
    repository._documents[0]["acl"] = {"role": ["admin"]}
    repository._chunks[0]["acl"] = {"role": ["admin"]}
    with _client(repository, _principal("bob", permissions=RETRIEVAL_ONLY), backend) as client:
        assert _search(client, token)["count"] == 0

    assert _raw_count(backend, "content", token) == 1


def test_c6_disabled_and_deleted_sources_are_not_retrievable(
    repository: InMemoryAiRepository, backend: OpenSearchBackend
) -> None:
    token = f"sourcetoken{uuid.uuid4().hex[:8]}"
    with _client(repository, _principal(), backend) as client:
        source = _ingest(
            client, "ops", [{"external_id": "pump", "text": f"{token} lubrication"}]
        )
        assert _search(client, token)["count"] == 1

        repository._sources[0]["status"] = "disabled"
        assert _search(client, token)["count"] == 0
        assert _raw_count(backend, "content", token) == 1

        repository._sources[0]["status"] = "ready"
        assert _search(client, token)["count"] == 1

        assert client.delete(
            f"/api/v1/ai/knowledge/sources/{source['id']}"
        ).status_code == 204
        assert _search(client, token)["count"] == 0
        assert client.delete(
            f"/api/v1/ai/knowledge/sources/{source['id']}"
        ).status_code == 404

    assert _raw_count(backend, "source_id", source["id"]) == 0


class _DeleteRaisesOnceRepository(InMemoryAiRepository):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    async def delete_document(self, tenant_id: int, document_id: int) -> bool:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("database write failed after search delete")
        return await super().delete_document(tenant_id, document_id)


def test_d1_search_delete_succeeds_but_database_delete_fails_is_recoverable(
    backend: OpenSearchBackend,
) -> None:
    repository = _DeleteRaisesOnceRepository()
    token = f"recovertoken{uuid.uuid4().hex[:8]}"
    with _client(
        repository,
        _principal(),
        backend,
        raise_server_exceptions=False,
    ) as client:
        _ingest(
            client, "ops", [{"external_id": "pump", "text": f"{token} lubrication"}]
        )
        document_id = repository._documents[0]["id"]
        first = client.delete(f"/api/v1/ai/knowledge/documents/{document_id}")
        assert first.status_code == 500
        assert repository._documents[0]["id"] == document_id
        assert _raw_count(backend, "content", token) == 0

        second = client.delete(f"/api/v1/ai/knowledge/documents/{document_id}")
        assert second.status_code == 204

    assert repository._documents == []
    assert _raw_count(backend, "content", token) == 0


def test_f1_reconciliation_detects_and_purges_real_index_orphans(
    repository: InMemoryAiRepository, backend: OpenSearchBackend
) -> None:
    token = f"orphantoken{uuid.uuid4().hex[:8]}"
    with _client(repository, _principal(), backend) as client:
        source = _ingest(
            client, "ops", [{"external_id": "pump", "text": f"{token} lubrication"}]
        )
        _raw_index(
            backend,
            {
                "tenant_id": TENANT,
                "document_id": 9000002,
                "source_id": source["id"],
                "external_id": "orphan-doc",
                "chunk_id": 9000001,
                "chunk_index": 0,
                "content": f"orphan {token}",
                "classification": "internal",
                "acl": {},
                "document_status": "indexed",
            },
            doc_id=f"{TENANT}:9000001",
        )
        assert _raw_count(backend, "document_id", 9000002) == 1

        dry = client.post(
            "/api/v1/ai/knowledge/reconcile",
            json={"scan_orphans": True, "purge_orphans": False},
        ).json()
        assert dry["orphans_detected"] == 1
        assert dry["orphan_document_ids"] == [9000002]
        assert dry["orphans_deleted"] == 0
        assert _raw_count(backend, "document_id", 9000002) == 1

        report = client.post(
            "/api/v1/ai/knowledge/reconcile",
            json={"scan_orphans": True, "purge_orphans": True},
        ).json()
        assert report["orphans_detected"] == 1
        assert report["orphan_document_ids"] == [9000002]
        assert report["orphans_deleted"] == 1

        assert _raw_count(backend, "document_id", 9000002) == 0
        repeat = client.post(
            "/api/v1/ai/knowledge/reconcile",
            json={"scan_orphans": True, "purge_orphans": True},
        ).json()
        assert repeat["orphans_detected"] == 0
        assert repeat["orphans_deleted"] == 0


def test_c7_security_updates_are_enforced_while_the_index_is_stale(
    repository: InMemoryAiRepository, backend: OpenSearchBackend
) -> None:
    token = f"securitytoken{uuid.uuid4().hex[:8]}"
    with _client(repository, _principal(), backend) as client:
        source = _ingest(
            client,
            "ops",
            [
                {
                    "external_id": "pump",
                    "text": f"{token} lubrication",
                    "acl": {"users": ["alice"]},
                }
            ],
        )
        assert _search(client, token)["count"] == 1

        restricted = client.put(
            f"/api/v1/ai/knowledge/sources/{source['id']}/acl",
            json={"acl": {"users": ["bob"]}, "expected_version": 1},
        )
        assert restricted.status_code == 200, restricted.text

    # The search index still carries the old ACL; retrieval must ignore it.
    stale = _raw_chunk(backend, token)
    assert stale["acl"] == {"users": ["alice"]}
    assert stale["classification"] == "internal"

    alice = _principal("alice", permissions=RETRIEVAL_ONLY)
    with _client(repository, alice, backend) as client:
        assert _search(client, token)["count"] == 0
    with _client(
        repository,
        _principal("bob", permissions=RETRIEVAL_ONLY),
        backend,
    ) as client:
        assert _search(client, token)["count"] == 1

    with _client(repository, _principal(), backend) as client:
        raised = client.put(
            f"/api/v1/ai/knowledge/sources/{source['id']}/classification",
            json={"classification": "restricted", "expected_version": 2},
        )
        assert raised.status_code == 200, raised.text

    stale = _raw_chunk(backend, token)
    assert stale["classification"] == "internal"
    with _client(
        repository,
        _principal("bob", permissions=RETRIEVAL_ONLY),
        backend,
    ) as client:
        assert _search(client, token)["count"] == 0

    assert _raw_count(backend, "content", token) == 1


def test_c8_delayed_security_refresh_converges_without_restoring_stale_acl(
    repository: InMemoryAiRepository, backend: OpenSearchBackend
) -> None:
    token = f"convergetoken{uuid.uuid4().hex[:8]}"
    with _client(repository, _principal(), backend) as client:
        source = _ingest(
            client,
            "ops",
            [
                {
                    "external_id": "pump",
                    "text": f"{token} lubrication",
                    "acl": {"users": ["alice"]},
                }
            ],
        )
        updated = client.put(
            f"/api/v1/ai/knowledge/sources/{source['id']}/acl",
            json={"acl": {"users": ["bob"]}, "expected_version": 1},
        )
        assert updated.status_code == 200, updated.text

        jobs = [
            job
            for job in repository._jobs
            if str(job.get("idempotency_key", "")).startswith(
                f"source-security-{source['id']}-"
            )
        ]
        assert len(jobs) == 1
        processed = client.post(f"/api/v1/ai/knowledge/jobs/{jobs[0]['id']}/retry")
        assert processed.status_code == 200, processed.text
        assert processed.json()["status"] == "succeeded"

    refreshed = _raw_chunk(backend, token)
    assert refreshed["acl"] == {"users": ["bob"]}
    assert refreshed["classification"] == "internal"

    with _client(
        repository,
        _principal("bob", permissions=RETRIEVAL_ONLY),
        backend,
    ) as client:
        assert _search(client, token)["count"] == 1
    with _client(
        repository,
        _principal("alice", permissions=RETRIEVAL_ONLY),
        backend,
    ) as client:
        assert _search(client, token)["count"] == 0
