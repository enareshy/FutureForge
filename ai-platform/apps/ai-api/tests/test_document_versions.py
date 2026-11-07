"""Document versioning, metadata updates, and metadata-based search filters.

Covers the RC-2 Step 2 gaps: documents expose a version, metadata can be updated
without touching content, version history is metadata-only, and product /
part_number / revision filters work on the allowed metadata allowlist.
"""

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
READ_ONLY = frozenset({"ai.knowledge:read"})


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


def _principal(
    username: str = "tester",
    permissions: frozenset[str] = POWER_USER,
    tenant_id: int = TENANT,
) -> Principal:
    return Principal(
        user_id=username,
        username=username,
        tenant_id=tenant_id,
        permissions=permissions,
    )


def _ingest(
    client: TestClient, code: str, documents: list[dict], *, tenant_id: int | None = None
) -> dict:
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


def _only_document(repository: InMemoryAiRepository, tenant_id: int = TENANT) -> dict:
    return next(d for d in repository._documents if d["tenant_id"] == tenant_id)


def test_ingested_document_starts_at_version_one(repository) -> None:
    with _client(repository, _principal()) as client:
        source = _ingest(client, "ops", [{"external_id": "pump", "text": "pump"}])
        response = client.get(f"/api/v1/ai/knowledge/sources/{source['id']}/documents")

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["version"] == 1
    assert item["metadata"] == {}


def test_reindex_bumps_version_and_records_history(repository) -> None:
    with _client(repository, _principal()) as client:
        source = _ingest(client, "ops", [{"external_id": "pump", "text": "pump"}])
        before = _only_document(repository)
        response = client.post(
            f"/api/v1/ai/knowledge/sources/{source['id']}/reindex"
        )
        assert response.status_code == 200
        after = _only_document(repository)
        versions = client.get(
            f"/api/v1/ai/knowledge/documents/{after['id']}/versions"
        )

    assert after["version"] == 2
    assert after["id"] != before["id"]
    assert versions.status_code == 200
    body = versions.json()
    assert body["meta"]["total"] == 1
    assert body["items"][0]["version"] == 1
    assert body["items"][0]["reason"] == "superseded"


def test_patch_updates_title_and_metadata_without_touching_content(repository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump lubrication"}])
        document = _only_document(repository)
        chunk_count = len(repository._chunks)
        response = client.patch(
            f"/api/v1/ai/knowledge/documents/{document['id']}",
            json={
                "title": "Pump Manual",
                "metadata": {"product": "P-100", "revision": "B"},
                "expected_version": 1,
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Pump Manual"
    assert body["metadata"] == {"product": "P-100", "revision": "B"}
    assert body["version"] == 2
    assert len(repository._chunks) == chunk_count


def test_patch_rejects_stale_expected_version(repository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump"}])
        document = _only_document(repository)
        response = client.patch(
            f"/api/v1/ai/knowledge/documents/{document['id']}",
            json={"title": "new", "expected_version": 99},
        )

    assert response.status_code == 409


def test_metadata_update_requires_write_capability(repository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump"}])
        document = _only_document(repository)

    with _client(repository, _principal("reader", READ_ONLY)) as reader:
        response = reader.patch(
            f"/api/v1/ai/knowledge/documents/{document['id']}",
            json={"title": "hijack"},
        )

    assert response.status_code == 403


def test_document_get_is_authorization_filtered(repository) -> None:
    with _client(repository, _principal("admin")) as admin:
        _ingest(
            admin,
            "ops",
            [
                {
                    "external_id": "secret-pump",
                    "text": "restricted pump",
                    "acl": {"users": ["m.okonkwo"]},
                }
            ],
        )
        document = _only_document(repository)

    with _client(repository, _principal("stranger", READ_ONLY)) as stranger:
        response = stranger.get(f"/api/v1/ai/knowledge/documents/{document['id']}")

    assert response.status_code == 403


def test_document_get_does_not_cross_tenants(repository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump"}])
        document = _only_document(repository)

    with _client(repository, _principal(tenant_id=2)) as other:
        response = other.get(f"/api/v1/ai/knowledge/documents/{document['id']}")

    assert response.status_code == 404


def test_version_history_is_metadata_only(repository) -> None:
    """Superseded versions must never retain chunk text."""
    with _client(repository, _principal()) as client:
        _ingest(
            client, "ops", [{"external_id": "pump", "text": "confidential pump text"}]
        )
        document = _only_document(repository)
        client.patch(
            f"/api/v1/ai/knowledge/documents/{document['id']}",
            json={"title": "Pump"},
        )

    for version in repository._document_versions:
        assert "confidential pump text" not in str(version)
        assert "content" not in version


def test_delete_records_a_deleted_version(repository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "ops", [{"external_id": "pump", "text": "pump"}])
        document = _only_document(repository)
        response = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")

    assert response.status_code == 204
    assert repository._document_versions
    assert repository._document_versions[0]["reason"] == "deleted"


def test_document_reindex_endpoint_rebuilds_one_document(repository) -> None:
    with _client(repository, _principal()) as client:
        source = _ingest(
            client,
            "ops",
            [
                {"external_id": "pump", "text": "pump lubrication"},
                {"external_id": "valve", "text": "valve seating"},
            ],
        )
        target = next(
            d for d in repository._documents if d["external_id"] == "pump"
        )
        before_version = target["version"]
        response = client.post(
            f"/api/v1/ai/knowledge/documents/{target['id']}/reindex"
        )
        pump = next(
            d
            for d in repository._documents
            if d["source_id"] == source["id"] and d["external_id"] == "pump"
        )

    assert response.status_code == 200
    assert response.json()["documents"] == 1
    assert pump["version"] == before_version + 1


def test_product_filter_narrows_search_results(repository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(
            client,
            "catalog",
            [
                {
                    "external_id": "pump",
                    "text": "pump lubrication procedure",
                    "metadata": {"product": "P-100", "revision": "A"},
                },
                {
                    "external_id": "valve",
                    "text": "valve lubrication procedure",
                    "metadata": {"product": "V-200", "revision": "A"},
                },
            ],
        )
        response = client.post(
            "/api/v1/ai/search",
            json={
                "query": "lubrication procedure",
                "mode": "semantic",
                "filters": [
                    {"field": "product", "op": "eq", "value": "P-100"},
                ],
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert {r["external_id"] for r in body["results"]} == {"pump"}


def test_metadata_filters_reject_unknown_fields(repository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "catalog", [{"external_id": "pump", "text": "pump"}])
        response = client.post(
            "/api/v1/ai/search",
            json={
                "query": "pump",
                "filters": [{"field": "secret_field", "op": "eq", "value": "x"}],
            },
        )

    assert response.status_code == 422


def test_metadata_filters_never_widen_authorized_scope(repository) -> None:
    """A metadata filter must not surface a document the caller cannot see."""
    with _client(repository, _principal("admin")) as admin:
        _ingest(
            admin,
            "catalog",
            [
                {
                    "external_id": "secret",
                    "text": "pump lubrication",
                    "metadata": {"product": "P-100"},
                    "acl": {"users": ["m.okonkwo"]},
                }
            ],
        )

    with _client(repository, _principal("stranger", RETRIEVAL_ONLY)) as stranger:
        response = stranger.post(
            "/api/v1/ai/search",
            json={
                "query": "pump lubrication",
                "filters": [{"field": "product", "op": "eq", "value": "P-100"}],
            },
        )

    assert response.status_code == 200
    assert response.json()["total"] == 0


def test_search_writes_an_audit_event(repository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "catalog", [{"external_id": "pump", "text": "pump"}])
        client.post(
            "/api/v1/ai/search",
            json={"query": "pump", "filters": [{"field": "product", "op": "eq", "value": "P-1"}]},
        )

    actions = [entry["action"] for entry in repository._audit]
    assert "ai.search.query" in actions


def test_metadata_update_is_reflected_in_search_and_rag(repository) -> None:
    """End-to-end: a metadata update changes what a filter retrieves."""
    with _client(repository, _principal()) as client:
        _ingest(
            client,
            "catalog",
            [
                {
                    "external_id": "pump",
                    "text": "pump lubrication interval",
                    "metadata": {"product": "P-100", "revision": "A"},
                }
            ],
        )
        document = _only_document(repository)

        first = client.post(
            "/api/v1/ai/rag/query",
            json={
                "query": "pump lubrication interval",
                "filters": [{"field": "product", "op": "eq", "value": "P-100"}],
            },
        )
        assert first.status_code == 200
        assert first.json()["insufficient_evidence"] is False
        assert first.json()["citations"]

        patch = client.patch(
            f"/api/v1/ai/knowledge/documents/{document['id']}",
            json={"metadata": {"product": "P-200", "revision": "B"}},
        )
        assert patch.status_code == 200

        stale = client.post(
            "/api/v1/ai/rag/query",
            json={
                "query": "pump lubrication interval",
                "filters": [{"field": "product", "op": "eq", "value": "P-100"}],
            },
        )
        fresh = client.post(
            "/api/v1/ai/rag/query",
            json={
                "query": "pump lubrication interval",
                "filters": [{"field": "product", "op": "eq", "value": "P-200"}],
            },
        )

    assert stale.json()["insufficient_evidence"] is True
    assert stale.json()["citations"] == []
    assert fresh.json()["insufficient_evidence"] is False
    assert fresh.json()["citations"]


def test_unauthorized_user_cannot_read_versions(repository) -> None:
    with _client(repository, _principal("admin")) as admin:
        _ingest(
            admin,
            "catalog",
            [
                {
                    "external_id": "secret",
                    "text": "secret pump",
                    "acl": {"users": ["m.okonkwo"]},
                }
            ],
        )
        document = _only_document(repository)
        admin.patch(
            f"/api/v1/ai/knowledge/documents/{document['id']}",
            json={"title": "Secret Rev B"},
        )

    with _client(repository, _principal("stranger", READ_ONLY)) as stranger:
        response = stranger.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/versions"
        )

    assert response.status_code == 403
