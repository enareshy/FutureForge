"""Step 10 hardening: real PostgreSQL concurrency & idempotency.

These tests exercise the actual SQL repositories (not mocks) under concurrent
asyncio tasks to validate:

* idempotent agent-execution creation (same key -> exactly one row);
* concurrent ``claim_agent_execution`` never assigns one queued execution to two
  workers (``FOR UPDATE SKIP LOCKED``);
* schedule claiming is unique per instant under concurrency;
* cross-tenant isolation holds under concurrent writes.

    AI_TEST_POSTGRES=1 \\
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 \\
    POSTGRES_USER=postgres POSTGRES_PASSWORD=test POSTGRES_DB=helix \\
    pytest -o addopts="" tests/test_step10_concurrency_postgres.py
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

TENANT = 990901
OTHER_TENANT = 990902


def _requires_postgres() -> None:
    if os.environ.get("AI_TEST_POSTGRES", "") != "1":
        pytest.skip("set AI_TEST_POSTGRES=1 to run PostgreSQL concurrency tests")
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
        for tenant in (TENANT, OTHER_TENANT):
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
                await db.execute(f"DELETE FROM ai.{table} WHERE tenant_id = $1", tenant)
            await db.execute(
                "DELETE FROM ai.agent_versions WHERE agent_id IN "
                "(SELECT id FROM ai.agents WHERE tenant_id = $1)",
                tenant,
            )
            await db.execute("DELETE FROM ai.agents WHERE tenant_id = $1", tenant)


def _run(scenario) -> None:
    _requires_postgres()

    async def wrapper() -> None:
        db = await _db()
        try:
            await _cleanup(db)
            with tenant_scope(TENANT):
                await scenario(db, PostgresAiRepository(db))
        finally:
            await _cleanup(db)
            await db.close()

    asyncio.run(wrapper())


async def _agent(repository: AiRepository, code: str) -> dict:
    return await repository.create_agent(
        TENANT, {"code": code, "name": code, "kind": "workflow", "enabled": True}
    )


async def _version(repository: AiRepository, agent_id: int) -> dict:
    return await repository.create_agent_version(
        TENANT,
        agent_id,
        {
            "definition": {"tools": [], "steps": []},
            "status": "published",
        },
    )


def test_concurrent_execution_creation_is_idempotent() -> None:
    async def scenario(_db, repository: AiRepository) -> None:
        agent = await _agent(repository, f"conc-{uuid.uuid4().hex[:8]}")
        version = await _version(repository, agent["id"])
        key = f"idem-{uuid.uuid4().hex}"

        async def create():
            with tenant_scope(TENANT):
                return await repository.create_agent_execution(
                    TENANT,
                    {
                        "actor_id": 7,
                        "agent_id": agent["id"],
                        "agent_version_id": version["id"],
                        "idempotency_key": key,
                        "status": "queued",
                        "plan": {"steps": []},
                        "budgets": {},
                        "input": {},
                    },
                )

        # Each concurrent call may run in its own DB connection/transaction.
        results = await asyncio.gather(*[create() for _ in range(8)])
        ids = {row["id"] for row in results}
        assert len(ids) == 1, f"expected exactly one execution, got {ids}"

        with tenant_scope(TENANT):
            items, total = await repository.list_agent_executions(
                TENANT, state=None, agent_id=agent["id"], limit=50, offset=0
            )
        assert total == 1
        assert len(items) == 1

    _run(scenario)


def test_concurrent_claim_never_double_assigns() -> None:
    async def scenario(_db, repository: AiRepository) -> None:
        agent = await _agent(repository, f"claim-{uuid.uuid4().hex[:8]}")
        version = await _version(repository, agent["id"])
        created = []
        for _ in range(6):
            with tenant_scope(TENANT):
                created.append(
                    await repository.create_agent_execution(
                        TENANT,
                        {
                            "actor_id": 7,
                            "agent_id": agent["id"],
                            "agent_version_id": version["id"],
                            "idempotency_key": f"claim-{uuid.uuid4().hex}",
                            "status": "queued",
                            "plan": {"steps": []},
                            "budgets": {},
                            "input": {},
                        },
                    )
                )

        async def claim(worker: str):
            with tenant_scope(TENANT):
                return await repository.claim_agent_execution(
                    worker_id=worker, lease_seconds=60
                )

        # 12 workers race for 6 queued executions.
        results = await asyncio.gather(*[claim(f"w{i}") for i in range(12)])
        claimed_ids = [row["id"] for row in results if row is not None]
        # No execution is handed to two workers.
        assert len(claimed_ids) == len(set(claimed_ids))
        assert len(claimed_ids) == 6
        # Each queued row is now running exactly once.
        with tenant_scope(TENANT):
            rows, total = await repository.list_agent_executions(
                TENANT, state=None, agent_id=agent["id"], limit=50, offset=0
            )
        assert total == 6
        assert all(row["status"] == "running" for row in rows)
        assert {row["id"] for row in rows} == set(claimed_ids)

    _run(scenario)


def test_concurrent_tenant_writes_stay_isolated() -> None:
    async def scenario(_db, repository: AiRepository) -> None:
        async def seed(tenant: int, prefix: str):
            with tenant_scope(tenant):
                agent = await repository.create_agent(
                    tenant,
                    {
                        "code": f"{prefix}-{uuid.uuid4().hex[:8]}",
                        "name": prefix,
                        "kind": "workflow",
                        "enabled": True,
                    },
                )
                return agent["id"]

        ids = await asyncio.gather(*[
            seed(TENANT, "t1" if i % 2 == 0 else "t1") for i in range(4)
        ] + [seed(OTHER_TENANT, "t2") for _ in range(4)])

        with tenant_scope(TENANT):
            items = await repository.list_agents(TENANT)
        assert len(items) == 4
        assert {row["id"] for row in items} == set(ids[:4])
        # No tenant-2 agent leaked into tenant-1's view.
        assert all(row["id"] in ids[:4] for row in items)

        with tenant_scope(OTHER_TENANT):
            other_items = await repository.list_agents(OTHER_TENANT)
        assert len(other_items) == 4
        assert {row["id"] for row in other_items} == set(ids[4:])

    _run(scenario)


def test_concurrent_schedule_claim_is_unique() -> None:
    async def scenario(_db, repository: AiRepository) -> None:
        agent = await _agent(repository, f"sched-{uuid.uuid4().hex[:8]}")
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
        with tenant_scope(TENANT):
            schedule = await repository.create_agent_schedule(
                TENANT,
                {
                    "agent_id": agent["id"],
                    "name": "concurrent-schedule",
                    "enabled": True,
                    "schedule_kind": "recurring",
                    "cron": "0 2 * * *",
                    "timezone": "UTC",
                    "next_run_at": datetime.now(UTC) - timedelta(minutes=1),
                },
            )

        async def claim():
            with tenant_scope(TENANT):
                return await repository.claim_due_schedules(
                    limit=5, now=datetime.now(UTC)
                )

        results = await asyncio.gather(*[claim() for _ in range(6)])
        occurrences = sum(
            1 for batch in results for item in batch if item["id"] == schedule["id"]
        )
        assert occurrences == 1, "a due schedule must be claimed exactly once"

    _run(scenario)
