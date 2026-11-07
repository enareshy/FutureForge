from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_object_storage, get_principal
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
OTHER_TENANT = 2
READER_PERMISSIONS = frozenset({"ai.knowledge:read"})


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


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


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


def _principal(
    username: str = "reader",
    *,
    tenant_id: int | None = TENANT,
    permissions: frozenset[str] = READER_PERMISSIONS,
    roles: frozenset[str] = frozenset(),
) -> Principal:
    return Principal(
        user_id=username,
        username=username,
        tenant_id=tenant_id,
        permissions=permissions,
        roles=roles,
    )


def _source(
    repository: InMemoryAiRepository,
    *,
    tenant_id: int = TENANT,
    code: str = "source",
    classification: str = "internal",
    acl: dict[str, Any] | None = None,
):
    return asyncio.run(
        repository.create_knowledge_source(
            tenant_id,
            {
                "code": code,
                "name": code,
                "kind": "file",
                "classification": classification,
                "acl": acl or {},
            },
        )
    )


def _document(
    repository: InMemoryAiRepository,
    source_id: int,
    external_id: str,
    *,
    tenant_id: int = TENANT,
    classification: str = "internal",
    acl: dict[str, Any] | None = None,
    created_at: datetime | None = None,
    object_key: str | None = None,
):
    document = asyncio.run(
        repository.create_or_replace_document(
            tenant_id,
            {
                "source_id": source_id,
                "external_id": external_id,
                "title": f"title-{external_id}",
                "mime_type": "text/plain",
                "object_key": object_key,
                "classification": classification,
                "acl": acl or {},
            },
        )
    )
    if created_at is not None:
        for stored in repository._documents:
            if stored["id"] == document["id"]:
                stored["created_at"] = created_at
        document["created_at"] = created_at
    return document


def _listing(client: TestClient, source_id: int, **params: int) -> Any:
    return client.get(
        f"/api/v1/ai/knowledge/sources/{source_id}/documents", params=params
    )


def test_authorized_user_lists_permitted_documents(
    repository: InMemoryAiRepository,
) -> None:
    source = _source(repository)
    first = _document(repository, source["id"], "public")
    second = _document(
        repository, source["id"], "analyst", acl={"roles": ["analyst"]}
    )
    alice = _principal(roles=frozenset({"analyst"}))

    with _client(repository, alice) as client:
        response = _listing(client, source["id"])

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["total"] == 2
    assert {item["id"] for item in body["items"]} == {first["id"], second["id"]}
    assert all(item["classification"] == "internal" for item in body["items"])


def test_restricted_user_cannot_list_documents_outside_acl(
    repository: InMemoryAiRepository,
) -> None:
    source = _source(repository)
    allowed = _document(repository, source["id"], "general")
    _document(repository, source["id"], "secret", acl={"users": ["alice"]})

    with _client(repository, _principal("bob")) as client:
        response = _listing(client, source["id"])

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["total"] == 1
    assert [item["id"] for item in body["items"]] == [allowed["id"]]
    assert "secret" not in response.text
    assert "title-secret" not in response.text


def test_listing_enforces_document_and_source_classification_ceiling(
    repository: InMemoryAiRepository,
) -> None:
    source = _source(repository)
    _document(repository, source["id"], "visible", classification="internal")
    _document(repository, source["id"], "hidden", classification="confidential")
    confidential_source = _source(
        repository, code="confidential-source", classification="confidential"
    )
    _document(repository, confidential_source["id"], "inherits")

    reader = _principal()
    with _client(repository, reader) as client:
        source_response = _listing(client, source["id"])
        inherited_response = _listing(client, confidential_source["id"])

    assert source_response.status_code == 200
    body = source_response.json()
    assert body["meta"]["total"] == 1
    assert body["items"][0]["external_id"] == "visible"
    assert "hidden" not in source_response.text
    assert inherited_response.status_code == 200
    assert inherited_response.json()["meta"]["total"] == 0
    assert inherited_response.json()["items"] == []


def test_disabled_and_deleted_sources_do_not_expose_documents(
    repository: InMemoryAiRepository,
) -> None:
    disabled = _source(repository, code="disabled")
    _document(repository, disabled["id"], "disabled-doc")
    asyncio.run(repository.set_source_status(TENANT, disabled["id"], "disabled"))

    deleted = _source(repository, code="deleted")
    _document(repository, deleted["id"], "deleted-doc")
    asyncio.run(repository.delete_source(TENANT, deleted["id"]))

    with _client(repository, _principal()) as client:
        disabled_response = _listing(client, disabled["id"])
        deleted_response = _listing(client, deleted["id"])

    assert disabled_response.status_code == 403
    assert "disabled-doc" not in disabled_response.text
    assert deleted_response.status_code == 404
    assert "deleted-doc" not in deleted_response.text


def test_cross_tenant_listing_is_isolated(repository: InMemoryAiRepository) -> None:
    tenant_one = _source(repository, code="one")
    _document(repository, tenant_one["id"], "tenant-one-doc")
    tenant_two = _source(repository, tenant_id=OTHER_TENANT, code="two")
    _document(
        repository,
        tenant_two["id"],
        "tenant-two-doc",
        tenant_id=OTHER_TENANT,
    )

    with _client(repository, _principal(tenant_id=OTHER_TENANT)) as client:
        cross = _listing(client, tenant_one["id"])
        own = _listing(client, tenant_two["id"])

    assert cross.status_code == 404
    assert "tenant-one-doc" not in cross.text
    assert own.status_code == 200
    assert own.json()["meta"]["total"] == 1
    assert own.json()["items"][0]["external_id"] == "tenant-two-doc"


def test_malformed_acl_and_missing_identity_fail_closed(
    repository: InMemoryAiRepository,
) -> None:
    source = _source(repository)
    allowed = _document(repository, source["id"], "allowed")
    _document(repository, source["id"], "bad-roles", acl={"roles": "analyst"})
    _document(repository, source["id"], "unknown-key", acl={"capability": "read"})
    _document(repository, source["id"], "bad-deny", acl={"deny_all": "yes"})
    _document(repository, source["id"], "bad-users", acl={"users": [123]})
    _document(repository, source["id"], "bad-class", classification="top-secret")
    malformed_source = _source(repository, code="bad-source-acl", acl={"roles": "x"})
    _document(repository, malformed_source["id"], "bad-source-doc")
    list_source = _source(repository, code="bad-source-list-acl")
    _document(repository, list_source["id"], "bad-source-list-doc")
    for stored_source in repository._sources:
        if stored_source["id"] == list_source["id"]:
            stored_source["acl"] = []

    reader = _principal()
    with _client(repository, reader) as client:
        response = _listing(client, source["id"])
        malformed_source_response = _listing(client, malformed_source["id"])
        list_source_response = _listing(client, list_source["id"])

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["total"] == 1
    assert [item["id"] for item in body["items"]] == [allowed["id"]]
    for marker in ("bad-roles", "unknown-key", "bad-deny", "bad-users", "bad-class"):
        assert marker not in response.text
    assert malformed_source_response.status_code == 200
    assert malformed_source_response.json()["meta"]["total"] == 0
    assert list_source_response.status_code == 200
    assert list_source_response.json()["meta"]["total"] == 0
    assert "bad-source-list-doc" not in list_source_response.text

    missing_tenant = _principal(tenant_id=None)
    with _client(repository, missing_tenant) as client:
        missing_tenant_response = _listing(client, source["id"])
    assert missing_tenant_response.status_code == 403
    assert "allowed" not in missing_tenant_response.text


def test_missing_or_invalid_classification_policy_fails_closed(
    repository: InMemoryAiRepository,
) -> None:
    source = _source(repository)
    _document(repository, source["id"], "visible")
    repository._governance[TENANT] = {"data_classification_ceiling": "secret"}

    with _client(repository, _principal()) as client:
        response = _listing(client, source["id"])

    assert response.status_code == 403
    assert "visible" not in response.text


def test_totals_exclude_unauthorized_documents(
    repository: InMemoryAiRepository,
) -> None:
    source = _source(repository)
    visible = [
        _document(repository, source["id"], f"visible-{index}") for index in range(3)
    ]
    _document(repository, source["id"], "hidden-1", acl={"deny_all": True})
    _document(repository, source["id"], "hidden-2", classification="confidential")

    with _client(repository, _principal()) as client:
        response = _listing(client, source["id"])

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["total"] == len(visible)
    assert {item["id"] for item in body["items"]} == {item["id"] for item in visible}
    assert "hidden-1" not in response.text
    assert "hidden-2" not in response.text


def test_pagination_and_ordering_do_not_reveal_unauthorized_rows(
    repository: InMemoryAiRepository,
) -> None:
    source = _source(repository)
    start = datetime(2026, 1, 1, tzinfo=UTC)
    visible = []
    for index in range(5):
        visible.append(
            _document(
                repository,
                source["id"],
                f"doc-{index}",
                created_at=start + timedelta(seconds=index),
            )
        )
    _document(
        repository,
        source["id"],
        "newest-secret",
        acl={"deny_all": True},
        created_at=start + timedelta(seconds=10),
    )

    pages: list[list[dict[str, Any]]] = []
    with _client(repository, _principal()) as client:
        for offset in (0, 2, 4):
            response = _listing(client, source["id"], limit=2, offset=offset)
            assert response.status_code == 200
            body = response.json()
            assert body["meta"]["total"] == 5
            assert "newest-secret" not in response.text
            pages.append(body["items"])

    assert [len(page) for page in pages] == [2, 2, 1]
    expected_ids = [document["id"] for document in reversed(visible)]
    assert [item["id"] for page in pages for item in page] == expected_ids


def test_administrative_access_follows_explicit_permission(
    repository: InMemoryAiRepository,
) -> None:
    repository._governance[TENANT] = {"data_classification_ceiling": "restricted"}
    source = _source(repository)
    document = _document(
        repository,
        source["id"],
        "restricted",
        classification="confidential",
        acl={"deny_all": True},
    )

    admin = _principal(permissions=frozenset({"iam.platform:read"}))
    with _client(repository, admin) as client:
        admin_response = _listing(client, source["id"])
    assert admin_response.status_code == 200
    assert admin_response.json()["meta"]["total"] == 1
    assert admin_response.json()["items"][0]["id"] == document["id"]

    with _client(repository, _principal()) as client:
        reader_response = _listing(client, source["id"])
    assert reader_response.status_code == 200
    assert reader_response.json()["meta"]["total"] == 0
    assert "restricted" not in reader_response.text


def test_listing_does_not_weaken_download_authorization(
    repository: InMemoryAiRepository,
) -> None:
    storage = MemoryStorage()
    storage.objects["docs/allowed.txt"] = b"allowed bytes"
    storage.objects["docs/denied.txt"] = b"denied bytes"
    source = _source(repository)
    allowed = _document(
        repository,
        source["id"],
        "allowed",
        object_key="docs/allowed.txt",
    )
    denied = _document(
        repository,
        source["id"],
        "denied",
        object_key="docs/denied.txt",
        acl={"deny_all": True},
    )

    with _client(repository, _principal(), storage) as client:
        listing = _listing(client, source["id"])
        allowed_download = client.get(
            f"/api/v1/ai/knowledge/documents/{allowed['id']}/download"
        )
        denied_download = client.get(
            f"/api/v1/ai/knowledge/documents/{denied['id']}/download"
        )

    assert listing.status_code == 200
    assert listing.json()["meta"]["total"] == 1
    assert allowed_download.status_code == 200
    assert allowed_download.content == b"allowed bytes"
    assert denied_download.status_code == 403
