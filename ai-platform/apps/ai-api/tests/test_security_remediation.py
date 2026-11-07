from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_object_storage, get_principal
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
POWER_USER = frozenset({"*:*"})

WORKFLOW_DEFINITION = {
    "system_instructions": "Answer using authorized knowledge only.",
    "tools": ["knowledge.search"],
    "steps": [
        {
            "key": "search",
            "sequence": 1,
            "tool": "knowledge.search",
            "depends_on": [],
        }
    ],
    "limits": {"max_steps": 5, "max_tool_calls": 5, "max_elapsed_seconds": 120},
}


class MemoryStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    async def put(
        self, object_key: str, data: bytes, *, content_type: str | None = None
    ) -> None:
        self.objects[object_key] = data

    async def get(self, object_key: str) -> bytes | None:
        return self.objects.get(object_key)

    async def delete(self, object_key: str) -> None:
        self.objects.pop(object_key, None)


@contextmanager
def _client(
    repository: InMemoryAiRepository,
    principal: Principal,
    storage: MemoryStorage | None = None,
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal
    if storage is not None:
        app.dependency_overrides[get_object_storage] = lambda: storage
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


def _principal(
    permissions: frozenset[str] = POWER_USER,
    *,
    roles: frozenset[str] = frozenset(),
) -> Principal:
    return Principal(
        user_id="tester",
        username="tester",
        tenant_id=TENANT,
        permissions=permissions,
        roles=roles,
    )


def _seed_document(
    repository: InMemoryAiRepository,
    *,
    object_key: str,
    classification: str = "internal",
    acl: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return asyncio.run(
        repository.create_or_replace_document(
            TENANT,
            {
                "source_id": 1,
                "external_id": "doc-1",
                "title": "doc-1",
                "mime_type": "text/plain",
                "object_key": object_key,
                "classification": classification,
                "acl": acl or {},
            },
        )
    )


def test_download_enforces_document_acl(
    repository: InMemoryAiRepository,
) -> None:
    storage = MemoryStorage()
    storage.objects["docs/secret.txt"] = b"top secret"
    document = _seed_document(
        repository, object_key="docs/secret.txt", acl={"roles": ["knowledge-admin"]}
    )

    denied = _principal(frozenset({"ai.knowledge:read"}))
    with _client(repository, denied, storage) as client:
        response = client.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/download"
        )
    assert response.status_code == 403

    allowed = _principal(
        frozenset({"ai.knowledge:read"}), roles=frozenset({"knowledge-admin"})
    )
    with _client(repository, allowed, storage) as client:
        response = client.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/download"
        )
    assert response.status_code == 200
    assert response.content == b"top secret"


def test_download_enforces_classification_ceiling(
    repository: InMemoryAiRepository,
) -> None:
    storage = MemoryStorage()
    storage.objects["docs/confidential.txt"] = b"confidential"
    document = _seed_document(
        repository, object_key="docs/confidential.txt", classification="confidential"
    )

    principal = _principal(frozenset({"ai.knowledge:read"}))
    with _client(repository, principal, storage) as client:
        response = client.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/download"
        )
    assert response.status_code == 403


def _create_source(
    client: TestClient,
    *,
    code: str,
    classification: str = "internal",
    acl: dict[str, Any] | None = None,
) -> dict[str, Any]:
    response = client.post(
        "/api/v1/ai/knowledge/sources",
        json={
            "code": code,
            "name": code,
            "kind": "manual",
            "classification": classification,
            "acl": acl or {},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _ingest(
    client: TestClient, source_id: int, document: dict[str, Any]
) -> Any:
    return client.post(
        f"/api/v1/ai/knowledge/sources/{source_id}/ingest",
        json={"documents": [document]},
    )


def _chunks(
    repository: InMemoryAiRepository, source_id: int
) -> list[dict[str, Any]]:
    return asyncio.run(repository.list_source_chunks(TENANT, source_id))


def test_ingestion_cannot_downgrade_source_classification(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(
            client, code="policy", classification="confidential"
        )
        response = _ingest(
            client,
            source["id"],
            {
                "external_id": "downgrade",
                "title": "downgrade",
                "text": "restricted operational detail",
                "classification": "public",
            },
        )
        assert response.status_code == 202, response.text

    chunks = _chunks(repository, source["id"])
    assert chunks
    assert {chunk["classification"] for chunk in chunks} == {"confidential"}


def test_ingestion_inherits_source_acl(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(
            client, code="ops", acl={"roles": ["ops-team"]}
        )
        response = _ingest(
            client,
            source["id"],
            {
                "external_id": "acl-inherit",
                "title": "acl-inherit",
                "text": "operations runbook",
            },
        )
        assert response.status_code == 202, response.text

    chunks = _chunks(repository, source["id"])
    assert chunks
    assert {str(chunk["acl"]) for chunk in chunks} == {str({"roles": ["ops-team"]})}


def test_ingestion_rejects_acl_that_replaces_source_acl(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(
            client, code="finance", acl={"roles": ["finance-team"]}
        )
        response = _ingest(
            client,
            source["id"],
            {
                "external_id": "acl-broaden",
                "title": "acl-broaden",
                "text": "finance detail",
                "acl": {"roles": ["everyone"]},
            },
        )
    assert response.status_code == 422


def test_ingestion_enforces_caller_ceiling(
    repository: InMemoryAiRepository,
) -> None:
    limited = _principal(
        frozenset({"ai.knowledge:create", "ai.knowledge:execute"})
    )
    with _client(repository, limited) as client:
        source = _create_source(
            client, code="secret", classification="confidential"
        )
        response = _ingest(
            client,
            source["id"],
            {
                "external_id": "ceiling",
                "title": "ceiling",
                "text": "confidential detail",
            },
        )
    assert response.status_code == 403


def test_legacy_execute_rejects_client_approvals(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = client.get("/api/v1/ai/agents").json()[0]
        response = client.post(
            f"/api/v1/ai/agents/{agent['id']}/execute",
            json={"input": "hello", "approvals": ["knowledge.search"]},
        )
    assert response.status_code == 422


def test_legacy_execute_rejects_workflow_agents(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        created = client.post(
            "/api/v1/ai/agents",
            json={
                "code": "workflow",
                "name": "Workflow",
                "description": "Stage 6 workflow agent",
                "category": "knowledge",
                "definition": WORKFLOW_DEFINITION,
            },
        )
        assert created.status_code == 201, created.text
        agent = created.json()
        published = client.post(
            f"/api/v1/ai/agents/{agent['id']}/publish",
            json={"version_id": agent["current_version"]["id"]},
        )
        assert published.status_code == 200, published.text

        response = client.post(
            f"/api/v1/ai/agents/{agent['id']}/execute",
            json={"input": "hello"},
        )
    assert response.status_code == 503
    assert response.json()["error"]["details"]["endpoint"] == "/agent-executions"
