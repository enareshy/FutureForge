"""SEC-15: server-controlled, tenant-scoped object storage keys."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_object_storage, get_principal
from ai_api.domain.errors import ConfigurationError
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.infrastructure.storage import (
    InMemoryObjectStorage,
    build_object_key,
    validate_document_object_key,
    validate_object_key,
    validate_tenant_object_key,
)
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
OTHER_TENANT = 2
POWER_USER = frozenset({"*:*"})


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


@pytest.fixture()
def storage() -> InMemoryObjectStorage:
    return InMemoryObjectStorage()


def _principal(tenant_id: int = TENANT, username: str = "tester") -> Principal:
    return Principal(
        user_id=username,
        username=username,
        tenant_id=tenant_id,
        permissions=POWER_USER,
    )


@contextmanager
def _client(
    repository: InMemoryAiRepository,
    storage: InMemoryObjectStorage,
    principal: Principal,
    *,
    raise_server_exceptions: bool = True,
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_object_storage] = lambda: storage
    app.dependency_overrides[get_principal] = lambda: principal
    try:
        with TestClient(app, raise_server_exceptions=raise_server_exceptions) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _create_source(
    client: TestClient, code: str = "docs", *, tenant_id: int | None = None
) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": code, "name": code, "kind": "file"}
    if tenant_id is not None:
        payload["tenant_id"] = tenant_id
    response = client.post("/api/v1/ai/knowledge/sources", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _upload(client: TestClient, source_id: int, name: str, data: bytes) -> Any:
    return client.post(
        f"/api/v1/ai/knowledge/sources/{source_id}/upload",
        files={"file": (name, data, "text/plain")},
    )


def _documents(client: TestClient, source_id: int) -> list[dict[str, Any]]:
    response = client.get(f"/api/v1/ai/knowledge/sources/{source_id}/documents")
    assert response.status_code == 200, response.text
    return response.json()["items"]


def _ingest(client: TestClient, source_id: int, document: dict[str, Any]) -> Any:
    return client.post(
        f"/api/v1/ai/knowledge/sources/{source_id}/ingest",
        json={"documents": [document]},
    )


def _seed_document(
    repository: InMemoryAiRepository,
    *,
    source_id: int,
    object_key: str,
    tenant_id: int = TENANT,
    external_id: str = "seeded",
) -> dict[str, Any]:
    return asyncio.run(
        repository.create_or_replace_document(
            tenant_id,
            {
                "source_id": source_id,
                "external_id": external_id,
                "title": external_id,
                "mime_type": "text/plain",
                "object_key": object_key,
                "classification": "internal",
                "acl": {},
            },
        )
    )


def test_valid_upload_uses_server_generated_tenant_key(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    with _client(repository, storage, _principal()) as client:
        source = _create_source(client)
        response = _upload(client, source["id"], "../../other/pump.txt", b"pump body")
        assert response.status_code == 202, response.text
        body = response.json()

        documents = _documents(client, source["id"])
        assert len(documents) == 1
        document = documents[0]
        source_keys = [item["object_key"] for item in repository._documents]

        assert len(source_keys) == 1
        assert source_keys[0].startswith(f"knowledge/{TENANT}/")
        assert source_keys[0].endswith("/pump.txt")
        assert "/.." not in source_keys[0]
        assert "knowledge/" not in response.text
        assert "knowledge/" not in str(body["job"])
        assert "object_key" not in body["document"]
        assert "object_key" not in document

        download = client.get(f"/api/v1/ai/knowledge/documents/{document['id']}/download")
        assert download.status_code == 200
        assert download.content == b"pump body"


@pytest.mark.parametrize(
    "key",
    [
        "",
        "/knowledge/1/x",
        "knowledge//1/x",
        "knowledge/1//x",
        "knowledge/1/./x",
        "knowledge/1/../2/x",
        "knowledge/1/%2e%2e/2/x",
        "knowledge/1/a%2fb",
        "knowledge/1/a\\b",
        "knowledge/1/a\x00b",
        "knowledge/1/x/",
        "knowledge/1/" + "a" * 1100,
    ],
)
def test_object_key_syntax_rejects_unsafe_values(key: str) -> None:
    with pytest.raises(ConfigurationError):
        validate_object_key(key)


def test_tenant_key_validation_requires_the_exact_namespace() -> None:
    assert validate_tenant_object_key("knowledge/1/2026/10/a/file.txt", 1)
    assert validate_document_object_key("knowledge/1/legacy.txt", 1)

    for key in (
        "knowledge/2/secret.txt",
        "knowledge/01/secret.txt",
        "knowledge/1x/secret.txt",
        "knowledgeevil/1/secret.txt",
    ):
        with pytest.raises(ConfigurationError):
            validate_tenant_object_key(key, 1)

    for key in ("knowledge/2/secret.txt", "knowledge/01/secret.txt", "knowledge//x"):
        with pytest.raises(ConfigurationError):
            validate_document_object_key(key, 1)


def test_public_ingest_rejects_client_supplied_object_key(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    with _client(repository, storage, _principal()) as client:
        source = _create_source(client)
        response = _ingest(
            client,
            source["id"],
            {"external_id": "guess", "object_key": f"knowledge/{OTHER_TENANT}/secret.txt"},
        )

    assert response.status_code == 422
    assert repository._jobs == []
    assert repository._documents == []
    assert storage._objects == {}


def test_client_cannot_read_a_known_other_tenant_key(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    storage._objects[f"knowledge/{OTHER_TENANT}/secret.txt"] = (b"other tenant", "text/plain")
    with _client(repository, storage, _principal(OTHER_TENANT)) as other:
        other_source = _create_source(other, code="other")
        other_document = _seed_document(
            repository,
            source_id=other_source["id"],
            object_key=f"knowledge/{OTHER_TENANT}/secret.txt",
            tenant_id=OTHER_TENANT,
        )

    with _client(repository, storage, _principal(TENANT)) as client:
        response = client.get(
            f"/api/v1/ai/knowledge/documents/{other_document['id']}/download"
        )

    assert response.status_code == 404
    assert b"other tenant" not in response.content


def test_foreign_tenant_prefix_in_metadata_is_rejected_before_storage(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    storage._objects[f"knowledge/{OTHER_TENANT}/secret.txt"] = (b"other tenant", "text/plain")
    with _client(repository, storage, _principal()) as client:
        source = _create_source(client)
        document = _seed_document(
            repository,
            source_id=source["id"],
            object_key=f"knowledge/{OTHER_TENANT}/secret.txt",
        )

        download = client.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/download"
        )
        deleted = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")

    assert download.status_code == 403
    assert deleted.status_code == 403
    assert b"other tenant" not in download.content
    assert f"knowledge/{OTHER_TENANT}/secret.txt" in storage._objects
    assert repository._documents


def test_malformed_stored_key_fails_closed(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    malformed = "knowledge/01/secret.txt"
    storage._objects[malformed] = (b"must stay", "text/plain")
    with _client(repository, storage, _principal()) as client:
        source = _create_source(client)
        document = _seed_document(
            repository, source_id=source["id"], object_key=malformed
        )
        download = client.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/download"
        )
        deleted = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")

    assert download.status_code == 403
    assert deleted.status_code == 403
    assert malformed in storage._objects


def test_cross_tenant_upload_does_not_dedup_or_overwrite(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    payload = b"identical shared content"
    with _client(repository, storage, _principal(TENANT)) as one:
        source_one = _create_source(one, code="one")
        first = _upload(one, source_one["id"], "shared.txt", payload)
        assert first.status_code == 202, first.text
        assert first.json()["document"]["deduplicated"] is False

    with _client(repository, storage, _principal(OTHER_TENANT)) as two:
        source_two = _create_source(two, code="two")
        second = _upload(two, source_two["id"], "shared.txt", payload)
        assert second.status_code == 202, second.text
        assert second.json()["document"]["deduplicated"] is False

    keys_by_tenant = {
        item["tenant_id"]: item["object_key"] for item in repository._documents
    }
    assert keys_by_tenant[TENANT].startswith(f"knowledge/{TENANT}/")
    assert keys_by_tenant[OTHER_TENANT].startswith(f"knowledge/{OTHER_TENANT}/")
    assert keys_by_tenant[TENANT] != keys_by_tenant[OTHER_TENANT]
    assert len(storage._objects) == 2


def test_deleting_one_tenant_document_leaves_the_other_tenant_object(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    payload = b"shared bytes"
    with _client(repository, storage, _principal(TENANT)) as one:
        source_one = _create_source(one, code="one")
        _upload(one, source_one["id"], "same.txt", payload)
        document_one = _documents(one, source_one["id"])[0]

    with _client(repository, storage, _principal(OTHER_TENANT)) as two:
        source_two = _create_source(two, code="two")
        _upload(two, source_two["id"], "same.txt", payload)
        document_two = _documents(two, source_two["id"])[0]

    with _client(repository, storage, _principal(TENANT)) as one:
        assert (
            one.delete(f"/api/v1/ai/knowledge/documents/{document_one['id']}").status_code
            == 204
        )

    with _client(repository, storage, _principal(OTHER_TENANT)) as two:
        response = two.get(
            f"/api/v1/ai/knowledge/documents/{document_two['id']}/download"
        )
    assert response.status_code == 200
    assert response.content == payload


def test_duplicate_upload_retry_and_reindex_reuse_the_key(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    payload = b"retryable original"
    with _client(repository, storage, _principal()) as client:
        source = _create_source(client)
        first = _upload(client, source["id"], "retry.txt", payload)
        assert first.status_code == 202, first.text
        _documents(client, source["id"])
        stored_key = next(iter(storage._objects))
        job = first.json()["job"]

        duplicate = _upload(client, source["id"], "retry-copy.txt", payload)
        assert duplicate.status_code == 202
        assert duplicate.json()["document"]["deduplicated"] is True
        assert duplicate.json()["job"] is None

        retried = client.post(f"/api/v1/ai/knowledge/jobs/{job['id']}/retry")
        assert retried.status_code == 200
        assert retried.json()["status"] == "succeeded"

        reindexed = client.post(f"/api/v1/ai/knowledge/sources/{source['id']}/reindex")
        assert reindexed.status_code == 200, reindexed.text
        assert reindexed.json()["result"]["documents"] == 1
        reindexed_document = _documents(client, source["id"])[0]

        download = client.get(
            f"/api/v1/ai/knowledge/documents/{reindexed_document['id']}/download"
        )

    assert list(storage._objects) == [stored_key]
    assert download.status_code == 200
    assert download.content == payload


def test_failed_enqueue_cleans_up_the_new_object(
    repository: InMemoryAiRepository,
    storage: InMemoryObjectStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_create_job(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(repository, "create_job", fail_create_job)
    with _client(
        repository,
        storage,
        _principal(),
        raise_server_exceptions=False,
    ) as client:
        source = _create_source(client)
        response = _upload(client, source["id"], "orphan.txt", b"orphan bytes")

    assert response.status_code == 500
    assert storage._objects == {}
    assert repository._documents == []


def test_legacy_key_is_available_only_through_its_document_record(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    storage._objects["docs/legacy.txt"] = (b"legacy bytes", "text/plain")
    with _client(repository, storage, _principal()) as client:
        source = _create_source(client)
        document = _seed_document(
            repository, source_id=source["id"], object_key="docs/legacy.txt"
        )

        download = client.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/download"
        )
        assert download.status_code == 200
        assert download.content == b"legacy bytes"

        deleted = client.delete(f"/api/v1/ai/knowledge/documents/{document['id']}")

    assert deleted.status_code == 204
    assert "docs/legacy.txt" not in storage._objects


def test_disabled_and_deleted_sources_block_object_access(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    with _client(repository, storage, _principal()) as client:
        disabled = _create_source(client, code="disabled")
        _upload(client, disabled["id"], "secret.txt", b"disabled secret")
        disabled_document = _documents(client, disabled["id"])[0]
        asyncio.run(repository.set_source_status(TENANT, disabled["id"], "disabled"))

        gone = _create_source(client, code="gone")
        _upload(client, gone["id"], "gone.txt", b"deleted secret")
        gone_document = _documents(client, gone["id"])[0]
        assert client.delete(f"/api/v1/ai/knowledge/sources/{gone['id']}").status_code == 204

        disabled_response = client.get(
            f"/api/v1/ai/knowledge/documents/{disabled_document['id']}/download"
        )
        deleted_response = client.get(
            f"/api/v1/ai/knowledge/documents/{gone_document['id']}/download"
        )

    assert disabled_response.status_code == 403
    assert b"disabled secret" not in disabled_response.content
    assert deleted_response.status_code == 404
    assert b"deleted secret" not in deleted_response.content


def test_missing_object_error_does_not_echo_the_key(
    repository: InMemoryAiRepository, storage: InMemoryObjectStorage
) -> None:
    key = f"knowledge/{TENANT}/2026/10/missing.txt"
    with _client(repository, storage, _principal()) as client:
        source = _create_source(client)
        document = _seed_document(
            repository, source_id=source["id"], object_key=key
        )
        response = client.get(
            f"/api/v1/ai/knowledge/documents/{document['id']}/download"
        )

    assert response.status_code == 404
    assert key not in response.text


def test_build_object_key_is_canonical_and_tenant_scoped() -> None:
    key = build_object_key(TENANT, "../../pump.txt")
    assert key.startswith(f"knowledge/{TENANT}/")
    assert "/.." not in key
    assert key.endswith("/pump.txt")
    assert validate_tenant_object_key(key, TENANT) == key
    with pytest.raises(ConfigurationError):
        validate_tenant_object_key(key, OTHER_TENANT)
