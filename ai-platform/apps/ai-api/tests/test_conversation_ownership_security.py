"""SEC-17: fail-closed assistant/copilot conversation ownership.

Conversation access requires a valid actor identity and an exact owner match
within the caller's tenant. Missing or malformed identities must not be treated
as permission, and cross-user listing requires an explicit platform admin.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_object_storage, get_principal
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.infrastructure.storage import InMemoryObjectStorage
from ai_api.main import create_app
from ai_api.security.identity import DevelopmentIdentityProvider
from ai_api.security.policies import Principal

TENANT = 1
OTHER_TENANT = 2
POWER_USER = frozenset({"*:*"})
READER = frozenset({"ai.retrieval:execute"})


def _principal(
    actor_id: object = 10,
    *,
    user_id: str | None = None,
    tenant_id: int = TENANT,
    permissions: frozenset[str] = POWER_USER,
) -> Principal:
    return Principal(
        user_id=user_id or f"user-{actor_id}",
        username=user_id or f"user-{actor_id}",
        tenant_id=tenant_id,
        actor_id=actor_id,  # type: ignore[arg-type]
        permissions=permissions,
    )


@contextmanager
def _client(
    repository: InMemoryAiRepository, principal: Principal
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    storage = InMemoryObjectStorage()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_object_storage] = lambda: storage
    app.dependency_overrides[get_principal] = lambda: principal
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


def _conversation(
    repository: InMemoryAiRepository,
    *,
    actor_id: object = 10,
    tenant_id: int = TENANT,
    title: str = "private",
) -> int:
    record = asyncio.run(
        repository.create_conversation(
            tenant_id, {"actor_id": actor_id, "title": title, "metadata": {}}
        )
    )
    return int(record["id"])


def _message(repository: InMemoryAiRepository, conversation_id: int) -> int:
    record = asyncio.run(
        repository.add_message(
            TENANT,
            conversation_id,
            {"role": "user", "content": "private message", "request_id": "test"},
        )
    )
    return int(record["id"])


# --- Identity fail-closed -------------------------------------------------


def test_development_identity_assigns_explicit_actor() -> None:
    from ai_api.config.settings import get_settings

    settings = get_settings()
    principal = asyncio.run(DevelopmentIdentityProvider(settings).resolve("dev-token"))
    assert principal.actor_id == settings.ai_dev_actor_id
    assert principal.actor_id > 0


def test_missing_actor_cannot_read_conversation(
    repository: InMemoryAiRepository,
) -> None:
    conversation_id = _conversation(repository, actor_id=10)
    with _client(repository, _principal(None)) as client:
        response = client.get(f"/api/v1/ai/assistant/conversations/{conversation_id}")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"
    assert "private" not in response.text


@pytest.mark.parametrize("actor_id", [0, -1, "", "10", True])
def test_empty_or_malformed_actor_is_rejected(
    repository: InMemoryAiRepository, actor_id: object
) -> None:
    conversation_id = _conversation(repository, actor_id=actor_id)
    with _client(repository, _principal(actor_id)) as client:
        response = client.get(f"/api/v1/ai/assistant/conversations/{conversation_id}")
    assert response.status_code == 403


def test_missing_actor_cannot_create_conversation(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal(None)) as client:
        response = client.post(
            "/api/v1/ai/assistant/conversations", json={"title": "new"}
        )
    assert response.status_code == 403
    assert repository._conversations == []


# --- Ownership and tenant boundary ---------------------------------------


@pytest.mark.parametrize("method", ["get", "patch", "delete"])
def test_owner_mismatch_is_concealed(
    repository: InMemoryAiRepository, method: str
) -> None:
    conversation_id = _conversation(repository, actor_id=10)
    with _client(repository, _principal(11)) as client:
        if method == "get":
            response = client.get(
                f"/api/v1/ai/assistant/conversations/{conversation_id}"
            )
        elif method == "patch":
            response = client.patch(
                f"/api/v1/ai/assistant/conversations/{conversation_id}",
                json={"title": "stolen"},
            )
        else:
            response = client.delete(
                f"/api/v1/ai/assistant/conversations/{conversation_id}"
            )
    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "not_found"
    assert error["message"] == "conversation not found"
    assert error["details"] == {"conversation_id": conversation_id}


def test_cross_tenant_access_is_not_found(repository: InMemoryAiRepository) -> None:
    conversation_id = _conversation(repository, actor_id=10, tenant_id=TENANT)
    with _client(repository, _principal(10, tenant_id=OTHER_TENANT)) as client:
        response = client.get(f"/api/v1/ai/assistant/conversations/{conversation_id}")
        listing = client.get("/api/v1/ai/assistant/conversations")
    assert response.status_code == 404
    assert listing.status_code == 200
    assert listing.json()["items"] == []


def test_owner_can_read_update_and_delete(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal(10)) as client:
        created = client.post(
            "/api/v1/ai/assistant/conversations", json={"title": "mine"}
        )
        assert created.status_code == 201, created.text
        conversation_id = created.json()["id"]

        read = client.get(f"/api/v1/ai/assistant/conversations/{conversation_id}")
        assert read.status_code == 200

        updated = client.patch(
            f"/api/v1/ai/assistant/conversations/{conversation_id}",
            json={"title": "renamed"},
        )
        assert updated.status_code == 200
        assert updated.json()["title"] == "renamed"

        deleted = client.delete(
            f"/api/v1/ai/assistant/conversations/{conversation_id}"
        )
        assert deleted.status_code == 204


# --- Listing and explicit administrative access --------------------------


def test_list_requires_actor_and_never_lists_all_by_default(
    repository: InMemoryAiRepository,
) -> None:
    _conversation(repository, actor_id=10, title="alpha")
    _conversation(repository, actor_id=11, title="beta")

    with _client(repository, _principal(None)) as client:
        missing = client.get("/api/v1/ai/assistant/conversations")
    assert missing.status_code == 403

    with _client(repository, _principal(10, permissions=READER)) as client:
        own = client.get("/api/v1/ai/assistant/conversations")
        spoof_all = client.get(
            "/api/v1/ai/assistant/conversations", params={"mine": "false"}
        )
    assert own.status_code == 200
    assert [item["title"] for item in own.json()["items"]] == ["alpha"]
    assert spoof_all.status_code == 403


def test_platform_admin_may_explicitly_list_tenant_conversations(
    repository: InMemoryAiRepository,
) -> None:
    _conversation(repository, actor_id=10, title="alpha")
    _conversation(repository, actor_id=11, title="beta")
    with _client(repository, _principal(99, permissions=POWER_USER)) as client:
        response = client.get(
            "/api/v1/ai/assistant/conversations", params={"mine": "false"}
        )
    assert response.status_code == 200
    assert {item["title"] for item in response.json()["items"]} == {"alpha", "beta"}


# --- Messages, feedback, streaming and alternate routes ------------------


def test_message_read_and_mutation_require_ownership(
    repository: InMemoryAiRepository,
) -> None:
    conversation_id = _conversation(repository, actor_id=10)
    with _client(repository, _principal(None)) as client:
        read = client.get(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages"
        )
        write = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            json={"content": "question"},
        )
    assert read.status_code == 403
    assert write.status_code == 403

    with _client(repository, _principal(11)) as client:
        read = client.get(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages"
        )
        write = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            json={"content": "question"},
        )
        stream = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages/stream",
            json={"content": "question"},
        )
        cancel = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/cancel"
        )
    assert read.status_code == 404
    assert write.status_code == 404
    assert stream.status_code == 404
    assert cancel.status_code == 404


def test_streaming_requires_actor_and_allows_owner(
    repository: InMemoryAiRepository,
) -> None:
    conversation_id = _conversation(repository, actor_id=10)
    with _client(repository, _principal(None)) as client:
        denied = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages/stream",
            json={"content": "question"},
        )
    assert denied.status_code == 403

    with _client(repository, _principal(10)) as client:
        allowed = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages/stream",
            json={"content": "question"},
        )
    assert allowed.status_code == 200
    assert "text/event-stream" in allowed.headers["content-type"]


def test_feedback_paths_enforce_conversation_ownership(
    repository: InMemoryAiRepository,
) -> None:
    conversation_id = _conversation(repository, actor_id=10)
    message_id = _message(repository, conversation_id)
    body = {"message_id": message_id, "category": "helpful"}

    with _client(repository, _principal(None)) as client:
        missing = client.post("/api/v1/ai/assistant/feedback", json=body)
        alternate = client.post(
            f"/api/v1/ai/assistant/messages/{message_id}/feedback", json=body
        )
    assert missing.status_code == 403
    assert alternate.status_code == 403

    with _client(repository, _principal(11)) as client:
        mismatch = client.post("/api/v1/ai/assistant/feedback", json=body)
    assert mismatch.status_code == 404


# --- Spoofing -------------------------------------------------------------


def test_caller_supplied_actor_is_rejected(repository: InMemoryAiRepository) -> None:
    conversation_id = _conversation(repository, actor_id=10)
    message_id = _message(repository, conversation_id)
    with _client(repository, _principal(10)) as client:
        create = client.post(
            "/api/v1/ai/assistant/conversations",
            json={"title": "spoof", "actor_id": 999},
        )
        update = client.patch(
            f"/api/v1/ai/assistant/conversations/{conversation_id}",
            json={"title": "spoof", "owner_id": 999},
        )
        message = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            json={"content": "spoof", "actor_id": 999},
        )
        feedback = client.post(
            "/api/v1/ai/assistant/feedback",
            json={"message_id": message_id, "category": "helpful", "actor_id": 999},
        )
    assert create.status_code == 422
    assert update.status_code == 422
    assert message.status_code == 422
    assert feedback.status_code == 422


# --- Response metadata ----------------------------------------------------


def test_denied_reads_have_identical_shape(repository: InMemoryAiRepository) -> None:
    conversation_id = _conversation(repository, actor_id=10)
    with _client(repository, _principal(11)) as client:
        existing = client.get(
            f"/api/v1/ai/assistant/conversations/{conversation_id}"
        )
        absent = client.get("/api/v1/ai/assistant/conversations/999999")
    assert existing.status_code == absent.status_code == 404
    assert existing.json()["error"]["code"] == absent.json()["error"]["code"]
    assert existing.json()["error"]["message"] == absent.json()["error"]["message"]
