"""Real PostgreSQL coverage for Copilot tool traces and controlled actions.

Opt-in integration tests exercising the actual SQL of migration 0021 against a
disposable PostgreSQL instance with the ``ai`` schema migrated.

    AI_TEST_POSTGRES=1 \\
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 \\
    POSTGRES_USER=postgres POSTGRES_PASSWORD=test \\
    pytest -o addopts="" tests/test_copilot_tools_actions_postgres.py
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

TENANT = 990351


def _requires_postgres() -> None:
    if os.environ.get("AI_TEST_POSTGRES", "") != "1":
        pytest.skip("set AI_TEST_POSTGRES=1 to run PostgreSQL copilot action tests")
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
        await db.execute(
            "DELETE FROM ai.copilot_tool_invocations WHERE tenant_id = $1", TENANT
        )
        await db.execute("DELETE FROM ai.copilot_actions WHERE tenant_id = $1", TENANT)
        await db.execute(
            "DELETE FROM ai.assistant_conversations WHERE tenant_id = $1", TENANT
        )


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


async def _conversation(repository: AiRepository) -> int:
    conversation = await repository.create_conversation(
        TENANT, {"actor_id": 1, "title": "tools", "metadata": {}}
    )
    message = await repository.add_message(
        TENANT,
        int(conversation["id"]),
        {"role": "assistant", "content": "", "request_id": None},
    )
    return int(message["id"])


def _action_payload(**overrides):
    payload = {
        "action_type": "change_request.create",
        "target": "ECR-1",
        "summary": "Create a draft change request",
        "arguments": {"priority": "HIGH"},
        "expected_effect": "A draft ECR exists",
        "evidence": [],
        "operation_hash": uuid.uuid4().hex,
        "risk_class": "controlled_mutation",
        "requested_by": 1,
        "requested_by_name": "requester",
        "request_id": "req-1",
        "expires_at": datetime.now(UTC) + timedelta(hours=1),
    }
    payload.update(overrides)
    return payload


def test_tool_invocation_trace_roundtrip() -> None:
    async def scenario(_db: PostgresDatabase, repository: AiRepository) -> None:
        message_id = await _conversation(repository)
        created = await repository.record_copilot_tool_invocation(
            TENANT,
            {
                "message_id": message_id,
                "tool_code": "enterprise.search",
                "status": "succeeded",
                "read_only": True,
                "arguments": {"feature": "copilot"},
                "result_summary": {"total": 1, "rows": [{"id": "P-100"}]},
                "duration_ms": 12,
                "request_id": "req-1",
            },
        )
        assert created["tool_code"] == "enterprise.search"
        rows = await repository.list_copilot_tool_invocations(TENANT, message_id)
        assert len(rows) == 1
        assert rows[0]["result_summary"]["rows"][0]["id"] == "P-100"

    _run(scenario)


def test_action_hash_is_unique_per_tenant() -> None:
    async def scenario(_db: PostgresDatabase, repository: AiRepository) -> None:
        digest = uuid.uuid4().hex
        first = await repository.create_copilot_action(
            TENANT, _action_payload(operation_hash=digest)
        )
        assert first is not None
        assert first["status"] == "proposed"
        second = await repository.create_copilot_action(
            TENANT, _action_payload(operation_hash=digest)
        )
        assert second is None, "a duplicate operation hash must not be recorded"

    _run(scenario)


def test_action_lifecycle_is_guarded_and_single_execution() -> None:
    async def scenario(_db: PostgresDatabase, repository: AiRepository) -> None:
        created = await repository.create_copilot_action(TENANT, _action_payload())
        assert created is not None
        action_id = int(created["id"])

        decided = await repository.decide_copilot_action(
            TENANT,
            action_id,
            status="approved",
            reviewer_actor_id=9,
            reviewer_name="approver",
            reason="ok",
        )
        assert decided is not None and decided["status"] == "approved"

        # A second decision on the same row is refused.
        again = await repository.decide_copilot_action(
            TENANT,
            action_id,
            status="rejected",
            reviewer_actor_id=9,
            reviewer_name="approver",
            reason="changed mind",
        )
        assert again is None

        claimed = await repository.claim_copilot_action_execution(
            TENANT,
            action_id,
            executor_actor_id=9,
            executor_name="approver",
        )
        assert claimed is not None and claimed["executed_by"] == 9

        # The claim is what prevents replay: a second claim sees no approved row.
        replay = await repository.claim_copilot_action_execution(
            TENANT,
            action_id,
            executor_actor_id=9,
            executor_name="approver",
        )
        assert replay is None

        completed = await repository.complete_copilot_action(
            TENANT,
            action_id,
            status="executed",
            result={"created": True},
            error_class=None,
        )
        assert completed is not None
        assert completed["status"] == "executed"
        assert completed["result"] == {"created": True}

    _run(scenario)


def test_actions_are_tenant_isolated() -> None:
    async def scenario(_db: PostgresDatabase, repository: AiRepository) -> None:
        created = await repository.create_copilot_action(TENANT, _action_payload())
        assert created is not None
        assert await repository.get_copilot_action(TENANT + 1, int(created["id"])) is None
        rows, total = await repository.list_copilot_actions(
            TENANT + 1,
            status=None,
            conversation_id=None,
            limit=10,
            offset=0,
        )
        assert rows == [] and total == 0

    _run(scenario)
