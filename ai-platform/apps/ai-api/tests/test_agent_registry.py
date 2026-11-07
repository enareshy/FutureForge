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

VALID_DEFINITION = {
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


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


def _principal(
    username: str = "tester", permissions: frozenset[str] = POWER_USER
) -> Principal:
    return Principal(
        user_id=username, username=username, tenant_id=TENANT, permissions=permissions
    )


def _create_agent(client: TestClient, code: str = "reporter") -> dict:
    response = client.post(
        "/api/v1/ai/agents",
        json={
            "code": code,
            "name": "Reporter",
            "description": "Read-only reporter",
            "category": "knowledge",
            "definition": VALID_DEFINITION,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_create_validate_publish_and_snapshot_tools(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        assert agent["lifecycle_status"] == "draft"
        assert agent["current_version_id"] is None
        version_id = agent["current_version"]["id"]

        validated = client.post(
            f"/api/v1/ai/agents/{agent['id']}/validate", json={}
        )
        assert validated.status_code == 200, validated.text
        assert validated.json()["valid"] is True
        assert validated.json()["checks"]["tools"] == ["knowledge.search"]

        published = client.post(
            f"/api/v1/ai/agents/{agent['id']}/publish",
            json={"version_id": version_id, "note": "initial"},
        )
        assert published.status_code == 200, published.text
        body = published.json()
        assert body["lifecycle_status"] == "published"
        assert body["current_version_id"] == version_id
        assert body["current_version"]["status"] == "published"

        tools = client.get(
            f"/api/v1/ai/agents/{agent['id']}/versions/{version_id}/tools"
        )
        assert tools.status_code == 200
        assert tools.json()[0]["code"] == "knowledge.search"

        versions = client.get(f"/api/v1/ai/agents/{agent['id']}/versions")
        assert versions.json()[0]["status"] == "published"


def test_validation_rejects_unknown_tool_and_missing_instructions(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        response = client.post(
            "/api/v1/ai/agents",
            json={
                "code": "broken",
                "name": "Broken",
                "definition": {
                    "tools": ["shell.exec"],
                    "steps": [{"key": "run", "tool": "shell.exec"}],
                },
            },
        )
        assert response.status_code == 201
        agent = response.json()
        validated = client.post(
            f"/api/v1/ai/agents/{agent['id']}/validate", json={}
        )
        body = validated.json()
        assert body["valid"] is False
        assert any("system_instructions" in error for error in body["errors"])
        assert any("not registered" in error for error in body["errors"])

        published = client.post(
            f"/api/v1/ai/agents/{agent['id']}/publish", json={}
        )
        assert published.status_code == 422


def test_definition_with_credentials_is_rejected(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        response = client.post(
            "/api/v1/ai/agents",
            json={
                "code": "leaky",
                "name": "Leaky",
                "definition": {"api_key": "sk-live-123"},
            },
        )
        assert response.status_code == 422


def test_update_requires_optimistic_lock(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        ok = client.patch(
            f"/api/v1/ai/agents/{agent['id']}",
            json={"name": "Renamed", "lock_version": agent["lock_version"]},
        )
        assert ok.status_code == 200
        stale = client.patch(
            f"/api/v1/ai/agents/{agent['id']}",
            json={"name": "Stale", "lock_version": agent["lock_version"]},
        )
        assert stale.status_code == 409


def test_rollback_activates_previous_published_version(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        first = agent["current_version"]["id"]
        assert (
            client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={}).status_code
            == 200
        )
        detail = client.get(f"/api/v1/ai/agents/{agent['id']}").json()
        updated = client.patch(
            f"/api/v1/ai/agents/{agent['id']}",
            json={
                "definition": {**VALID_DEFINITION, "model": "mock-1"},
                "lock_version": detail["lock_version"],
            },
        )
        assert updated.status_code == 200
        versions = client.get(f"/api/v1/ai/agents/{agent['id']}/versions").json()
        draft = next(
            version for version in versions if version["status"] in ("draft", "validating")
        )
        second = client.post(
            f"/api/v1/ai/agents/{agent['id']}/publish",
            json={"version_id": draft["id"]},
        )
        assert second.status_code == 200

        rolled = client.post(
            f"/api/v1/ai/agents/{agent['id']}/rollback", json={"version_id": first}
        )
        assert rolled.status_code == 200
        assert rolled.json()["current_version_id"] == first


def test_disable_blocks_new_edits(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        disabled = client.post(
            f"/api/v1/ai/agents/{agent['id']}/disable", json={"reason": "retired"}
        )
        assert disabled.status_code == 200
        assert disabled.json()["lifecycle_status"] == "disabled"
        blocked = client.patch(
            f"/api/v1/ai/agents/{agent['id']}",
            json={"name": "Nope", "lock_version": disabled.json()["lock_version"]},
        )
        assert blocked.status_code == 409


def test_non_owner_cannot_manage_agent(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("alice")) as client:
        agent = _create_agent(client)
    limited = frozenset({"ai.agents:read", "ai.agents:update"})
    with _client(repository, _principal("bob", limited)) as client:
        response = client.patch(
            f"/api/v1/ai/agents/{agent['id']}",
            json={"name": "Hijack", "lock_version": 1},
        )
        assert response.status_code == 403


def test_tool_registry_publish_and_prohibited_tool(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        created = client.post(
            "/api/v1/ai/agent-tools",
            json={
                "code": "record.create",
                "name": "Create record",
                "definition": {
                    "capability": "records.write",
                    "read_only": False,
                    "risk_class": "controlled_mutation",
                    "requires_approval": True,
                    "idempotency": "required",
                    "input_schema": {"type": "object"},
                    "output_schema": {"type": "object"},
                },
            },
        )
        assert created.status_code == 201, created.text
        tool = created.json()
        assert tool["current_version"]["status"] == "draft"

        validated = client.post(f"/api/v1/ai/agent-tools/{tool['id']}/validate")
        assert validated.status_code == 200
        assert validated.json()["valid"] is True

        published = client.post(f"/api/v1/ai/agent-tools/{tool['id']}/publish")
        assert published.status_code == 200
        assert published.json()["current_version"]["status"] == "published"

        forbidden = client.post(
            "/api/v1/ai/agent-tools",
            json={
                "code": "shell.exec",
                "name": "Shell",
                "definition": {
                    "capability": "process.execute",
                    "read_only": False,
                    "risk_class": "prohibited",
                    "input_schema": {"type": "object"},
                    "output_schema": {"type": "object"},
                },
            },
        )
        body = forbidden.json()
        rejected = client.post(
            f"/api/v1/ai/agent-tools/{body['id']}/publish"
        )
        assert rejected.status_code == 422


def test_tool_definition_cannot_embed_secrets(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        response = client.post(
            "/api/v1/ai/agent-tools",
            json={
                "code": "api.call",
                "name": "API",
                "definition": {
                    "capability": "api.call",
                    "password": "hunter2",
                    "input_schema": {},
                    "output_schema": {},
                },
            },
        )
        assert response.status_code == 422
