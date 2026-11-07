"""Real PostgreSQL coverage for Stage 6 completion tables (migration 0022).

Exercises the actual SQL repositories for agent templates, memory, schedules and
delegations, plus the durable duplicate-execution guards.

    AI_TEST_POSTGRES=1 \\
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 \\
    POSTGRES_USER=postgres POSTGRES_PASSWORD=test POSTGRES_DB=helix \\
    pytest -o addopts="" tests/test_agent_platform_completion_postgres.py
"""

from __future__ import annotations

import asyncio
import os
import socket
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from ai_api.application.ports import AiRepository
from ai_api.config.settings import get_settings
from ai_api.infrastructure.db import PostgresDatabase, system_scope, tenant_scope
from ai_api.infrastructure.repositories.postgres_ai_repository import (
    PostgresAiRepository,
)

pytestmark = pytest.mark.integration

TENANT = 990561


def _requires_postgres() -> None:
    if os.environ.get("AI_TEST_POSTGRES", "") != "1":
        pytest.skip("set AI_TEST_POSTGRES=1 to run PostgreSQL completion tests")
    settings = get_settings()
    try:
        with socket.create_connection(
            (settings.postgres_host, settings.postgres_port), timeout=1
        ):
            pass
    except OSError:
        pytest.skip("PostgreSQL is not reachable")


async def _db() -> PostgresDatabase:
    db = PostgresDatabase(get_settings())
    await db.connect()
    return db


async def _cleanup(db: PostgresDatabase) -> None:
    with system_scope():
        for table in (
            "agent_delegations",
            "agent_schedules",
            "agent_memory_entries",
            "agent_templates",
            "agent_execution_steps",
            "agent_tool_invocations",
            "agent_approvals",
            "agent_artifacts",
            "agent_checkpoints",
            "executions",
            "agent_version_tools",
        ):
            await db.execute(f"DELETE FROM ai.{table} WHERE tenant_id = $1", TENANT)
        await db.execute(
            "DELETE FROM ai.agent_versions WHERE agent_id IN "
            "(SELECT id FROM ai.agents WHERE tenant_id = $1)",
            TENANT,
        )
        await db.execute("DELETE FROM ai.agents WHERE tenant_id = $1", TENANT)


def _run(scenario) -> None:
    _requires_postgres()

    async def wrapper() -> None:
        db = await _db()
        try:
            await _cleanup(db)
            with tenant_scope(TENANT):
                await scenario(PostgresAiRepository(db))
        finally:
            await _cleanup(db)
            await db.close()

    asyncio.run(wrapper())


async def _agent(repository: AiRepository, code: str = "pg-agent") -> dict:
    return await repository.create_agent(
        TENANT,
        {"code": code, "name": code, "kind": "workflow", "enabled": True},
    )


async def _version(repository: AiRepository, agent_id: int) -> dict:
    return await repository.create_agent_version(
        TENANT,
        agent_id,
        {
            "definition": {
                "system_instructions": "Search.",
                "tools": ["knowledge.search"],
                "steps": [
                    {
                        "key": "s",
                        "sequence": 1,
                        "tool": "knowledge.search",
                        "args": {"query": "{{query}}"},
                        "depends_on": [],
                    }
                ],
            },
            "status": "published",
        },
    )


def test_template_upsert_and_list() -> None:
    async def scenario(repository: AiRepository) -> None:
        code = f"tpl-{uuid.uuid4().hex[:8]}"
        created = await repository.upsert_agent_template(
            TENANT,
            {
                "code": code,
                "name": "Template",
                "category": "knowledge",
                "definition": {"system_instructions": "x"},
                "system_tools": ["knowledge.search"],
                "enabled": True,
            },
        )
        assert created["id"]
        updated = await repository.upsert_agent_template(
            TENANT,
            {
                "code": code,
                "name": "Template v2",
                "category": "knowledge",
                "definition": {"system_instructions": "y"},
                "enabled": True,
            },
        )
        assert updated["id"] == created["id"]
        assert updated["name"] == "Template v2"
        rows, total = await repository.list_agent_templates(
            TENANT, category=None, enabled=None, limit=50, offset=0
        )
        assert total >= 1
        assert any(row["code"] == code for row in rows)

    _run(scenario)


def test_memory_upsert_scope_filter_and_purge() -> None:
    async def scenario(repository: AiRepository) -> None:
        agent = await _agent(repository)
        entry = await repository.upsert_agent_memory(
            TENANT,
            {
                "agent_id": agent["id"],
                "scope": "agent",
                "owner_actor_id": 7,
                "owner_username": "tester",
                "memory_key": "pref",
                "content": "metric",
                "expires_at": datetime.now(UTC) + timedelta(hours=1),
            },
        )
        assert entry["id"]
        rows, total = await repository.list_agent_memory(
            TENANT,
            agent_id=agent["id"],
            scope="agent",
            execution_id=None,
            conversation_id=None,
            owner_actor_id=7,
            include_expired=False,
            limit=10,
            offset=0,
        )
        assert total == 1 and rows[0]["memory_key"] == "pref"

        await repository.upsert_agent_memory(
            TENANT,
            {
                "agent_id": agent["id"],
                "scope": "agent",
                "owner_actor_id": 7,
                "owner_username": "tester",
                "memory_key": "pref",
                "content": "imperial",
                "expires_at": datetime.now(UTC) - timedelta(seconds=1),
            },
        )
        rows, total = await repository.list_agent_memory(
            TENANT,
            agent_id=agent["id"],
            scope=None,
            execution_id=None,
            conversation_id=None,
            owner_actor_id=7,
            include_expired=False,
            limit=10,
            offset=0,
        )
        assert total == 0
        purged = await repository.purge_expired_agent_memory(TENANT)
        assert purged == 1

    _run(scenario)


def test_schedule_claim_is_unique_per_instant() -> None:
    async def scenario(repository: AiRepository) -> None:
        agent = await _agent(repository, "pg-sched-agent")
        version = await _version(repository, agent["id"])
        await repository.set_agent_lifecycle(
            TENANT,
            agent["id"],
            lifecycle_status="active",
            enabled=True,
            updated_by="test",
        )
        await repository.set_agent_current_version(
            TENANT, agent["id"], version["id"], updated_by="test"
        )
        schedule = await repository.create_agent_schedule(
            TENANT,
            {
                "agent_id": agent["id"],
                "name": "pg-schedule",
                "enabled": True,
                "schedule_kind": "recurring",
                "cron": "0 2 * * *",
                "timezone": "UTC",
                "next_run_at": datetime.now(UTC) - timedelta(minutes=1),
            },
        )
        claimed = await repository.claim_due_schedules(
            limit=5, now=datetime.now(UTC)
        )
        assert any(item["id"] == schedule["id"] for item in claimed)
        again = await repository.claim_due_schedules(
            limit=5, now=datetime.now(UTC)
        )
        assert all(item["id"] != schedule["id"] for item in again)

    _run(scenario)


def test_delegation_unique_per_parent_step() -> None:
    async def scenario(repository: AiRepository) -> None:
        parent = await _agent(repository, "pg-parent")
        child = await _agent(repository, "pg-child")
        parent_version = await _version(repository, parent["id"])
        await _version(repository, child["id"])
        parent_exec = await repository.create_agent_execution(
            TENANT,
            {
                "actor_id": 7,
                "agent_id": parent["id"],
                "agent_version_id": parent_version["id"],
                "idempotency_key": f"e-{uuid.uuid4().hex}",
                "status": "queued",
                "plan": {"steps": []},
                "budgets": {},
                "input": {},
            },
        )
        record = await repository.create_agent_delegation(
            TENANT,
            {
                "parent_execution_id": parent_exec["id"],
                "parent_agent_id": parent["id"],
                "child_agent_id": child["id"],
                "step_key": "delegate",
                "mode": "sequential",
                "status": "running",
                "depth": 1,
                "input_summary": {},
            },
        )
        duplicate = await repository.create_agent_delegation(
            TENANT,
            {
                "parent_execution_id": parent_exec["id"],
                "parent_agent_id": parent["id"],
                "child_agent_id": child["id"],
                "step_key": "delegate",
                "mode": "sequential",
                "status": "running",
                "depth": 1,
                "input_summary": {},
            },
        )
        assert duplicate["id"] == record["id"]
        rows = await repository.list_agent_delegations(
            TENANT, parent_exec["id"]
        )
        assert len(rows) == 1

    _run(scenario)


def test_stats_aggregate_in_postgres() -> None:
    async def scenario(repository: AiRepository) -> None:
        agent = await _agent(repository, "pg-stats")
        version = await _version(repository, agent["id"])
        for index in range(2):
            await repository.create_agent_execution(
                TENANT,
                {
                    "actor_id": 7,
                    "agent_id": agent["id"],
                    "agent_version_id": version["id"],
                    "idempotency_key": f"stats-{index}-{uuid.uuid4().hex}",
                    "status": "queued",
                    "plan": {"steps": []},
                    "budgets": {},
                    "input": {},
                },
            )
        stats = await repository.agent_execution_stats(
            TENANT, agent_id=agent["id"]
        )
        assert stats["total"] == 2

    _run(scenario)
