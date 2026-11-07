"""Stage 4 Phase 5: duplicate/conflict detection.

Detection is advisory: it records findings for review and never merges or
deletes documents. Rescans are idempotent, and reviewed findings stay reviewed.
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


def _principal(name: str = "admin", tenant_id: int = 1) -> Principal:
    return Principal(
        user_id=name,
        username=name,
        tenant_id=tenant_id,
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


def test_scan_detects_identical_content_as_duplicate(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "copy-a", [{"external_id": "a1", "text": "identical body"}])
        _ingest(client, "copy-b", [{"external_id": "b1", "text": "identical body"}])
        body = client.post("/api/v1/ai/knowledge/duplicates/scan").json()

    assert body["documents_scanned"] == 2
    assert body["findings"] == 1
    assert body["created"] == 1
    assert body["by_kind"] == {"duplicate": 1}

    with _client(repository, _principal()) as client:
        page = client.get("/api/v1/ai/knowledge/duplicates").json()
    finding = page["items"][0]
    assert finding["kind"] == "duplicate"
    assert finding["match_type"] == "checksum"
    assert finding["confidence"] == 1.0
    assert finding["status"] == "open"


def test_scan_detects_same_identifier_different_content_as_conflict(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "spec-a", [{"external_id": "SPEC-9", "text": "revision one"}])
        _ingest(client, "spec-b", [{"external_id": "SPEC-9", "text": "revision two"}])
        client.post("/api/v1/ai/knowledge/duplicates/scan")
        finding = client.get("/api/v1/ai/knowledge/duplicates").json()["items"][0]

    assert finding["kind"] == "conflict"
    assert finding["match_type"] == "external_id"
    assert finding["confidence"] == 0.9


def test_scan_detects_normalized_title_match(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(
            client,
            "titles",
            [
                {"external_id": "t1", "title": "Pump Manual", "text": "alpha body"},
                {"external_id": "t2", "title": "pump   manual", "text": "beta body"},
            ],
        )
        client.post("/api/v1/ai/knowledge/duplicates/scan")
        finding = client.get("/api/v1/ai/knowledge/duplicates").json()["items"][0]

    assert finding["kind"] == "duplicate"
    assert finding["match_type"] == "title"
    assert finding["confidence"] == 0.6


def test_rescan_is_idempotent_and_keeps_documents(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "c1", [{"external_id": "x1", "text": "same text"}])
        _ingest(client, "c2", [{"external_id": "x2", "text": "same text"}])
        first = client.post("/api/v1/ai/knowledge/duplicates/scan").json()
        second = client.post("/api/v1/ai/knowledge/duplicates/scan").json()
        total = client.get("/api/v1/ai/knowledge/duplicates").json()["meta"]["total"]

    assert first["created"] == 1
    assert second["created"] == 0
    assert second["updated"] == 1
    assert total == 1
    # Detection never merges or deletes content.
    assert len(repository._documents) == 2


def test_reviewed_finding_stays_reviewed_across_rescan(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "d1", [{"external_id": "y1", "text": "dup body"}])
        _ingest(client, "d2", [{"external_id": "y2", "text": "dup body"}])
        client.post("/api/v1/ai/knowledge/duplicates/scan")
        finding_id = client.get("/api/v1/ai/knowledge/duplicates").json()["items"][0]["id"]

        reviewed = client.post(
            f"/api/v1/ai/knowledge/duplicates/{finding_id}/review",
            json={"status": "dismissed", "note": "known copies"},
        )
        assert reviewed.status_code == 200
        assert reviewed.json()["status"] == "dismissed"
        assert reviewed.json()["note"] == "known copies"

        rescan = client.post("/api/v1/ai/knowledge/duplicates/scan").json()
        assert rescan["skipped"] == 1

        still = client.get(f"/api/v1/ai/knowledge/duplicates/{finding_id}").json()
        assert still["status"] == "dismissed"


def test_duplicate_findings_are_tenant_scoped(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("t1", tenant_id=1)) as tenant1:
        _ingest(tenant1, "e1", [{"external_id": "z1", "text": "tenant one"}])
        _ingest(tenant1, "e2", [{"external_id": "z2", "text": "tenant one"}])
        tenant1.post("/api/v1/ai/knowledge/duplicates/scan")
        assert tenant1.get("/api/v1/ai/knowledge/duplicates").json()["meta"]["total"] == 1

    with _client(repository, _principal("t2", tenant_id=2)) as tenant2:
        assert tenant2.get("/api/v1/ai/knowledge/duplicates").json()["meta"]["total"] == 0


def test_invalid_review_status_is_rejected(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        _ingest(client, "f1", [{"external_id": "q1", "text": "body"}])
        _ingest(client, "f2", [{"external_id": "q2", "text": "body"}])
        client.post("/api/v1/ai/knowledge/duplicates/scan")
        finding_id = client.get("/api/v1/ai/knowledge/duplicates").json()["items"][0]["id"]
        response = client.post(
            f"/api/v1/ai/knowledge/duplicates/{finding_id}/review",
            json={"status": "open"},
        )
    assert response.status_code == 422
