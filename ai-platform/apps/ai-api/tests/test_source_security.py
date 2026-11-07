"""Phase 5: knowledge-source ACL/classification management and enforcement."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import (
    get_ai_repository,
    get_object_storage,
    get_principal,
    get_search_backend,
)
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
POWER_USER = frozenset({"*:*"})
SECURITY_MANAGER = frozenset(
    {"ai.knowledge:read", "ai.knowledge:update", "ai.knowledge:create"}
)
RETRIEVAL = frozenset({"ai.retrieval:execute"})


class MemoryStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    async def get(self, object_key: str) -> bytes | None:
        return self.objects.get(object_key)


class _CandidateBackend:
    """Returns one live chunk candidate, simulating a stale external index."""

    name = "candidate"

    def __init__(self, repository: InMemoryAiRepository) -> None:
        self.repository = repository

    async def search(self, tenant_id: int, query: str, *, limit: int):
        if not self.repository._chunks:
            return []
        chunk = self.repository._chunks[0]
        return [
            {
                "chunk_id": chunk["id"],
                "document_id": chunk["document_id"],
                "source_id": 1,
                "chunk_index": chunk.get("chunk_index", 0),
                "content": "stale indexed content",
                "classification": "internal",
                "acl": {"users": ["stale-index-user"]},
                "title": "stale",
                "external_id": "stale",
                "document_status": "indexed",
                "source_code": "stale",
                "score": 1.0,
            }
        ]

    async def index_document(self, tenant_id: int, document: dict, chunks: list) -> None:
        return None

    async def delete_document(self, tenant_id: int, document_id: int, **kwargs: Any) -> None:
        return None

    async def delete_source(self, tenant_id: int, source_id: int) -> None:
        return None

    async def scan_documents(self, tenant_id: int, *, limit: int, after=None):
        return [], None

    async def delete_documents(self, tenant_id: int, document_ids: list[int]) -> None:
        return None

    async def status(self) -> dict:
        return {"backend": self.name, "available": True}


class _FailingEnqueueRepository(InMemoryAiRepository):
    def __init__(self) -> None:
        super().__init__()
        self.fail_security_enqueue = False

    async def create_job(self, tenant_id: int, data: dict[str, Any]):
        if self.fail_security_enqueue and str(data.get("idempotency_key", "")).startswith(
            "source-security-"
        ):
            raise RuntimeError("queue unavailable")
        return await super().create_job(tenant_id, data)


@contextmanager
def _client(
    repository: InMemoryAiRepository,
    principal: Principal,
    *,
    backend: Any | None = None,
    storage: Any | None = None,
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal
    if backend is not None:
        app.dependency_overrides[get_search_backend] = lambda: backend
    if storage is not None:
        app.dependency_overrides[get_object_storage] = lambda: storage
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _principal(
    name: str = "admin",
    permissions: frozenset[str] = POWER_USER,
    *,
    roles: frozenset[str] = frozenset(),
    tenant_id: int = TENANT,
    actor_id: int | None = None,
) -> Principal:
    return Principal(
        user_id=name,
        username=name,
        tenant_id=tenant_id,
        actor_id=actor_id,
        permissions=permissions,
        roles=roles,
    )


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


def _create_source(
    client: TestClient,
    *,
    code: str = "ops",
    acl: dict[str, Any] | None = None,
    classification: str = "internal",
) -> dict[str, Any]:
    response = client.post(
        "/api/v1/ai/knowledge/sources",
        json={
            "code": code,
            "name": code,
            "kind": "manual",
            "acl": acl or {},
            "classification": classification,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _ingest(
    client: TestClient,
    source_id: int,
    *,
    text: str = "secret pump lubrication",
    acl: dict[str, Any] | None = None,
) -> None:
    response = client.post(
        f"/api/v1/ai/knowledge/sources/{source_id}/ingest",
        json={"documents": [{"external_id": "pump", "text": text, "acl": acl or {}}]},
    )
    assert response.status_code == 202, response.text
    assert response.json()["job"]["status"] == "succeeded"


def _update_acl(
    client: TestClient,
    source_id: int,
    acl: dict[str, Any],
    *,
    version: int,
):
    return client.put(
        f"/api/v1/ai/knowledge/sources/{source_id}/acl",
        json={"acl": acl, "expected_version": version},
    )


def _update_classification(
    client: TestClient, source_id: int, classification: str, *, version: int
):
    return client.put(
        f"/api/v1/ai/knowledge/sources/{source_id}/classification",
        json={"classification": classification, "expected_version": version},
    )


def test_source_read_includes_security_state_and_is_tenant_scoped(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(client, acl={"users": ["alice"]})
        fetched = client.get(f"/api/v1/ai/knowledge/sources/{source['id']}")
        assert fetched.status_code == 200
        body = fetched.json()
        assert body["acl"] == {"users": ["alice"]}
        assert body["classification"] == "internal"
        assert body["version"] == 1

    with _client(repository, _principal("other", tenant_id=2)) as other:
        assert other.get(
            f"/api/v1/ai/knowledge/sources/{source['id']}"
        ).status_code == 404
        assert _update_acl(
            other, source["id"], {"users": ["other"]}, version=1
        ).status_code == 404


def test_accepted_acl_and_classification_updates_are_audited(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal(actor_id=7)) as client:
        source = _create_source(client)
        acl = _update_acl(
            client, source["id"], {"roles": ["knowledge-admin"]}, version=1
        )
        assert acl.status_code == 200, acl.text
        assert acl.json()["version"] == 2
        assert acl.json()["acl"] == {"roles": ["knowledge-admin"]}

        classification = _update_classification(
            client, source["id"], "confidential", version=2
        )
        assert classification.status_code == 200, classification.text
        assert classification.json()["version"] == 3
        assert classification.json()["classification"] == "confidential"

    events = [row for row in repository._audit if row["tenant_id"] == TENANT]
    acl_event = next(e for e in events if e["action"] == "ai.knowledge_source.acl_update")
    class_event = next(
        e for e in events if e["action"] == "ai.knowledge_source.classification_update"
    )
    assert acl_event["actor_id"] == 7
    assert acl_event["detail"]["acl"] == {"roles": ["knowledge-admin"]}
    assert class_event["detail"] == {
        "source_id": source["id"],
        "version": 3,
        "from": "internal",
        "to": "confidential",
    }


def test_security_updates_require_the_security_capability(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as admin:
        source = _create_source(admin)

    reader = _principal("reader", frozenset({"ai.knowledge:read"}))
    with _client(repository, reader) as client:
        assert _update_acl(
            client, source["id"], {"users": ["reader"]}, version=1
        ).status_code == 403
        assert _update_classification(
            client, source["id"], "confidential", version=1
        ).status_code == 403
        current = client.get(f"/api/v1/ai/knowledge/sources/{source['id']}").json()
    assert current["acl"] == {}
    assert current["classification"] == "internal"
    assert current["version"] == 1


def test_malformed_and_unknown_acls_are_rejected(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(client)
        for acl in (
            {"unknown": ["x"]},
            {"roles": "knowledge-admin"},
            {"users": [123]},
            {"users": [""]},
            {"deny_all": "yes"},
            {"deny_all": True, "users": ["alice"]},
        ):
            response = _update_acl(client, source["id"], acl, version=1)
            assert response.status_code == 422, (acl, response.text)
        current = client.get(f"/api/v1/ai/knowledge/sources/{source['id']}").json()
    assert current["acl"] == {}
    assert current["version"] == 1


def test_invalid_classification_is_rejected(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(client)
        response = _update_classification(
            client, source["id"], "top-secret", version=1
        )
        assert response.status_code == 422
        assert (
            client.get(f"/api/v1/ai/knowledge/sources/{source['id']}").json()[
                "classification"
            ]
            == "internal"
        )


def test_concurrent_updates_do_not_overwrite_newer_state(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(client)
        first = _update_acl(client, source["id"], {"users": ["alice"]}, version=1)
        assert first.status_code == 200
        stale = _update_acl(client, source["id"], {"users": ["bob"]}, version=1)
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == "conflict"
        current = client.get(f"/api/v1/ai/knowledge/sources/{source['id']}").json()
        assert current["acl"] == {"users": ["alice"]}
        assert current["version"] == 2


def test_identical_update_is_idempotent_even_with_a_stale_version(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(client)
        assert _update_acl(
            client, source["id"], {"users": ["alice"]}, version=1
        ).status_code == 200
        repeated = _update_acl(
            client, source["id"], {"users": ["alice"]}, version=1
        )
        assert repeated.status_code == 200
        assert repeated.json()["version"] == 2
        jobs = [j for j in repository._jobs if j.get("source_id") == source["id"]]
        assert len(jobs) == 1


def test_non_superuser_cannot_grant_beyond_their_authority(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as admin:
        source = _create_source(admin, acl={"users": ["someone-else"]})

    manager = _principal(
        "manager",
        SECURITY_MANAGER,
        roles=frozenset({"knowledge-admin"}),
        actor_id=12,
    )
    with _client(repository, manager) as client:
        # Granting a role the caller does not hold.
        assert _update_acl(
            client, source["id"], {"roles": ["platform-admin"]}, version=1
        ).status_code == 403
        # Granting a permission the caller does not hold.
        assert _update_acl(
            client, source["id"], {"permissions": ["ai.knowledge:execute"]}, version=1
        ).status_code == 403
        # Granting another user.
        assert _update_acl(
            client, source["id"], {"users": ["another-user"]}, version=1
        ).status_code == 403
        # Granting themselves access they did not have.
        assert _update_acl(
            client, source["id"], {"users": ["manager"]}, version=1
        ).status_code == 403
        # Removing deny_all is a broadening operation.
        repository._sources[0]["acl"] = {"deny_all": True}
        repository._sources[0]["version"] = 1
        assert _update_acl(
            client, source["id"], {"roles": ["knowledge-admin"]}, version=1
        ).status_code == 403

    denied = [
        row
        for row in repository._audit
        if row.get("action") == "ai.knowledge_source.acl_update"
        and row.get("outcome") == "denied"
    ]
    assert len(denied) >= 4
    assert all(row["actor_id"] == 12 for row in denied)


def test_superuser_can_grant_other_users_and_remove_deny_all(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(client, acl={"deny_all": True})
        updated = _update_acl(
            client, source["id"], {"users": ["bob"], "roles": ["ops"]}, version=1
        )
        assert updated.status_code == 200
        assert updated.json()["acl"] == {"roles": ["ops"], "users": ["bob"]}


def test_source_acl_restriction_is_immediate_for_search_rag_and_agent_tools(
    repository: InMemoryAiRepository,
) -> None:
    backend = _CandidateBackend(repository)
    with _client(repository, _principal()) as admin:
        source = _create_source(admin, acl={"users": ["alice"]})
        _ingest(admin, source["id"])

    alice = _principal("alice", RETRIEVAL | frozenset({"ai.knowledge:read"}))
    with _client(repository, alice, backend=backend) as client:
        assert client.post(
            "/api/v1/ai/search", json={"query": "pump", "mode": "lexical"}
        ).json()["count"] == 1

    with _client(repository, _principal()) as admin:
        restricted = _update_acl(
            admin, source["id"], {"users": ["bob"]}, version=1
        )
        assert restricted.status_code == 200

    with _client(repository, alice, backend=backend) as client:
        assert client.post(
            "/api/v1/ai/search", json={"query": "pump", "mode": "lexical"}
        ).json()["count"] == 0
        rag = client.post("/api/v1/ai/rag/query", json={"query": "pump"})
        assert rag.status_code == 200
        assert rag.json()["citations"] == []
        assert "stale indexed content" not in rag.text
    # A caller with agent capacity must still be denied at the retrieval layer.
    agent_user = _principal(
        "alice",
        RETRIEVAL
        | frozenset({"ai.knowledge:read", "ai.agents:read", "ai.agents:execute"}),
    )
    with _client(repository, agent_user, backend=backend) as client:
        agent = next(
            item for item in client.get("/api/v1/ai/agents").json()
            if item["code"] == "knowledge-assistant"
        )
        execution = client.post(
            f"/api/v1/ai/agents/{agent['id']}/execute", json={"input": "pump"}
        )
        assert execution.status_code == 200
        assert execution.json()["citations"] == []

    with _client(repository, _principal("bob", RETRIEVAL), backend=backend) as client:
        assert client.post(
            "/api/v1/ai/search", json={"query": "pump", "mode": "lexical"}
        ).json()["count"] == 1

    document = repository._documents[0]
    chunk = repository._chunks[0]
    assert document["acl"] == {"users": ["bob"]}
    assert chunk["acl"] == {"users": ["bob"]}


def test_acl_broadening_grants_access_before_reindex(
    repository: InMemoryAiRepository,
) -> None:
    backend = _CandidateBackend(repository)
    with _client(repository, _principal()) as admin:
        source = _create_source(admin, acl={"users": ["alice"]})
        _ingest(admin, source["id"])
        assert _update_acl(
            admin, source["id"], {"users": ["bob"]}, version=1
        ).status_code == 200

    bob = _principal("bob", RETRIEVAL)
    with _client(repository, bob, backend=backend) as client:
        body = client.post(
            "/api/v1/ai/search", json={"query": "pump", "mode": "lexical"}
        ).json()
        assert body["count"] == 1
        assert body["results"][0]["content"] == "secret pump lubrication"


def test_classification_increase_is_immediate_before_reindex(
    repository: InMemoryAiRepository,
) -> None:
    backend = _CandidateBackend(repository)
    with _client(repository, _principal()) as admin:
        source = _create_source(admin, acl={"users": ["alice"]})
        _ingest(admin, source["id"])
        assert _update_classification(
            admin, source["id"], "confidential", version=1
        ).status_code == 200

    alice = _principal("alice", RETRIEVAL)
    with _client(repository, alice, backend=backend) as client:
        assert client.post(
            "/api/v1/ai/search", json={"query": "pump", "mode": "lexical"}
        ).json()["count"] == 0
    assert repository._chunks[0]["classification"] == "internal"


def test_classification_downgrade_requires_superuser_and_is_audited(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as admin:
        source = _create_source(admin, classification="confidential")

    manager = _principal("manager", SECURITY_MANAGER, actor_id=21)
    with _client(repository, manager) as client:
        denied = _update_classification(
            client, source["id"], "internal", version=1
        )
        assert denied.status_code == 403
        assert repository._sources[0]["classification"] == "confidential"

    rejected = [
        row
        for row in repository._audit
        if row.get("action") == "ai.knowledge_source.classification_update"
        and row.get("outcome") == "denied"
    ]
    assert rejected and rejected[0]["actor_id"] == 21

    with _client(repository, _principal()) as admin:
        allowed = _update_classification(
            admin, source["id"], "internal", version=1
        )
        assert allowed.status_code == 200
        assert allowed.json()["classification"] == "internal"


def test_download_enforces_live_source_acl_after_update(
    repository: InMemoryAiRepository,
) -> None:
    storage = MemoryStorage()
    storage.objects["docs/pump.txt"] = b"secret bytes"
    with _client(repository, _principal(), storage=storage) as admin:
        source = _create_source(admin, acl={"users": ["alice"]})
    document = asyncio.run(
        repository.create_or_replace_document(
            TENANT,
            {
                "source_id": source["id"],
                "external_id": "pump",
                "title": "pump",
                "mime_type": "text/plain",
                "object_key": "docs/pump.txt",
                "classification": "internal",
                "acl": {"users": ["alice"]},
            },
        )
    )

    alice = _principal("alice", frozenset({"ai.knowledge:read"}))
    with _client(repository, alice, storage=storage) as client:
        assert client.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/download"
        ).status_code == 200

    with _client(repository, _principal(), storage=storage) as admin:
        assert _update_acl(
            admin, source["id"], {"users": ["bob"]}, version=1
        ).status_code == 200

    with _client(repository, alice, storage=storage) as client:
        assert client.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/download"
        ).status_code == 403
    bob = _principal("bob", frozenset({"ai.knowledge:read"}))
    with _client(repository, bob, storage=storage) as client:
        response = client.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/download"
        )
        assert response.status_code == 200
        assert response.content == b"secret bytes"


def test_acl_update_queues_retryable_refresh_and_marks_index_stale(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(client)
        _ingest(client, source["id"])
        assert _update_acl(
            client, source["id"], {"users": ["alice"]}, version=1
        ).status_code == 200

    jobs = [
        job
        for job in repository._jobs
        if job.get("idempotency_key") == f"source-security-{source['id']}-v2"
    ]
    assert len(jobs) == 1
    assert jobs[0]["type"] == "index"
    assert jobs[0]["source_id"] == source["id"]
    assert all(doc["search_indexed_at"] is None for doc in repository._documents)


def test_queue_failure_does_not_roll_back_policy_and_reconcile_recovers(
    repository: InMemoryAiRepository,
) -> None:
    failing = _FailingEnqueueRepository()
    with _client(failing, _principal()) as client:
        source = _create_source(client)
        _ingest(client, source["id"])
        failing.fail_security_enqueue = True
        updated = _update_acl(
            client, source["id"], {"users": ["alice"]}, version=1
        )
        assert updated.status_code == 200
        assert updated.json()["acl"] == {"users": ["alice"]}
        assert not [
            job
            for job in failing._jobs
            if str(job.get("idempotency_key", "")).startswith("source-security-")
        ]

        failing.fail_security_enqueue = False
        reconciled = client.post("/api/v1/ai/knowledge/reconcile", json={})
        assert reconciled.status_code == 200
        assert reconciled.json()["sources_queued"] >= 1


def test_reindex_uses_latest_source_acl_not_stale_child_copy(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(client, acl={"users": ["alice"]})
        _ingest(client, source["id"])

    # Simulate a policy change that has not reached the denormalized children.
    repository._sources[0]["acl"] = {"users": ["carol"]}
    repository._sources[0]["version"] = 2

    with _client(repository, _principal()) as client:
        response = client.post(
            f"/api/v1/ai/knowledge/sources/{source['id']}/reindex"
        )
        assert response.status_code == 200, response.text

    assert repository._documents[0]["acl"] == {"users": ["carol"]}
    assert repository._chunks[0]["acl"] == {"users": ["carol"]}


def test_update_cannot_reenable_a_disabled_or_deleted_source(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(client)
        _ingest(client, source["id"])
        repository._sources[0]["status"] = "disabled"

        updated = _update_acl(
            client, source["id"], {"users": ["alice"]}, version=1
        )
        assert updated.status_code == 200
        assert updated.json()["status"] == "disabled"

        assert client.delete(
            f"/api/v1/ai/knowledge/sources/{source['id']}"
        ).status_code == 204
        assert _update_acl(
            client, source["id"], {"users": ["bob"]}, version=2
        ).status_code == 404


def test_non_superuser_cannot_broaden_a_restricted_acl(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as admin:
        source = _create_source(admin, acl={"users": ["alice"]})

    manager = _principal(
        "manager",
        SECURITY_MANAGER,
        roles=frozenset({"knowledge-admin"}),
        actor_id=31,
    )
    with _client(repository, manager) as client:
        # Clearing the ACL would make the source tenant-wide.
        assert _update_acl(client, source["id"], {}, version=1).status_code == 403
        # Replacing one restricted grant with another is still a broadening.
        assert _update_acl(
            client, source["id"], {"roles": ["knowledge-admin"]}, version=1
        ).status_code == 403
        assert _update_acl(
            client, source["id"], {"users": ["alice", "bob"]}, version=1
        ).status_code == 403

    assert repository._sources[0]["acl"] == {"users": ["alice"]}
    assert repository._sources[0]["version"] == 1
    denied = [
        row
        for row in repository._audit
        if row.get("action") == "ai.knowledge_source.acl_update"
        and row.get("outcome") == "denied"
    ]
    assert len(denied) == 3


def test_non_superuser_can_tighten_an_existing_acl(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as admin:
        source = _create_source(
            admin, acl={"roles": ["ops"], "users": ["alice", "bob"]}
        )

    manager = _principal("manager", SECURITY_MANAGER, actor_id=32)
    with _client(repository, manager) as client:
        removed = _update_acl(
            client, source["id"], {"roles": ["ops"], "users": ["alice"]}, version=1
        )
        assert removed.status_code == 200, removed.text
        denial = _update_acl(
            client, source["id"], {"deny_all": True}, version=2
        )
        assert denial.status_code == 200, denial.text
        assert denial.json()["acl"] == {"deny_all": True}
        assert (
            _update_acl(
                client, source["id"], {"roles": ["ops"]}, version=3
            ).status_code
            == 403
        )


def test_superuser_can_broaden_source_access(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        source = _create_source(client, acl={"deny_all": True})
        broadened = _update_acl(client, source["id"], {}, version=1)
        assert broadened.status_code == 200, broadened.text
        assert broadened.json()["acl"] == {}
        assert broadened.json()["version"] == 2
