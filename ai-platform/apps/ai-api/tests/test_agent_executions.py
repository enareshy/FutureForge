from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal
from ai_api.application.services.agent_execution_service import AgentExecutionService
from ai_api.application.services.agent_tool_service import AgentToolService
from ai_api.application.services.audit_service import AuditService
from ai_api.config.settings import Settings
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.permissions import build_permission_map
from ai_api.security.policies import PermissionMap, Policy, Principal

TENANT = 1
POWER_USER = frozenset({"*:*"})
TESTER_PERMISSIONS = frozenset(
    {
        "ai.agents:read",
        "ai.agents:update",
        "ai.agents:execute",
        "ai.agent_tools:read",
        "ai.agent_tools:update",
        "ai.agent_approvals:read",
        "ai.agent_approvals:execute",
    }
)
REVIEWER_PERMISSIONS = frozenset(
    {"ai.agents:read", "ai.agent_approvals:read", "ai.agent_approvals:execute"}
)


class _FakeRetrieval:
    async def ranked_documents(
        self,
        principal: Principal,
        *,
        query: str,
        mode: str,
        filters: list,
        sort: str,
        limit: int,
    ) -> tuple[list[dict], str, bool]:
        return (
            [
                {
                    "source_code": "manual",
                    "title": "Pump",
                    "text": f"Maintenance for {query}",
                    "score": 0.9,
                }
            ],
            mode,
            False,
        )


def _service(repository: InMemoryAiRepository) -> AgentExecutionService:
    audit = AuditService(repository)
    policy = Policy()
    settings = Settings(ai_repository="memory")
    return AgentExecutionService(
        repository=repository,
        retrieval=_FakeRetrieval(),
        audit=audit,
        policy=policy,
        settings=settings,
        tools=AgentToolService(repository=repository, audit=audit, policy=policy),
        permissions=PermissionMap(build_permission_map(settings)),
    )


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


def _create_knowledge_agent(client: TestClient) -> dict:
    response = client.post(
        "/api/v1/ai/agents",
        json={
            "code": "knowledge-workflow",
            "name": "Knowledge workflow",
            "definition": {
                "system_instructions": "Search authorized knowledge.",
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
        },
    )
    assert response.status_code == 201, response.text
    agent = response.json()
    published = client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
    assert published.status_code == 200, published.text
    return published.json()


def _run(repository: InMemoryAiRepository, execution_id: int) -> None:
    async def scenario() -> None:
        execution = await repository.claim_agent_execution(
            worker_id="test-worker", lease_seconds=120
        )
        assert execution is not None and execution["id"] == execution_id
        await _service(repository).run_claimed(execution)

    asyncio.run(scenario())


def test_knowledge_execution_runs_steps_and_records_trace(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        created = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"query": "pump maintenance"},
                "idempotency_key": "run-knowledge-1",
            },
        )
        assert created.status_code == 202, created.text
        execution = created.json()
        assert execution["status"] == "queued"

        duplicate = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"query": "pump maintenance"},
                "idempotency_key": "run-knowledge-1",
            },
        )
        assert duplicate.json()["id"] == execution["id"]

    _run(repository, execution["id"])

    with _client(repository, _principal()) as client:
        detail = client.get(f"/api/v1/ai/agent-executions/{execution['id']}")
        body = detail.json()
        assert body["status"] == "completed"
        assert body["steps"][0]["status"] == "completed"
        assert body["invocations"][0]["status"] == "succeeded"
        result = client.get(
            f"/api/v1/ai/agent-executions/{execution['id']}/result"
        )
        assert result.status_code == 200
        assert result.json()["output"]["results"]["search"]["count"] == 1
        trace = client.get(
            f"/api/v1/ai/agent-executions/{execution['id']}/trace"
        )
        assert trace.json()["steps"][0]["step_key"] == "search"


def test_controlled_mutation_pauses_for_approval_then_resumes(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("tester", TESTER_PERMISSIONS)) as client:
        tool = client.post(
            "/api/v1/ai/agent-tools",
            json={
                "code": "platform.draft.create",
                "name": "Create platform draft",
                "definition": {
                    "capability": "platform.draft",
                    "read_only": False,
                    "risk_class": "controlled_mutation",
                    "requires_approval": True,
                    "idempotency": "required",
                    "input_schema": {"type": "object"},
                    "output_schema": {"type": "object"},
                },
            },
        ).json()
        assert client.post(
            f"/api/v1/ai/agent-tools/{tool['id']}/publish"
        ).status_code == 200
        agent = client.post(
            "/api/v1/ai/agents",
            json={
                "code": "draft-agent",
                "name": "Draft agent",
                "definition": {
                    "system_instructions": "Prepare a draft for review.",
                    "tools": ["platform.draft.create"],
                    "steps": [
                        {
                            "key": "draft",
                            "sequence": 1,
                            "tool": "platform.draft.create",
                            "args": {
                                "title": "{{title}}",
                                "content": "{{content}}",
                            },
                        }
                    ],
                },
            },
        ).json()
        assert client.post(
            f"/api/v1/ai/agents/{agent['id']}/publish", json={}
        ).status_code == 200
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"title": "Quarterly plan", "content": "Draft body"},
            },
        ).json()

    _run(repository, execution["id"])

    with _client(repository, _principal("tester", TESTER_PERMISSIONS)) as client:
        waiting = client.get(
            f"/api/v1/ai/agent-executions/{execution['id']}"
        ).json()
        assert waiting["status"] == "waiting_approval"
        approvals = client.get("/api/v1/ai/agent-approvals?status=pending").json()
        assert approvals["total"] == 1
        approval = approvals["items"][0]
        assert approval["operation_hash"]

        self_approval = client.post(
            f"/api/v1/ai/agent-approvals/{approval['id']}/approve", json={}
        )
        assert self_approval.status_code == 403

    with _client(repository, _principal("reviewer", REVIEWER_PERMISSIONS)) as client:
        approved = client.post(
            f"/api/v1/ai/agent-approvals/{approval['id']}/approve",
            json={"reason": "looks safe"},
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "approved"

    _run(repository, execution["id"])

    with _client(repository, _principal()) as client:
        done = client.get(f"/api/v1/ai/agent-executions/{execution['id']}").json()
        assert done["status"] == "completed"
        assert done["artifacts"][0]["artifact_type"] == "draft"
        assert done["artifacts"][0]["execution_id"] == execution["id"]


def test_rejection_cancels_execution(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("tester", TESTER_PERMISSIONS)) as client:
        tool = client.post(
            "/api/v1/ai/agent-tools",
            json={
                "code": "platform.draft.create",
                "name": "Draft",
                "definition": {
                    "capability": "platform.draft",
                    "read_only": False,
                    "risk_class": "controlled_mutation",
                    "requires_approval": True,
                    "idempotency": "required",
                    "input_schema": {"type": "object"},
                    "output_schema": {"type": "object"},
                },
            },
        ).json()
        client.post(f"/api/v1/ai/agent-tools/{tool['id']}/publish")
        agent = client.post(
            "/api/v1/ai/agents",
            json={
                "code": "rejected-agent",
                "name": "Rejected",
                "definition": {
                    "system_instructions": "Draft only.",
                    "tools": ["platform.draft.create"],
                    "steps": [
                        {
                            "key": "draft",
                            "tool": "platform.draft.create",
                            "args": {"title": "x", "content": "y"},
                        }
                    ],
                },
            },
        ).json()
        client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {}},
        ).json()
        _run(repository, execution["id"])
        approval = client.get("/api/v1/ai/agent-approvals").json()["items"][0]

    with _client(repository, _principal("reviewer", REVIEWER_PERMISSIONS)) as client:
        rejected = client.post(
            f"/api/v1/ai/agent-approvals/{approval['id']}/reject",
            json={"reason": "not allowed"},
        )
        assert rejected.status_code == 200
        execution_body = client.get(
            f"/api/v1/ai/agent-executions/{execution['id']}"
        ).json()
        assert execution_body["status"] == "cancelled"


def test_copilot_runs_published_agent_through_shared_engine(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        response = client.post(
            "/api/v1/ai/assistant/agents/run",
            json={
                "agent_id": agent["id"],
                "input": {"query": "pump"},
                "idempotency_key": "copilot-run-1",
            },
        )
        assert response.status_code == 202, response.text
        execution = response.json()
        assert execution["status"] == "queued"
        assert execution["agent_version_id"] == agent["current_version_id"]

    _run(repository, execution["id"])

    with _client(repository, _principal()) as client:
        audit = client.get("/api/v1/ai/audit").json()
        actions = {item["action"] for item in audit.get("items", [])}
        assert "ai.copilot.agent_run" in actions
        done = client.get(
            f"/api/v1/ai/agent-executions/{execution['id']}"
        ).json()
        assert done["status"] == "completed"


def test_lease_expiry_allows_reclaim_and_cancel_blocks_claim(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        first = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "one"}},
        ).json()
        second = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "two"}},
        ).json()

    async def scenario() -> None:
        claimed = await repository.claim_agent_execution(
            worker_id="worker-a", lease_seconds=60
        )
        assert claimed is not None
        other = await repository.claim_agent_execution(
            worker_id="worker-b", lease_seconds=60
        )
        assert other is None or other["id"] != first["id"]
        from datetime import UTC, datetime, timedelta

        await repository.update_agent_execution(
            TENANT,
            claimed["id"],
            expected_state=None,
            fields={"lease_expires_at": datetime.now(UTC) - timedelta(seconds=1)},
        )
        reclaimed = await repository.claim_agent_execution(
            worker_id="worker-b", lease_seconds=60
        )
        assert reclaimed is not None
        assert reclaimed["id"] == claimed["id"]
        assert reclaimed["lease_owner"] == "worker-b"

    asyncio.run(scenario())

    with _client(repository, _principal()) as client:
        cancelled = client.post(
            f"/api/v1/ai/agent-executions/{second['id']}/cancel"
        )
        assert cancelled.status_code == 200
        assert cancelled.json()["status"] in ("cancelled", "cancel_requested")

    async def no_claim() -> None:
        claimed = await repository.claim_agent_execution(
            worker_id="worker-c", lease_seconds=60
        )
        assert claimed is None or claimed["id"] != second["id"]

    asyncio.run(no_claim())


def test_execution_is_tenant_isolated(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "secret"}},
        ).json()

    other = Principal(
        user_id="other", username="other", tenant_id=2, permissions=POWER_USER
    )
    with _client(repository, other) as client:
        response = client.get(f"/api/v1/ai/agent-executions/{execution['id']}")
        assert response.status_code == 404
        approvals = client.get("/api/v1/ai/agent-approvals").json()
        assert approvals["total"] == 0


# --- Stage 6 execution governance (leases, approvals, runtime policy) -------


def _publish_tool(client: TestClient, code: str, definition: dict) -> dict:
    response = client.post(
        "/api/v1/ai/agent-tools",
        json={"code": code, "name": code, "definition": definition},
    )
    assert response.status_code == 201, response.text
    tool = response.json()
    published = client.post(f"/api/v1/ai/agent-tools/{tool['id']}/publish")
    assert published.status_code == 200, published.text
    return tool


def _publish_agent(client: TestClient, code: str, definition: dict) -> dict:
    response = client.post(
        "/api/v1/ai/agents",
        json={"code": code, "name": code, "definition": definition},
    )
    assert response.status_code == 201, response.text
    agent = response.json()
    published = client.post(f"/api/v1/ai/agents/{agent['id']}/publish", json={})
    assert published.status_code == 200, published.text
    return published.json()


def _draft_definition(tool_code: str) -> dict:
    return {
        "system_instructions": "Prepare a draft for review.",
        "tools": [tool_code],
        "steps": [
            {
                "key": "draft",
                "sequence": 1,
                "tool": tool_code,
                "args": {"title": "{{title}}", "content": "{{content}}"},
            }
        ],
    }


def _draft_tool_definition() -> dict:
    return {
        "capability": "platform.draft",
        "read_only": False,
        "risk_class": "controlled_mutation",
        "requires_approval": True,
        "idempotency": "required",
        "input_schema": {"type": "object"},
        "output_schema": {"type": "object"},
    }


def _plan_mutation(repository: InMemoryAiRepository, execution_id: int, mutate) -> None:
    async def scenario() -> None:
        execution = await repository.get_agent_execution(TENANT, execution_id)
        assert execution is not None
        plan = json.loads(json.dumps(execution["plan"]))
        mutate(plan)
        updated = await repository.update_agent_execution(
            TENANT,
            execution_id,
            expected_state=None,
            fields={"plan": plan},
        )
        assert updated is not None

    asyncio.run(scenario())


def _clear_checkpoints(repository: InMemoryAiRepository, execution_id: int) -> None:
    repository._agent_checkpoints[:] = [
        checkpoint
        for checkpoint in repository._agent_checkpoints
        if checkpoint["execution_id"] != execution_id
    ]


def test_stale_worker_cannot_commit_after_reclaim(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "pump"}},
        ).json()

    async def scenario() -> tuple[dict, dict]:
        stale = await repository.claim_agent_execution(
            worker_id="worker-a", lease_seconds=60
        )
        assert stale is not None and stale["id"] == execution["id"]
        assert stale["lease_generation"] == 1
        await repository.update_agent_execution(
            TENANT,
            execution["id"],
            expected_state=None,
            fields={"lease_expires_at": datetime.now(UTC) - timedelta(seconds=1)},
        )
        current = await repository.claim_agent_execution(
            worker_id="worker-b", lease_seconds=60
        )
        assert current is not None and current["id"] == execution["id"]
        assert current["lease_generation"] == 2
        return stale, current

    stale, current = asyncio.run(scenario())
    asyncio.run(_service(repository).run_claimed(stale))

    async def check() -> tuple[dict, list]:
        row = await repository.get_agent_execution(TENANT, execution["id"])
        assert row is not None
        assert row["status"] == "running"
        assert row["lease_owner"] == "worker-b"
        return row, await repository.list_execution_steps(TENANT, execution["id"])

    row, steps = asyncio.run(check())
    assert steps == []
    assert row["lease_generation"] == 2

    asyncio.run(_service(repository).run_claimed(current))

    async def final() -> dict:
        result = await repository.get_agent_execution(TENANT, execution["id"])
        assert result is not None
        return result

    assert asyncio.run(final())["status"] == "completed"


def test_renewal_requires_owner_and_generation(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "pump"}},
        )

    async def scenario() -> None:
        claimed = await repository.claim_agent_execution(
            worker_id="worker-a", lease_seconds=60
        )
        assert claimed is not None
        assert (
            await repository.renew_agent_execution_lease(
                TENANT,
                claimed["id"],
                worker_id="worker-a",
                lease_generation=int(claimed["lease_generation"]) - 1,
                lease_seconds=60,
            )
            is None
        )
        assert (
            await repository.renew_agent_execution_lease(
                TENANT,
                claimed["id"],
                worker_id="intruder",
                lease_generation=int(claimed["lease_generation"]),
                lease_seconds=60,
            )
            is None
        )
        renewed = await repository.renew_agent_execution_lease(
            TENANT,
            claimed["id"],
            worker_id="worker-a",
            lease_generation=int(claimed["lease_generation"]),
            lease_seconds=60,
        )
        assert renewed is not None
        assert renewed["lease_generation"] == claimed["lease_generation"]

    asyncio.run(scenario())


def test_approval_consumption_is_single_use(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("tester", TESTER_PERMISSIONS)) as client:
        _publish_tool(client, "platform.draft.create", _draft_tool_definition())
        agent = _publish_agent(
            client, "draft-agent", _draft_definition("platform.draft.create")
        )
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"title": "Quarterly", "content": "Body"},
            },
        ).json()
        _run(repository, execution["id"])
        approval = client.get("/api/v1/ai/agent-approvals").json()["items"][0]

    with _client(repository, _principal("reviewer", REVIEWER_PERMISSIONS)) as client:
        approved = client.post(
            f"/api/v1/ai/agent-approvals/{approval['id']}/approve", json={}
        )
        assert approved.status_code == 200
        row = approved.json()

    async def scenario() -> None:
        consumed = await repository.consume_agent_approval(
            TENANT,
            int(row["id"]),
            execution_id=int(execution["id"]),
            operation_hash=row["operation_hash"],
            consumed_by="worker-a",
        )
        assert consumed is not None
        assert consumed["consumed_at"] is not None
        assert (
            await repository.consume_agent_approval(
                TENANT,
                int(row["id"]),
                execution_id=int(execution["id"]),
                operation_hash=row["operation_hash"],
                consumed_by="worker-b",
            )
            is None
        )

    asyncio.run(scenario())
    _run(repository, execution["id"])

    async def final() -> tuple[dict, list]:
        result = await repository.get_agent_execution(TENANT, execution["id"])
        assert result is not None
        artifacts, _ = await repository.list_agent_artifacts(
            TENANT, execution_id=execution["id"], limit=10, offset=0
        )
        return result, artifacts

    result, artifacts = asyncio.run(final())
    assert result["status"] == "cancelled"
    assert result["error"]["class"] == "approval_invalid"
    assert artifacts == []


def test_consumed_approval_requires_fresh_approval_after_restart(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("tester", TESTER_PERMISSIONS)) as client:
        _publish_tool(client, "platform.draft.create", _draft_tool_definition())
        agent = _publish_agent(
            client, "draft-agent", _draft_definition("platform.draft.create")
        )
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"title": "Quarterly", "content": "Body"},
            },
        ).json()
        _run(repository, execution["id"])
        approval = client.get("/api/v1/ai/agent-approvals").json()["items"][0]

    with _client(repository, _principal("reviewer", REVIEWER_PERMISSIONS)) as client:
        assert (
            client.post(
                f"/api/v1/ai/agent-approvals/{approval['id']}/approve", json={}
            ).status_code
            == 200
        )

    _run(repository, execution["id"])

    async def reset() -> None:
        await repository.update_agent_execution(
            TENANT,
            execution["id"],
            expected_state=None,
            fields={
                "status": "queued",
                "error": None,
                "completed_at": None,
                "lease_owner": None,
                "lease_expires_at": None,
            },
        )

    asyncio.run(reset())
    _clear_checkpoints(repository, execution["id"])
    _run(repository, execution["id"])

    with _client(repository, _principal("tester", TESTER_PERMISSIONS)) as client:
        detail = client.get(f"/api/v1/ai/agent-executions/{execution['id']}").json()
        assert detail["status"] == "waiting_approval"
        approvals = client.get("/api/v1/ai/agent-approvals?status=pending").json()
        assert approvals["total"] == 1
        assert approvals["items"][0]["id"] != approval["id"]


def test_approval_hash_mismatch_cancels_execution(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("tester", TESTER_PERMISSIONS)) as client:
        _publish_tool(client, "platform.draft.create", _draft_tool_definition())
        agent = _publish_agent(
            client, "draft-agent", _draft_definition("platform.draft.create")
        )
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"title": "Quarterly", "content": "Body"},
            },
        ).json()
        _run(repository, execution["id"])
        approval = client.get("/api/v1/ai/agent-approvals").json()["items"][0]

    with _client(repository, _principal("reviewer", REVIEWER_PERMISSIONS)) as client:
        assert (
            client.post(
                f"/api/v1/ai/agent-approvals/{approval['id']}/approve", json={}
            ).status_code
            == 200
        )

    def mutate(plan: dict) -> None:
        plan["steps"][0]["args"]["content"] = "changed after approval"

    _plan_mutation(repository, execution["id"], mutate)
    _run(repository, execution["id"])

    async def final() -> tuple[dict, list]:
        result = await repository.get_agent_execution(TENANT, execution["id"])
        assert result is not None
        artifacts, _ = await repository.list_agent_artifacts(
            TENANT, execution_id=execution["id"], limit=10, offset=0
        )
        return result, artifacts

    result, artifacts = asyncio.run(final())
    assert result["status"] == "cancelled"
    assert result["error"]["class"] == "approval_invalid"
    assert artifacts == []


def test_runtime_rechecks_captured_caller_permissions(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "pump"}},
        ).json()

    def revoke(plan: dict) -> None:
        plan["caller"]["permissions"] = ["ai.agents:read"]

    _plan_mutation(repository, execution["id"], revoke)
    _run(repository, execution["id"])

    async def final() -> dict:
        result = await repository.get_agent_execution(TENANT, execution["id"])
        assert result is not None
        return result

    result = asyncio.run(final())
    assert result["status"] == "failed"
    assert result["error"]["class"] == "denied"


def test_disabled_tool_blocks_execution(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "pump"}},
        ).json()

    async def disable() -> None:
        tools, _ = await repository.list_agent_tools(
            TENANT, query="knowledge.search", enabled=None, limit=10, offset=0
        )
        tool = next(t for t in tools if t["code"] == "knowledge.search")
        updated = await repository.update_agent_tool(
            TENANT,
            int(tool["id"]),
            {"enabled": False},
            expected_lock=int(tool["lock_version"]),
        )
        assert updated is not None

    asyncio.run(disable())
    _run(repository, execution["id"])

    async def final() -> dict:
        result = await repository.get_agent_execution(TENANT, execution["id"])
        assert result is not None
        return result

    result = asyncio.run(final())
    assert result["status"] == "failed"
    assert result["error"]["class"] == "denied"


def test_tool_input_schema_is_enforced(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _publish_tool(
            client,
            "schema.tool",
            {
                "capability": "knowledge.read",
                "read_only": True,
                "risk_class": "read_only",
                "input_schema": {
                    "type": "object",
                    "required": ["query"],
                    "properties": {"query": {"type": "string"}},
                },
            },
        )
        agent = _publish_agent(
            client,
            "schema-agent",
            {
                "system_instructions": "Search.",
                "tools": ["schema.tool"],
                "steps": [
                    {"key": "search", "sequence": 1, "tool": "schema.tool", "args": {}}
                ],
            },
        )
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {}},
        ).json()

    _run(repository, execution["id"])

    async def final() -> tuple[dict, list]:
        result = await repository.get_agent_execution(TENANT, execution["id"])
        assert result is not None
        return result, await repository.list_tool_invocations(
            TENANT, execution["id"]
        )

    result, invocations = asyncio.run(final())
    assert result["status"] == "failed"
    assert result["error"]["class"] == "invalid_input"
    assert invocations == []


def test_tool_output_schema_is_enforced(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _publish_tool(
            client,
            "schema.output",
            {
                "capability": "knowledge.read",
                "read_only": True,
                "risk_class": "read_only",
                "input_schema": {"type": "object"},
                "output_schema": {
                    "type": "object",
                    "required": ["missing_field"],
                },
            },
        )
        agent = _publish_agent(
            client,
            "schema-output-agent",
            {
                "system_instructions": "Search.",
                "tools": ["schema.output"],
                "steps": [
                    {
                        "key": "search",
                        "sequence": 1,
                        "tool": "schema.output",
                        "args": {"query": "pump"},
                    }
                ],
            },
        )
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {}},
        ).json()

    _run(repository, execution["id"])

    async def final() -> tuple[dict, list]:
        result = await repository.get_agent_execution(TENANT, execution["id"])
        assert result is not None
        return result, await repository.list_tool_invocations(
            TENANT, execution["id"]
        )

    result, invocations = asyncio.run(final())
    assert result["status"] == "failed"
    assert result["error"]["class"] == "invalid_output"
    assert invocations[0]["status"] == "failed"
    assert invocations[0]["error_class"] == "invalid_output"


def test_capability_risk_mismatch_is_rejected(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _publish_tool(
            client,
            "mismatch.tool",
            {
                "capability": "knowledge.read",
                "read_only": True,
                "risk_class": "controlled_mutation",
                "requires_approval": False,
            },
        )
        agent = _publish_agent(
            client,
            "mismatch-agent",
            {
                "system_instructions": "Search.",
                "tools": ["mismatch.tool"],
                "steps": [
                    {
                        "key": "search",
                        "sequence": 1,
                        "tool": "mismatch.tool",
                        "args": {"query": "pump"},
                    }
                ],
            },
        )
        response = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {}},
        )
        assert response.status_code == 422
        assert "risk class" in response.json()["error"]["message"]


def test_budgets_are_clamped_and_validated(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        response = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"query": "pump"},
                "budgets": {
                    "max_steps": 10_000,
                    "max_tool_calls": 10_000,
                    "max_elapsed_seconds": 10_000,
                },
            },
        )
        assert response.status_code == 202, response.text
        assert response.json()["budgets"] == {
            "max_steps": 25,
            "max_tool_calls": 30,
            "max_elapsed_seconds": 600,
        }
        invalid = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"query": "pump"},
                "budgets": {"max_steps": -1},
            },
        )
        assert invalid.status_code == 422


def test_idempotency_key_conflict_is_rejected(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        first = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"query": "pump"},
                "idempotency_key": "same-key-123",
            },
        )
        assert first.status_code == 202
        conflict = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"query": "different"},
                "idempotency_key": "same-key-123",
            },
        )
        assert conflict.status_code == 409


def test_disabled_agent_stays_disabled_after_rollback(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        version_id = agent["current_version_id"]
        disabled = client.post(
            f"/api/v1/ai/agents/{agent['id']}/disable",
            json={"reason": "incident"},
        )
        assert disabled.status_code == 200, disabled.text
        assert disabled.json()["enabled"] is False
        rolled = client.post(
            f"/api/v1/ai/agents/{agent['id']}/rollback",
            json={"version_id": version_id},
        )
        assert rolled.status_code == 200, rolled.text
        assert rolled.json()["enabled"] is False
        assert rolled.json()["lifecycle_status"] == "disabled"
        blocked = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "pump"}},
        )
        assert blocked.status_code == 422


def test_uncertain_mutation_requires_reconciliation(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("tester", TESTER_PERMISSIONS)) as client:
        _publish_tool(client, "platform.draft.create", _draft_tool_definition())
        agent = _publish_agent(
            client, "draft-agent", _draft_definition("platform.draft.create")
        )
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"title": "Quarterly", "content": "Body"},
            },
        ).json()
        _run(repository, execution["id"])
        approval = client.get("/api/v1/ai/agent-approvals").json()["items"][0]

    with _client(repository, _principal("reviewer", REVIEWER_PERMISSIONS)) as client:
        assert (
            client.post(
                f"/api/v1/ai/agent-approvals/{approval['id']}/approve", json={}
            ).status_code
            == 200
        )

    async def seed_uncertain() -> None:
        steps = await repository.list_execution_steps(TENANT, execution["id"])
        step = next(item for item in steps if item["step_key"] == "draft")
        resolved = {"title": "Quarterly", "content": "Body"}
        arguments_hash = hashlib.sha256(
            json.dumps(
                resolved, sort_keys=True, separators=(",", ":"), default=str
            ).encode("utf-8")
        ).hexdigest()
        invocation = await repository.record_tool_invocation(
            TENANT,
            execution["id"],
            {
                "step_id": step["id"],
                "tool_code": "platform.draft.create",
                "status": "running",
                "outcome_certainty": "unknown",
                "arguments_hash": arguments_hash,
                "arguments_summary": resolved,
            },
        )
        assert invocation is not None

    asyncio.run(seed_uncertain())
    _run(repository, execution["id"])

    async def final() -> tuple[dict, list]:
        result = await repository.get_agent_execution(TENANT, execution["id"])
        assert result is not None
        artifacts, _ = await repository.list_agent_artifacts(
            TENANT, execution_id=execution["id"], limit=10, offset=0
        )
        return result, artifacts

    result, artifacts = asyncio.run(final())
    assert result["status"] == "failed"
    assert result["error"]["class"] == "reconciliation_required"
    assert artifacts == []


def test_retry_rejects_policy_denial(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "pump"}},
        ).json()

    def revoke(plan: dict) -> None:
        plan["caller"]["permissions"] = []

    _plan_mutation(repository, execution["id"], revoke)
    _run(repository, execution["id"])

    with _client(repository, _principal()) as client:
        retry = client.post(f"/api/v1/ai/agent-executions/{execution['id']}/retry")
        assert retry.status_code == 409
        assert retry.json()["error"]["message"] == "this failure is not retryable"


def test_disabled_agent_stays_disabled_after_publish(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        agent = _create_knowledge_agent(client)
        updated = client.patch(
            f"/api/v1/ai/agents/{agent['id']}",
            json={
                "definition": {
                    "system_instructions": "Search authorized knowledge.",
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
                "lock_version": agent["lock_version"],
            },
        )
        assert updated.status_code == 200, updated.text
        disabled = client.post(
            f"/api/v1/ai/agents/{agent['id']}/disable",
            json={"reason": "incident"},
        )
        assert disabled.status_code == 200
        assert disabled.json()["enabled"] is False

    async def draft_version() -> int:
        versions = await repository.list_agent_versions(TENANT, agent["id"])
        draft = next(item for item in versions if item["status"] == "draft")
        return int(draft["id"])

    version_id = asyncio.run(draft_version())
    with _client(repository, _principal()) as client:
        published = client.post(
            f"/api/v1/ai/agents/{agent['id']}/publish",
            json={"version_id": version_id},
        )
        assert published.status_code == 200, published.text
        assert published.json()["enabled"] is False
        assert published.json()["lifecycle_status"] == "disabled"
        blocked = client.post(
            "/api/v1/ai/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "pump"}},
        )
        assert blocked.status_code == 422


def test_expired_approval_is_replaced_on_resume(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("tester", TESTER_PERMISSIONS)) as client:
        _publish_tool(client, "platform.draft.create", _draft_tool_definition())
        agent = _publish_agent(
            client, "draft-agent", _draft_definition("platform.draft.create")
        )
        execution = client.post(
            "/api/v1/ai/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"title": "Quarterly", "content": "Body"},
            },
        ).json()
        _run(repository, execution["id"])
        approval = client.get("/api/v1/ai/agent-approvals").json()["items"][0]

    async def expire_and_requeue() -> None:
        for record in repository._agent_approvals:
            if int(record["id"]) == int(approval["id"]):
                record["expires_at"] = datetime.now(UTC) - timedelta(seconds=1)
        await repository.update_agent_execution(
            TENANT,
            execution["id"],
            expected_state=None,
            fields={"status": "queued", "lease_owner": None, "lease_expires_at": None},
        )

    asyncio.run(expire_and_requeue())
    _run(repository, execution["id"])

    with _client(repository, _principal("tester", TESTER_PERMISSIONS)) as client:
        detail = client.get(f"/api/v1/ai/agent-executions/{execution['id']}").json()
        assert detail["status"] == "waiting_approval"
        pending = client.get("/api/v1/ai/agent-approvals?status=pending").json()
        assert pending["total"] == 1
        assert pending["items"][0]["id"] != approval["id"]
        expired = client.get("/api/v1/ai/agent-approvals?status=expired").json()
        assert [item["id"] for item in expired["items"]] == [approval["id"]]
