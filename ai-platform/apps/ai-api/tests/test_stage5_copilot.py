from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_object_storage, get_principal
from ai_api.application.services.copilot_service import CopilotService
from ai_api.config.settings import get_settings
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.infrastructure.storage import InMemoryObjectStorage
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
POWER_USER = frozenset({"*:*"})


def _principal(username: str = "tester", tenant_id: int = TENANT) -> Principal:
    return Principal(
        user_id=username,
        username=username,
        tenant_id=tenant_id,
        actor_id=1,
        permissions=POWER_USER,
    )


@contextmanager
def _client(
    repository: InMemoryAiRepository, principal: Principal | None = None
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    storage = InMemoryObjectStorage()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_object_storage] = lambda: storage
    app.dependency_overrides[get_principal] = lambda: principal or _principal()
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


def _upload(client: TestClient, name: str, content: str) -> int:
    source = client.post(
        "/api/v1/ai/knowledge/sources",
        json={"code": f"src-{name}", "name": name, "kind": "file"},
    )
    assert source.status_code == 201, source.text
    source_id = source.json()["id"]
    uploaded = client.post(
        f"/api/v1/ai/knowledge/sources/{source_id}/upload",
        files={"file": (f"{name}.txt", content.encode(), "text/plain")},
    )
    assert uploaded.status_code == 202, uploaded.text
    documents = client.get(
        f"/api/v1/ai/knowledge/sources/{source_id}/documents"
    ).json()
    return documents["items"][0]["id"]


def _conversation(client: TestClient, title: str = "Copilot") -> int:
    response = client.post(
        "/api/v1/ai/assistant/conversations", json={"title": title}
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


# --- Conversation management -------------------------------------------


def test_rename_pagination_archive_and_feedback_category(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        conversation_id = _conversation(client, "Old title")
        for question in ("First question", "Second question", "Third question"):
            reply = client.post(
                f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
                json={"content": question},
            )
            assert reply.status_code == 201, reply.text

        page = client.get(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            params={"limit": 2, "offset": 2},
        )
        assert page.status_code == 200
        body = page.json()
        assert body["total"] == 6
        assert len(body["items"]) == 2

        renamed = client.patch(
            f"/api/v1/ai/assistant/conversations/{conversation_id}",
            json={"title": "Renamed"},
        )
        assert renamed.status_code == 200
        assert renamed.json()["title"] == "Renamed"

        archived = client.patch(
            f"/api/v1/ai/assistant/conversations/{conversation_id}",
            json={"status": "archived"},
        )
        assert archived.status_code == 200
        assert archived.json()["status"] == "archived"

        assistant_message = body["items"][-1]
        feedback = client.post(
            "/api/v1/ai/assistant/feedback",
            json={
                "message_id": assistant_message["id"],
                "category": "poor_citations",
                "comment": "Needs a source.",
            },
        )
        assert feedback.status_code == 201, feedback.text
        assert feedback.json()["category"] == "poor_citations"


def test_conversation_is_tenant_scoped(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        conversation_id = _conversation(client)
    with _client(repository, _principal("other", tenant_id=2)) as other:
        response = other.get(
            f"/api/v1/ai/assistant/conversations/{conversation_id}"
        )
        assert response.status_code == 404


# --- Context references -------------------------------------------------


def test_ask_with_authorized_knowledge_context(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        document_id = _upload(
            client, "pump", "The pump requires quarterly bearing lubrication."
        )
        conversation_id = _conversation(client)
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            json={
                "content": "What maintenance does the pump need?",
                "context": [
                    {"type": "knowledge_document", "id": str(document_id)}
                ],
            },
        )
        assert response.status_code == 201, response.text
        message = response.json()
        assert message["context"][0]["type"] == "knowledge_document"
        assert message["context"][0]["object_id"] == str(document_id)
        assert message["sources"]
        assert message["prompt_version"]
        assert message["generation_status"] == "completed"


def test_unknown_or_unsupported_context_is_rejected(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        conversation_id = _conversation(client)
        missing = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            json={
                "content": "Summarize this",
                "task": "summarize",
                "context": [{"type": "knowledge_document", "id": "999999"}],
            },
        )
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "not_found"

        unsupported = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            json={
                "content": "Summarize this",
                "task": "summarize",
                "context": [{"type": "crm_contact", "id": "1"}],
            },
        )
        assert unsupported.status_code == 422
        assert unsupported.json()["error"]["code"] == "validation_error"


def test_summarize_requires_context(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        document_id = _upload(
            client, "policy", "Remote access requires the corporate VPN client."
        )
        without = client.post(
            "/api/v1/ai/assistant/summarize",
            json={"instruction": "Summarize"},
        )
        assert without.status_code == 422

        with_context = client.post(
            "/api/v1/ai/assistant/summarize",
            json={
                "instruction": "Summarize the policy",
                "context": [
                    {"type": "knowledge_document", "id": str(document_id)}
                ],
            },
        )
        assert with_context.status_code == 200, with_context.text
        body = with_context.json()
        assert body["task_type"] == "summarize"
        assert body["citations"]
        assert body["context"][0]["object_id"] == str(document_id)
        assert body["is_mock"] is True
        assert "mock_provider_output_is_not_real_analysis" in body["warnings"]


# --- Compare ------------------------------------------------------------


def test_compare_requires_two_authorized_sources(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        one = _upload(client, "alpha", "The pump service interval is 90 days.")
        two = _upload(client, "beta", "The pump service interval is 180 days.")
        conversation_id = _conversation(client)
        single = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            json={
                "content": "Compare the intervals",
                "task": "compare",
                "context": [{"type": "knowledge_document", "id": str(one)}],
            },
        )
        assert single.status_code == 422

        compared = client.post(
            "/api/v1/ai/assistant/compare",
            json={
                "instruction": "Compare the service intervals",
                "context": [
                    {"type": "knowledge_document", "id": str(one)},
                    {"type": "knowledge_document", "id": str(two)},
                ],
            },
        )
        assert compared.status_code == 200, compared.text
        body = compared.json()
        assert body["task_type"] == "compare"
        assert len(body["context"]) == 2
        assert len({citation["document_id"] for citation in body["citations"]}) == 2


# --- Extract ------------------------------------------------------------


def test_extract_returns_validated_structure(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        document_id = _upload(
            client, "spec", "Service interval: 90 days. Owner: Facilities."
        )
        response = client.post(
            "/api/v1/ai/assistant/extract",
            json={
                "instruction": "Extract the maintenance data",
                "context": [
                    {"type": "knowledge_document", "id": str(document_id)}
                ],
                "fields": [
                    {"name": "interval", "type": "string"},
                    {"name": "owner", "type": "string"},
                ],
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["task_type"] == "extract"
        assert body["structured"] is not None
        assert set(body["structured"]["fields"]) == {"interval", "owner"}
        assert set(body["structured"]["missing"]) <= {"interval", "owner"}
        assert "mock_provider_output_is_not_real_analysis" in body["warnings"]


def test_extract_requires_context(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        response = client.post(
            "/api/v1/ai/assistant/extract",
            json={"instruction": "Extract fields", "fields": [{"name": "owner"}]},
        )
        assert response.status_code == 422


# --- Streaming ----------------------------------------------------------


def test_streaming_ask_persists_completed_message(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        _upload(client, "stream", "The pump requires quarterly lubrication.")
        conversation_id = _conversation(client)
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages/stream",
            json={"content": "What maintenance does the pump need?"},
        )
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith("text/event-stream")
        body = response.text
        assert "event: start" in body
        assert "event: delta" in body
        assert "event: done" in body

        frames = [
            json.loads(line[len("data: ") :])
            for line in body.splitlines()
            if line.startswith("data: ")
        ]
        done = frames[-1]
        assert done["answer_status"] == "answered"
        assert done["generation_status"] == "completed"
        assert done["citations"]

        messages = client.get(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages"
        ).json()
        assert messages["total"] == 2
        assert messages["items"][-1]["content"]
        assert messages["items"][-1]["generation_status"] == "completed"


def test_streaming_rejects_non_streamable_task(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        document_id = _upload(client, "stream2", "Some content.")
        conversation_id = _conversation(client)
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages/stream",
            json={
                "content": "Summarize",
                "task": "summarize",
                "context": [
                    {"type": "knowledge_document", "id": str(document_id)}
                ],
            },
        )
        assert response.status_code == 422


def test_cancel_without_active_generation_is_idempotent(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        conversation_id = _conversation(client)
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/cancel"
        )
        assert response.status_code == 200
        assert response.json() == {
            "conversation_id": conversation_id,
            "cancelled": False,
        }


# --- Capabilities -------------------------------------------------------


def test_capabilities_expose_tasks_and_context_types(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        response = client.get("/api/v1/ai/assistant/capabilities")
        assert response.status_code == 200
        body = response.json()
        assert body["context_types"] == ["knowledge_document"]
        assert body["prompt_version"]
        tasks = {task["task"]: task for task in body["tasks"]}
        assert set(tasks) == {"ask", "summarize", "explain", "compare", "extract"}
        assert tasks["compare"]["requires_context"] is True
        assert tasks["ask"]["requires_context"] is False
        assert tasks["ask"]["streaming"] is True


# --- Unit validation ----------------------------------------------------


def test_extraction_validation_rejects_wrong_types() -> None:
    service = CopilotService(
        repository=None,  # type: ignore[arg-type]
        retrieval=None,  # type: ignore[arg-type]
        gateway=None,  # type: ignore[arg-type]
        governance=None,  # type: ignore[arg-type]
        audit=None,  # type: ignore[arg-type]
        context=None,  # type: ignore[arg-type]
        settings=get_settings(),
    )
    fields = [
        {"name": "interval", "type": "number"},
        {"name": "owner", "type": "string"},
        {"name": "active", "type": "boolean"},
    ]
    payload = {
        "fields": {"interval": "ninety", "owner": "Facilities", "active": True},
        "evidence": {"interval": [1, 99], "owner": [1]},
    }
    structured, warnings = service._validate_extraction(
        json.dumps(payload), fields, evidence_count=2
    )
    assert structured is not None
    assert structured["fields"] == {
        "interval": None,
        "owner": "Facilities",
        "active": True,
    }
    assert structured["invalid"] == ["interval"]
    assert structured["evidence"]["interval"] == [1]
    assert "invalid_value:interval" in warnings
    assert "extraction_invalid_fields" in warnings


def test_extraction_validation_reports_invalid_json() -> None:
    service = CopilotService(
        repository=None,  # type: ignore[arg-type]
        retrieval=None,  # type: ignore[arg-type]
        gateway=None,  # type: ignore[arg-type]
        governance=None,  # type: ignore[arg-type]
        audit=None,  # type: ignore[arg-type]
        context=None,  # type: ignore[arg-type]
        settings=get_settings(),
    )
    structured, warnings = service._validate_extraction(
        "not-json", [{"name": "owner", "type": "string"}], evidence_count=1
    )
    assert structured is None
    assert warnings == ["invalid_json_output"]
