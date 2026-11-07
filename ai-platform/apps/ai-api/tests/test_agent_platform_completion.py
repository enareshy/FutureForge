"""Stage 6 completion: lifecycle, templates, memory, schedules, monitoring."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal
from ai_api.application.services.agent_execution_service import AgentExecutionService
from ai_api.application.services.agent_memory_service import AgentMemoryService
from ai_api.application.services.agent_schedule_service import (
    AgentScheduleService,
    CronExpression,
)
from ai_api.application.services.agent_tool_service import AgentToolService
from ai_api.application.services.audit_service import AuditService
from ai_api.config.settings import Settings
from ai_api.domain.errors import ValidationError
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.permissions import build_permission_map
from ai_api.security.policies import PermissionMap, Policy, Principal

TENANT = 1
OTHER_TENANT = 2
POWER_USER = frozenset({"*:*"})
READER = frozenset({"ai.agents:read"})
EXECUTOR = frozenset({"ai.agents:read", "ai.agents:execute"})


class _FakeRetrieval:
    async def ranked_documents(
        self, principal, *, query, mode, filters, sort, limit
    ):
        return ([], mode, False)


def _principal(
    username: str = "tester",
    permissions: frozenset[str] = POWER_USER,
    tenant_id: int = TENANT,
    actor_id: int | None = 7,
) -> Principal:
    return Principal(
        user_id=username,
        username=username,
        tenant_id=tenant_id,
        permissions=permissions,
        actor_id=actor_id,
    )


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


def _services(
    repository: InMemoryAiRepository,
) -> tuple[AgentExecutionService, AgentScheduleService]:
    audit = AuditService(repository)
    policy = Policy()
    settings = Settings(ai_repository="memory")
    execution = AgentExecutionService(
        repository=repository,
        retrieval=_FakeRetrieval(),
        audit=audit,
        policy=policy,
        settings=settings,
        tools=AgentToolService(repository=repository, audit=audit, policy=policy),
        permissions=PermissionMap(build_permission_map(settings)),
        memory=AgentMemoryService(repository=repository, audit=audit, policy=policy),
    )
    schedule = AgentScheduleService(
        repository=repository, execution_service=execution, audit=audit, policy=policy
    )
    return execution, schedule


def _create_agent(client: TestClient, code: str = "ops-agent", **definition) -> dict:
    body = {
        "code": code,
        "name": "Ops agent",
        "definition": definition
        or {
            "system_instructions": "Search knowledge.",
            "tools": ["knowledge.search"],
            "steps": [
                {
                    "key": "search",
                    "sequence": 1,
                    "tool": "knowledge.search",
                    "args": {"query": "{{query}}"},
                    "depends_on": [],
                }
            ],
        },
    }
    response = client.post("/api/v1/ai/agents", json=body)
    assert response.status_code == 201, response.text
    return response.json()


# --- Lifecycle ------------------------------------------------------------


def test_activate_deactivate_suspend_flow(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        activated = client.post(f"/api/v1/ai/agents/{agent['id']}/activate", json={})
        assert activated.status_code == 200, activated.text
        assert activated.json()["lifecycle_status"] == "active"
        assert activated.json()["enabled"] is True

        suspended = client.post(
            f"/api/v1/ai/agents/{agent['id']}/suspend",
            json={"reason": "incident"},
        )
        assert suspended.status_code == 200, suspended.text
        assert suspended.json()["lifecycle_status"] == "suspended"
        assert suspended.json()["enabled"] is False

        resumed = client.post(f"/api/v1/ai/agents/{agent['id']}/activate", json={})
        assert resumed.status_code == 200, resumed.text

        deactivated = client.post(
            f"/api/v1/ai/agents/{agent['id']}/deactivate", json={"note": "done"}
        )
        assert deactivated.status_code == 200, deactivated.text
        assert deactivated.json()["lifecycle_status"] == "inactive"


def test_lifecycle_requires_manage_capability(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
    with _client(repository, _principal("reader", READER)) as client:
        response = client.post(f"/api/v1/ai/agents/{agent['id']}/activate", json={})
        assert response.status_code == 403


def test_duplicate_and_soft_delete(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
        duplicated = client.post(
            f"/api/v1/ai/agents/{agent['id']}/duplicate",
            json={"code": "ops-agent-copy"},
        )
        assert duplicated.status_code == 201, duplicated.text
        copy = duplicated.json()
        assert copy["id"] != agent["id"]
        assert copy["duplicated_from_agent_id"] == agent["id"]
        assert copy["lifecycle_status"] == "draft"

        # A working copy cannot be deleted without explicit confirmation.
        denied = client.request(
            "DELETE", f"/api/v1/ai/agents/{copy['id']}", json={"confirm": False}
        )
        assert denied.status_code == 422, denied.text

        deleted = client.request(
            "DELETE", f"/api/v1/ai/agents/{copy['id']}", json={"confirm": True}
        )
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["deleted_at"] is not None

        catalog = client.get("/api/v1/ai/agents").json()
        assert all(item["id"] != copy["id"] for item in catalog)


def test_delete_blocked_while_execution_active(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "x"}},
        )
        assert execution.status_code == 202, execution.text
        blocked = client.request(
            "DELETE", f"/api/v1/ai/agents/{agent['id']}", json={"confirm": True}
        )
        assert blocked.status_code == 409, blocked.text


def test_working_config_rejects_secrets(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        ok = client.put(
            f"/api/v1/ai/agents/{agent['id']}/working-config",
            json={"tone": "concise"},
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["working_config"] == {"tone": "concise"}

        bad = client.put(
            f"/api/v1/ai/agents/{agent['id']}/working-config",
            json={"api_key": "sk-secret"},
        )
        assert bad.status_code == 422, bad.text


# --- Templates ------------------------------------------------------------


def test_templates_are_seeded_and_instantiate(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        templates = client.get("/api/v1/ai/agent-templates")
        assert templates.status_code == 200, templates.text
        items = templates.json()
        assert len(items) >= 8
        codes = {item["code"] for item in items}
        assert "enterprise-knowledge" in codes
        assert "product-bom-analysis" in codes

        # Seeding is idempotent.
        again = client.get("/api/v1/ai/agent-templates").json()
        assert len(again) == len(items)

        template = next(item for item in items if item["code"] == "enterprise-knowledge")
        created = client.post(
            f"/api/v1/ai/agent-templates/{template['id']}/instantiate",
            json={"code": "knowledge-from-template", "activate": True},
        )
        assert created.status_code == 201, created.text
        agent = created.json()
        assert agent["lifecycle_status"] == "active"
        assert agent["category"] == "knowledge"


def test_template_instantiate_rejects_secret_overrides(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        template = client.get("/api/v1/ai/agent-templates").json()[0]
        response = client.post(
            f"/api/v1/ai/agent-templates/{template['id']}/instantiate",
            json={"code": "leaky-template", "overrides": {"api_key": "abc"}},
        )
        assert response.status_code == 422, response.text


# --- Memory ---------------------------------------------------------------


def test_memory_write_list_and_tenant_isolation(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        created = client.post(
            "/api/v1/ai/agent-memory",
            json={
                "agent_id": agent["id"],
                "scope": "agent",
                "memory_key": "preference",
                "content": "User prefers metric units",
            },
        )
        assert created.status_code == 201, created.text
        entry = created.json()
        assert entry["owner_actor_id"] == 7

        listed = client.get("/api/v1/ai/agent-memory", params={"agent_id": agent["id"]})
        assert listed.status_code == 200, listed.text
        assert listed.json()["total"] == 1

    other = _principal("other", POWER_USER, tenant_id=OTHER_TENANT, actor_id=99)
    with _client(repository, other) as client:
        listed = client.get("/api/v1/ai/agent-memory", params={"agent_id": agent["id"]})
        assert listed.status_code == 200, listed.text
        assert listed.json()["total"] == 0


def test_memory_requires_scope_identifiers(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        response = client.post(
            "/api/v1/ai/agent-memory",
            json={"scope": "execution", "memory_key": "k", "content": "v"},
        )
        assert response.status_code == 422, response.text


def test_expired_memory_is_hidden(repository: InMemoryAiRepository) -> None:
    service = AgentMemoryService(
        repository=repository, audit=AuditService(repository), policy=Policy()
    )
    principal = _principal()

    class _Payload:
        agent_id = None
        scope = "agent"
        execution_id = None
        conversation_id = None
        memory_key = "expiring"
        content = "temp"
        metadata = {}
        classification = "internal"
        ttl_seconds = 1

    import asyncio

    entry = asyncio.run(service.write(principal, _Payload()))
    for row in repository._agent_memory:
        if row["id"] == entry["id"]:
            row["expires_at"] = datetime.now(UTC) - timedelta(seconds=1)

    items, total = asyncio.run(
        service.list(
            principal,
            agent_id=None,
            scope=None,
            execution_id=None,
            conversation_id=None,
            include_expired=False,
            limit=10,
            offset=0,
        )
    )
    assert total == 0 and items == []


def test_memory_write_requires_execute(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("reader", READER)) as client:
        response = client.post(
            "/api/v1/ai/agent-memory",
            json={"scope": "agent", "memory_key": "k", "content": "v"},
        )
        assert response.status_code == 403


def test_memory_cross_user_execution_denied(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("owner", POWER_USER, actor_id=7)) as client:
        agent = _create_agent(client)
        client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "x"}},
        ).json()

    intruder = _principal("intruder", EXECUTOR, actor_id=8)
    with _client(repository, intruder) as client:
        response = client.post(
            "/api/v1/ai/agent-memory",
            json={
                "scope": "execution",
                "execution_id": execution["id"],
                "memory_key": "k",
                "content": "v",
            },
        )
        assert response.status_code == 403, response.text


# --- Schedules ------------------------------------------------------------


def test_cron_expression_parsing() -> None:
    cron = CronExpression.parse("*/15 9-17 * * 1-5")
    moment = datetime(2026, 11, 2, 9, 7, tzinfo=UTC)  # Monday
    nxt = cron.next_after(moment)
    assert nxt == datetime(2026, 11, 2, 9, 15, tzinfo=UTC)
    with pytest.raises(ValidationError):
        CronExpression.parse("bad expression")


def test_schedule_create_and_duplicate_prevention(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
        created = client.post(
            "/api/v1/ai/agent-schedules",
            json={
                "agent_id": agent["id"],
                "name": "nightly",
                "schedule_kind": "recurring",
                "cron": "0 2 * * *",
                "timezone": "UTC",
                "input": {"query": "nightly"},
            },
        )
        assert created.status_code == 201, created.text
        schedule = created.json()
        assert schedule["next_run_at"] is not None

        execution, schedule_service = _services(repository)
        repository._agent_schedules[0]["next_run_at"] = datetime.now(UTC) - timedelta(
            minutes=1
        )

        import asyncio

        first = asyncio.run(schedule_service.run_due())
        assert first == 1
        second = asyncio.run(schedule_service.run_due())
        assert second == 0

        rows, total = asyncio.run(
            repository.list_agent_executions(
                TENANT, state=None, agent_id=agent["id"], limit=10, offset=0
            )
        )
        assert total == 1
        assert rows[0]["schedule_id"] == schedule["id"]
        assert rows[0]["schedule_run_key"]


def test_schedule_requires_active_agent(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        response = client.post(
            "/api/v1/ai/agent-schedules",
            json={
                "agent_id": agent["id"],
                "name": "too-soon",
                "schedule_kind": "recurring",
                "cron": "0 2 * * *",
            },
        )
        assert response.status_code == 422, response.text


def test_schedule_update_and_delete(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
        schedule = client.post(
            "/api/v1/ai/agent-schedules",
            json={
                "agent_id": agent["id"],
                "name": "every-hour",
                "schedule_kind": "recurring",
                "cron": "0 * * * *",
            },
        ).json()

        updated = client.patch(
            f"/api/v1/ai/agent-schedules/{schedule['id']}",
            json={"enabled": False},
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["enabled"] is False

        deleted = client.delete(f"/api/v1/ai/agent-schedules/{schedule['id']}")
        assert deleted.status_code == 200, deleted.text
        missing = client.get(f"/api/v1/ai/agent-schedules/{schedule['id']}")
        assert missing.status_code == 404


# --- Delegation -----------------------------------------------------------


def _published(client: TestClient, code: str, definition: dict) -> dict:
    created = client.post(
        "/api/v1/ai/agents",
        json={"code": code, "name": code, "definition": definition},
    )
    assert created.status_code == 201, created.text
    published = client.post(f"/api/v1/ai/agents/{created.json()['id']}/publish", json={})
    assert published.status_code == 200, published.text
    return published.json()


def test_delegation_runs_child_and_records_link(
    repository: InMemoryAiRepository,
) -> None:
    child_definition = {
        "system_instructions": "Answer.",
        "tools": ["knowledge.search"],
        "steps": [
            {
                "key": "search",
                "sequence": 1,
                "tool": "knowledge.search",
                "args": {"query": "{{query}}"},
                "depends_on": [],
            }
        ],
    }
    with _client(repository, _principal()) as client:
        child = _published(client, "child-agent", child_definition)
        parent_definition = {
            "system_instructions": "Orchestrate.",
            "tools": [],
            "delegation": {"enabled": True, "max_depth": 2, "agents": [child["id"]]},
            "steps": [
                {
                    "key": "delegate",
                    "sequence": 1,
                    "delegate_to": child["id"],
                    "depends_on": [],
                }
            ],
        }
        parent = _published(client, "parent-agent", parent_definition)
        created = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": parent["id"], "input": {"query": "pump"}},
        )
        assert created.status_code == 202, created.text
        execution = created.json()

    import asyncio

    execution_service, _ = _services(repository)

    async def scenario() -> None:
        claimed = await repository.claim_agent_execution(
            worker_id="worker", lease_seconds=120
        )
        assert claimed is not None and claimed["id"] == execution["id"]
        await execution_service.run_claimed(claimed)

    asyncio.run(scenario())

    with _client(repository, _principal()) as client:
        trace = client.get(
            f"/api/v1/ai/agent-executions/{execution['id']}/delegations"
        )
        assert trace.status_code == 200, trace.text
        rows = trace.json()["delegations"]
        assert len(rows) == 1
        assert rows[0]["child_agent_id"] == child["id"]
        assert rows[0]["child_execution_id"] is not None
        assert rows[0]["status"] == "completed"


def test_delegation_rejects_target_outside_allowlist(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        child = _published(
            client,
            "child-two",
            {
                "system_instructions": "Answer.",
                "tools": ["knowledge.search"],
                "steps": [
                    {
                        "key": "search",
                        "sequence": 1,
                        "tool": "knowledge.search",
                        "args": {"query": "{{query}}"},
                        "depends_on": [],
                    }
                ],
            },
        )
        parent = _published(
            client,
            "parent-two",
            {
                "system_instructions": "Orchestrate.",
                "tools": [],
                "delegation": {"enabled": True, "max_depth": 2, "agents": [999999]},
                "steps": [
                    {
                        "key": "delegate",
                        "sequence": 1,
                        "delegate_to": child["id"],
                        "depends_on": [],
                    }
                ],
            },
        )
        created = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": parent["id"], "input": {"query": "pump"}},
        )
        assert created.status_code == 202, created.text
        execution = created.json()

    import asyncio

    execution_service, _ = _services(repository)

    async def scenario() -> None:
        claimed = await repository.claim_agent_execution(
            worker_id="worker", lease_seconds=120
        )
        assert claimed is not None
        await execution_service.run_claimed(claimed)

    asyncio.run(scenario())

    with _client(repository, _principal()) as client:
        detail = client.get(f"/api/v1/ai/agent-executions/{execution['id']}").json()
        assert detail["status"] == "failed"


def test_delegation_self_reference_is_rejected_at_validation(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        created = client.post(
            "/api/v1/ai/agents",
            json={
                "code": "self-delegating",
                "name": "Self",
                "definition": {
                    "system_instructions": "Loop.",
                    "tools": ["knowledge.search"],
                    "delegation": {"enabled": True, "max_depth": 1, "agents": [1]},
                    "steps": [
                        {
                            "key": "search",
                            "sequence": 1,
                            "tool": "knowledge.search",
                            "args": {"query": "{{query}}"},
                            "depends_on": [],
                        }
                    ],
                },
            },
        )
        agent = created.json()
        response = client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
        assert response.status_code == 422, response.text


# --- Monitoring -----------------------------------------------------------


def test_monitoring_overview_and_health(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
        overview = client.get("/api/v1/ai/agent-monitoring/overview")
        assert overview.status_code == 200, overview.text
        body = overview.json()
        assert body["agents_total"] >= 1
        assert "executions" in body

        health = client.get(f"/api/v1/ai/agents/{agent['id']}/health")
        assert health.status_code == 200, health.text
        assert health.json()["health"] in {"healthy", "inactive", "degraded"}

        stats = client.get(f"/api/v1/ai/agents/{agent['id']}/stats")
        assert stats.status_code == 200, stats.text
        assert "total" in stats.json()

        failures = client.get("/api/v1/ai/agent-monitoring/failures")
        assert failures.status_code == 200, failures.text


def test_monitoring_is_tenant_isolated(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_agent(client)
        client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
    other = _principal("other", POWER_USER, tenant_id=OTHER_TENANT, actor_id=99)
    with _client(repository, other) as client:
        overview = client.get("/api/v1/ai/agent-monitoring/overview").json()
        assert overview["agents_total"] == 0
        missing = client.get(f"/api/v1/ai/agents/{agent['id']}/health")
        assert missing.status_code == 404
