"""Integration tests against external backing services (Phase 13).

These tests are **opt-in**: each backing service is exercised only when the
operator explicitly enables it via an ``AI_TEST_*`` environment variable (and, for
network services, only when the endpoint is reachable). This keeps the default
suite hermetic and fast while still providing real integration coverage - notably
PostgreSQL + pgvector, which is part of the platform's mandatory stack.

Enable examples:

    AI_TEST_POSTGRES=1 pytest -m integration tests/test_integration_services.py
    AI_TEST_REDIS=1 AI_TEST_KAFKA=1 pytest -m integration

The optional live LLM provider test is separate from the mock-based suites and
must be explicitly opted into (`AI_TEST_LIVE_LLM=1`) with real provider config.
"""

from __future__ import annotations

import asyncio
import os
import socket
from urllib.parse import urlparse

import httpx
import pytest

from ai_api.config.settings import get_settings

pytestmark = pytest.mark.integration


def _enabled(name: str) -> bool:
    return os.environ.get(f"AI_TEST_{name.upper()}", "") == "1"


def _tcp_reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


def _requires(name: str) -> None:
    if not _enabled(name):
        pytest.skip(f"set AI_TEST_{name.upper()}=1 to run this integration test")


@pytest.fixture(autouse=True)
def _integration_db_system_scope():
    """These legacy integration tests act as the deployment/system role.

    Tenant-bound RLS behavior has its own dedicated tests in
    ``test_rls_tenant_isolation.py``; here the fixtures intentionally seed
    multiple tenants through raw SQL.
    """

    if not _enabled("postgres"):
        yield
        return
    from ai_api.infrastructure.db.tenant_context import system_scope

    with system_scope():
        yield


def test_postgres_pgvector_roundtrip() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from ai_api.infrastructure.db import PostgresDatabase

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            await db.execute(
                "CREATE TEMP TABLE ai_pgvector_probe (id int, embedding vector(3))"
            )
            for row_id, vector in ((1, "[1,0,0]"), (2, "[0,1,0]"), (3, "[0,0,1]")):
                await db.execute(
                    "INSERT INTO ai_pgvector_probe (id, embedding) VALUES ($1, $2::vector)",
                    row_id,
                    vector,
                )
            rows = await db.fetch(
                "SELECT id, embedding <=> $1::vector AS distance "
                "FROM ai_pgvector_probe ORDER BY distance LIMIT 2",
                "[0.9,0.1,0.0]",
            )
            assert [row["id"] for row in rows] == [1, 2]
            assert rows[0]["distance"] < rows[1]["distance"]
        finally:
            await db.close()

    try:
        asyncio.run(scenario())
    except Exception as exc:  # noqa: BLE001
        message = str(exc).lower()
        if "vector" in message and ("type" in message or "extension" in message):
            pytest.skip("pgvector extension is not available on this database")
        raise


def test_redis_reachable() -> None:
    _requires("redis")
    parsed = urlparse(get_settings().redis_url)
    assert _tcp_reachable(parsed.hostname or "127.0.0.1", parsed.port or 6379)


def test_kafka_reachable() -> None:
    _requires("kafka")
    host, _, port = get_settings().kafka_bootstrap_servers.partition(":")
    assert _tcp_reachable(host, int(port or "9092")), "Kafka broker is not reachable"


def test_opensearch_reachable() -> None:
    _requires("opensearch")
    settings = get_settings()
    response = httpx.get(settings.opensearch_url, timeout=5.0)
    assert response.status_code in (200, 401)


def test_object_storage_reachable() -> None:
    _requires("objectstorage")
    response = httpx.get(get_settings().s3_endpoint, timeout=5.0)
    assert response.status_code < 500


def test_mlflow_reachable() -> None:
    _requires("mlflow")
    from ai_api.infrastructure.ml import build_tracking_backend

    backend = build_tracking_backend(get_settings())
    status = asyncio.run(backend.status())
    assert status["available"] is True


def test_observability_otlp_endpoint_reachable() -> None:
    _requires("otel")
    parsed = urlparse(get_settings().otel_exporter_otlp_endpoint)
    assert _tcp_reachable(parsed.hostname or "127.0.0.1", parsed.port or 4317)


def test_postgres_event_store_tenant_isolation() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from ai_api.domain.events import AI_REQUEST_COMPLETED, build_envelope
    from ai_api.infrastructure.db import PostgresDatabase
    from ai_api.infrastructure.events.postgres_event_store import PostgresEventStore

    class Rollback(Exception):
        pass

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            try:
                async with db.transaction() as tx:
                    store = PostgresEventStore(tx)
                    one = build_envelope(
                        AI_REQUEST_COMPLETED,
                        tenant_id=1,
                        data={"operation": "chat", "status": "succeeded"},
                    ).to_record()
                    two = build_envelope(
                        AI_REQUEST_COMPLETED,
                        tenant_id=2,
                        data={"operation": "chat", "status": "succeeded"},
                    ).to_record()
                    await store.publish([one, two])

                    tenant_one = {
                        row["event_id"] for row in await store.list_events(1, limit=500)
                    }
                    tenant_two = {
                        row["event_id"] for row in await store.list_events(2, limit=500)
                    }
                    assert one["event_id"] in tenant_one
                    assert two["event_id"] not in tenant_one
                    assert two["event_id"] in tenant_two
                    assert one["event_id"] not in tenant_two
                    assert await store.get_event(1, two["event_id"]) is None
                    assert await store.get_event(2, two["event_id"]) is not None

                    group = f"itest-{one['event_id']}"
                    await store.record_failure(
                        one["event_id"], group, "boom", max_attempts=2
                    )
                    assert (
                        await store.record_failure(
                            one["event_id"], group, "boom", max_attempts=2
                        )
                        == "dead"
                    )
                    dead_one = {
                        row["event_id"]
                        for row in await store.list_dead_letters(1, limit=500)
                    }
                    dead_two = {
                        row["event_id"]
                        for row in await store.list_dead_letters(2, limit=500)
                    }
                    assert one["event_id"] in dead_one
                    assert two["event_id"] not in dead_one
                    assert one["event_id"] not in dead_two
                    assert (await store.delivery_stats(2, group))["dead"] == 0

                    await store.record_failure(
                        two["event_id"], group, "boom", max_attempts=5
                    )
                    assert await store.replay(1, two["event_id"], group) is False
                    assert await store.replay(2, two["event_id"], group) is True
                    raise Rollback
            except Rollback:
                pass
        finally:
            await db.close()

    asyncio.run(scenario())


def test_live_llm_provider_chat() -> None:
    _requires("live_llm")
    settings = get_settings()
    if settings.llm_provider.strip().lower() in ("", "mock"):
        pytest.skip("a non-mock LLM provider must be configured for the live test")

    from ai_api.application.services.model_gateway import ModelGateway
    from ai_api.domain.models.provider import ChatRequest, Message, Role
    from ai_api.infrastructure.providers.registry import (
        build_default_registry,
        default_chat_model,
    )

    gateway = ModelGateway(registry=build_default_registry(settings), settings=settings)

    async def scenario() -> None:
        response = await gateway.chat(
            ChatRequest(
                messages=(Message(role=Role.user, content="Reply with the word: pong"),),
                model=default_chat_model(settings),
                max_output_tokens=16,
            )
        )
        assert response.content
        assert response.is_mock is False

    asyncio.run(scenario())


class _Rollback(Exception):
    pass


async def _seed_agent_execution(
    tx,
    *,
    tenant_id: int = 901,
    status: str = "queued",
    idempotency_key: str | None = None,
) -> tuple[dict, dict]:
    import uuid

    from ai_api.infrastructure.repositories.postgres_ai_repository import (
        PostgresAiRepository,
    )

    suffix = uuid.uuid4().hex[:12]
    agent = await tx.fetchrow(
        """
        INSERT INTO ai.agents (tenant_id, code, name, lifecycle_status)
        VALUES ($1, $2, $3, 'published')
        RETURNING id, tenant_id
        """,
        tenant_id,
        f"itest-agent-{suffix}",
        "Integration agent",
    )
    version = await tx.fetchrow(
        """
        INSERT INTO ai.agent_versions (agent_id, version, definition, status)
        VALUES ($1, 1, '{}'::jsonb, 'draft')
        RETURNING id, agent_id
        """,
        agent["id"],
    )
    repository = PostgresAiRepository(tx)
    execution = await repository.create_agent_execution(
        tenant_id,
        {
            "agent_id": agent["id"],
            "agent_version_id": version["id"],
            "status": status,
            "idempotency_key": idempotency_key,
            "plan": {"steps": []},
            "budgets": {"max_steps": 5},
            "input": {"query": "pump"},
            "input_hash": "hash-1",
        },
    )
    return execution, {"agent": agent, "version": version}


def test_postgres_agent_execution_lease_fencing() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from ai_api.infrastructure.db import PostgresDatabase
    from ai_api.infrastructure.repositories.postgres_ai_repository import (
        PostgresAiRepository,
    )

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            try:
                async with db.transaction() as tx:
                    repository = PostgresAiRepository(tx)
                    execution, _ = await _seed_agent_execution(tx)
                    execution_id = int(execution["id"])

                    claimed = await repository.claim_agent_execution(
                        worker_id="worker-a", lease_seconds=60
                    )
                    assert claimed is not None
                    assert int(claimed["id"]) == execution_id
                    assert claimed["lease_owner"] == "worker-a"
                    assert int(claimed["lease_generation"]) == 1

                    stale_update = await repository.update_agent_execution(
                        claimed["tenant_id"],
                        execution_id,
                        expected_state=None,
                        fields={"current_step": "stale"},
                        lease_owner="worker-a",
                        lease_generation=0,
                    )
                    assert stale_update is None
                    wrong_owner = await repository.update_agent_execution(
                        claimed["tenant_id"],
                        execution_id,
                        expected_state=None,
                        fields={"current_step": "stale"},
                        lease_owner="worker-b",
                        lease_generation=1,
                    )
                    assert wrong_owner is None
                    owned_update = await repository.update_agent_execution(
                        claimed["tenant_id"],
                        execution_id,
                        expected_state=None,
                        fields={"current_step": "search"},
                        lease_owner="worker-a",
                        lease_generation=1,
                    )
                    assert owned_update is not None
                    assert owned_update["current_step"] == "search"

                    assert (
                        await repository.renew_agent_execution_lease(
                            claimed["tenant_id"],
                            execution_id,
                            worker_id="worker-a",
                            lease_generation=0,
                            lease_seconds=60,
                        )
                        is None
                    )
                    renewed = await repository.renew_agent_execution_lease(
                        claimed["tenant_id"],
                        execution_id,
                        worker_id="worker-a",
                        lease_generation=1,
                        lease_seconds=60,
                    )
                    assert renewed is not None

                    await tx.execute(
                        "UPDATE ai.executions SET lease_expires_at = now() - interval '1 second' "
                        "WHERE id = $1",
                        execution_id,
                    )
                    reclaimed = await repository.claim_agent_execution(
                        worker_id="worker-b", lease_seconds=60
                    )
                    assert reclaimed is not None
                    assert int(reclaimed["id"]) == execution_id
                    assert int(reclaimed["lease_generation"]) == 2

                    assert (
                        await repository.update_agent_execution(
                            claimed["tenant_id"],
                            execution_id,
                            expected_state=None,
                            fields={"current_step": "stale-worker"},
                            lease_owner="worker-a",
                            lease_generation=1,
                        )
                        is None
                    )
                    fresh = await repository.update_agent_execution(
                        claimed["tenant_id"],
                        execution_id,
                        expected_state=None,
                        fields={"current_step": "fresh-worker"},
                        lease_owner="worker-b",
                        lease_generation=2,
                    )
                    assert fresh is not None
                    assert fresh["current_step"] == "fresh-worker"
                    raise _Rollback
            except _Rollback:
                pass
        finally:
            await db.close()

    asyncio.run(scenario())


def test_postgres_approval_consumption_is_single_use() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from datetime import UTC, datetime, timedelta

    from ai_api.infrastructure.db import PostgresDatabase
    from ai_api.infrastructure.repositories.postgres_ai_repository import (
        PostgresAiRepository,
    )

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            try:
                async with db.transaction() as tx:
                    repository = PostgresAiRepository(tx)
                    execution, _ = await _seed_agent_execution(
                        tx, status="running"
                    )
                    tenant_id = int(execution["tenant_id"])
                    execution_id = int(execution["id"])
                    data = {
                        "execution_id": execution_id,
                        "step_key": "draft",
                        "tool_code": "platform.draft.create",
                        "tool_version_id": None,
                        "operation_hash": "op-hash-1",
                        "target": "platform.draft.create:platform.draft",
                        "input_summary": {"title": "Quarterly"},
                        "risk_class": "controlled_mutation",
                        "expires_at": datetime.now(UTC) + timedelta(hours=1),
                    }
                    first = await repository.create_agent_approval(
                        tenant_id, data
                    )
                    duplicate = await repository.create_agent_approval(
                        tenant_id, data
                    )
                    assert int(duplicate["id"]) == int(first["id"])
                    active_count = await tx.fetchval(
                        "SELECT count(*) FROM ai.agent_approvals "
                        "WHERE tenant_id = $1 AND execution_id = $2 "
                        "AND operation_hash = $3 AND consumed_at IS NULL",
                        tenant_id,
                        execution_id,
                        "op-hash-1",
                    )
                    assert int(active_count) == 1

                    approved = await repository.decide_agent_approval(
                        tenant_id,
                        int(first["id"]),
                        status="approved",
                        reviewer_actor_id=7,
                        reviewer_name="reviewer",
                        reason="ok",
                    )
                    assert approved is not None

                    consumed = await repository.consume_agent_approval(
                        tenant_id,
                        int(first["id"]),
                        execution_id=execution_id,
                        operation_hash="op-hash-1",
                        consumed_by="worker-a",
                    )
                    assert consumed is not None
                    assert consumed["consumed_by"] == "worker-a"
                    assert consumed["consumed_at"] is not None
                    assert (
                        await repository.consume_agent_approval(
                            tenant_id,
                            int(first["id"]),
                            execution_id=execution_id,
                            operation_hash="op-hash-1",
                            consumed_by="worker-b",
                        )
                        is None
                    )

                    replacement = await repository.create_agent_approval(
                        tenant_id, data
                    )
                    assert int(replacement["id"]) != int(first["id"])
                    assert replacement["status"] == "pending"

                    await tx.execute(
                        "UPDATE ai.agent_approvals "
                        "SET expires_at = now() - interval '1 second' "
                        "WHERE id = $1",
                        int(replacement["id"]),
                    )
                    renewed = await repository.create_agent_approval(
                        tenant_id, data
                    )
                    assert int(renewed["id"]) not in (
                        int(first["id"]),
                        int(replacement["id"]),
                    )
                    expired = await repository.get_agent_approval(
                        tenant_id, int(replacement["id"])
                    )
                    assert expired is not None
                    assert expired["status"] == "expired"
                    raise _Rollback
            except _Rollback:
                pass
        finally:
            await db.close()

    asyncio.run(scenario())


def test_postgres_agent_execution_idempotency_reuses_record() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from ai_api.infrastructure.db import PostgresDatabase
    from ai_api.infrastructure.repositories.postgres_ai_repository import (
        PostgresAiRepository,
    )

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            try:
                async with db.transaction() as tx:
                    repository = PostgresAiRepository(tx)
                    execution, ids = await _seed_agent_execution(
                        tx, idempotency_key="itest-idempotent-key"
                    )
                    tenant_id = int(execution["tenant_id"])
                    replay = await repository.create_agent_execution(
                        tenant_id,
                        {
                            "agent_id": ids["agent"]["id"],
                            "agent_version_id": ids["version"]["id"],
                            "status": "queued",
                            "idempotency_key": "itest-idempotent-key",
                            "plan": {"steps": []},
                            "budgets": {"max_steps": 5},
                            "input": {"query": "pump"},
                            "input_hash": "hash-1",
                        },
                    )
                    assert int(replay["id"]) == int(execution["id"])
                    assert replay["input_hash"] == "hash-1"
                    count = await tx.fetchval(
                        "SELECT count(*) FROM ai.executions "
                        "WHERE tenant_id = $1 AND idempotency_key = $2",
                        tenant_id,
                        "itest-idempotent-key",
                    )
                    assert int(count) == 1
                    raise _Rollback
            except _Rollback:
                pass
        finally:
            await db.close()

    asyncio.run(scenario())


def test_postgres_stage6_governance_migration_applied() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from ai_api.infrastructure.db import PostgresDatabase

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            # Runtime roles are intentionally denied on ai.schema_migrations
            # (see provision_roles.sql). Under least-privilege provisioning the
            # bookkeeping row is not readable, so treat that as expected rather
            # than a failure; the migration's actual effects are asserted below.
            try:
                version = await db.fetchval(
                    "SELECT version FROM ai.schema_migrations WHERE version LIKE '0013%'"
                )
            except Exception as exc:  # asyncpg.InsufficientPrivilegeError
                if "permission denied" not in str(exc).lower():
                    raise
            else:
                assert version is not None

            columns = {
                row["column_name"]
                for row in await db.fetch(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = 'ai' AND table_name = 'executions'
                    """
                )
            }
            assert "lease_generation" in columns
            invocation_columns = {
                row["column_name"]
                for row in await db.fetch(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = 'ai' AND table_name = 'agent_tool_invocations'
                    """
                )
            }
            assert "result" in invocation_columns
            approval_columns = {
                row["column_name"]
                for row in await db.fetch(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = 'ai' AND table_name = 'agent_approvals'
                    """
                )
            }
            assert {"consumed_at", "consumed_by"} <= approval_columns

            index = await db.fetchrow(
                "SELECT indexdef FROM pg_indexes "
                "WHERE schemaname = 'ai' AND indexname = 'agent_approvals_active_uniq'"
            )
            assert index is not None
            assert "UNIQUE" in index["indexdef"]
            assert "consumed_at IS NULL" in index["indexdef"]
            legacy = await db.fetchval(
                "SELECT 1 FROM pg_constraint "
                "WHERE conname = 'agent_approvals_hash_uniq'"
            )
            assert legacy is None
        finally:
            await db.close()

    asyncio.run(scenario())


def test_postgres_execution_owned_writes_are_fenced() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from datetime import UTC, datetime

    from ai_api.infrastructure.db import PostgresDatabase
    from ai_api.infrastructure.repositories.postgres_ai_repository import (
        PostgresAiRepository,
    )

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            try:
                async with db.transaction() as tx:
                    repository = PostgresAiRepository(tx)
                    execution, _ = await _seed_agent_execution(tx)
                    claimed = await repository.claim_agent_execution(
                        worker_id="worker-a", lease_seconds=60
                    )
                    assert claimed is not None
                    tenant_id = int(claimed["tenant_id"])
                    execution_id = int(claimed["id"])
                    generation = int(claimed["lease_generation"])

                    step_data = {
                        "step_key": "search",
                        "sequence": 1,
                        "tool_code": "knowledge.search",
                        "status": "running",
                        "attempts": 1,
                        "input_summary": {"query": "pump"},
                        "started_at": datetime.now(UTC),
                    }
                    assert (
                        await repository.upsert_execution_step(
                            tenant_id,
                            execution_id,
                            step_data,
                            lease_owner="worker-a",
                            lease_generation=generation + 1,
                        )
                        is None
                    )
                    assert (
                        await repository.upsert_execution_step(
                            tenant_id,
                            execution_id,
                            step_data,
                            lease_owner="worker-b",
                            lease_generation=generation,
                        )
                        is None
                    )
                    step = await repository.upsert_execution_step(
                        tenant_id,
                        execution_id,
                        step_data,
                        lease_owner="worker-a",
                        lease_generation=generation,
                    )
                    assert step is not None

                    invocation_data = {
                        "step_id": step["id"],
                        "tool_code": "knowledge.search",
                        "status": "running",
                        "arguments_hash": "args-hash",
                        "arguments_summary": {"query": "pump"},
                    }
                    assert (
                        await repository.record_tool_invocation(
                            tenant_id,
                            execution_id,
                            invocation_data,
                            lease_owner="worker-a",
                            lease_generation=generation + 1,
                        )
                        is None
                    )
                    invocation = await repository.record_tool_invocation(
                        tenant_id,
                        execution_id,
                        invocation_data,
                        lease_owner="worker-a",
                        lease_generation=generation,
                    )
                    assert invocation is not None

                    assert (
                        await repository.add_execution_checkpoint(
                            tenant_id,
                            execution_id,
                            {"state": {"completed": []}},
                            lease_owner="worker-a",
                            lease_generation=generation + 1,
                        )
                        is None
                    )
                    checkpoint = await repository.add_execution_checkpoint(
                        tenant_id,
                        execution_id,
                        {"state": {"completed": []}},
                        lease_owner="worker-a",
                        lease_generation=generation,
                    )
                    assert checkpoint is not None

                    assert (
                        await repository.update_tool_invocation(
                            tenant_id,
                            int(invocation["id"]),
                            {"status": "succeeded", "result": {"count": 1}},
                            lease_owner="worker-a",
                            lease_generation=generation + 1,
                        )
                        is None
                    )
                    updated = await repository.update_tool_invocation(
                        tenant_id,
                        int(invocation["id"]),
                        {
                            "status": "succeeded",
                            "result": {"count": 1},
                            "outcome_certainty": "certain",
                            "finished_at": datetime.now(UTC),
                        },
                        lease_owner="worker-a",
                        lease_generation=generation,
                    )
                    assert updated is not None
                    assert updated["result"] == {"count": 1}

                    latest = await repository.latest_tool_invocation(
                        tenant_id, execution_id, int(step["id"])
                    )
                    assert latest is not None
                    assert latest["status"] == "succeeded"
                    raise _Rollback
            except _Rollback:
                pass
        finally:
            await db.close()

    asyncio.run(scenario())


def test_postgres_authoritative_chunks_use_live_labels() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from ai_api.infrastructure.db import PostgresDatabase
    from ai_api.infrastructure.repositories.postgres_ai_repository import (
        PostgresAiRepository,
    )

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            try:
                async with db.transaction() as tx:
                    repository = PostgresAiRepository(tx)
                    import uuid

                    suffix = uuid.uuid4().hex[:10]
                    source = await tx.fetchrow(
                        """
                        INSERT INTO ai.knowledge_sources
                            (tenant_id, code, name, kind, classification, acl)
                        VALUES ($1, $2, $3, 'manual', 'internal', $4)
                        RETURNING id, tenant_id
                        """,
                        902,
                        f"itest-lifecycle-{suffix}",
                        "Lifecycle",
                        {"users": ["alice"]},
                    )
                    document = await tx.fetchrow(
                        """
                        INSERT INTO ai.documents
                            (tenant_id, source_id, external_id, title, mime_type,
                             checksum, size_bytes, classification, acl, metadata,
                             status, indexed_at)
                        VALUES ($1, $2, 'doc-1', 'Doc', 'text/plain', $3, 4,
                                'internal', $4, '{}'::jsonb, 'indexed', now())
                        RETURNING id, source_id
                        """,
                        902,
                        source["id"],
                        f"itest-checksum-{suffix}",
                        {"users": ["alice"]},
                    )
                    chunk = await tx.fetchrow(
                        """
                        INSERT INTO ai.document_chunks
                            (tenant_id, document_id, chunk_index, content,
                             classification, acl)
                        VALUES ($1, $2, 0, 'pump lubrication', 'internal', $3)
                        RETURNING id
                        """,
                        902,
                        document["id"],
                        {"users": ["alice"]},
                    )
                    chunks = [chunk]

                    live = await repository.get_authoritative_chunks(
                        902, [chunks[0]["id"]]
                    )
                    assert len(live) == 1
                    assert live[0]["document_acl"] == {"users": ["alice"]}
                    assert live[0]["source_acl"] == {"users": ["alice"]}
                    assert live[0]["document_status"] == "indexed"

                    await tx.execute(
                        "UPDATE ai.documents SET acl = $3 WHERE tenant_id = $1 AND id = $2",
                        902,
                        document["id"],
                        {"users": ["bob"]},
                    )
                    live = await repository.get_authoritative_chunks(
                        902, [chunks[0]["id"]]
                    )
                    assert live[0]["chunk_acl"] == {"users": ["alice"]}
                    assert live[0]["document_acl"] == {"users": ["bob"]}

                    source_rows = await repository.list_source_chunks(
                        902, source["id"]
                    )
                    assert source_rows[0]["document_classification"] == "internal"
                    assert source_rows[0]["document_acl"] == {"users": ["bob"]}
                    assert source_rows[0]["source_acl"] == {"users": ["alice"]}

                    missing = await repository.get_authoritative_chunks(
                        902, [chunks[0]["id"] + 10_000_000]
                    )
                    assert missing == []

                    cross_tenant = await repository.get_authoritative_chunks(
                        903, [chunks[0]["id"]]
                    )
                    assert cross_tenant == []

                    raise _Rollback
            except _Rollback:
                pass
        finally:
            await db.close()

    asyncio.run(scenario())


def test_postgres_event_retry_backoff_and_tenant_scoped_replay() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from ai_api.domain.events import AI_REQUEST_COMPLETED, build_envelope
    from ai_api.infrastructure.db import PostgresDatabase
    from ai_api.infrastructure.events.postgres_event_store import PostgresEventStore

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            try:
                async with db.transaction() as tx:
                    store = PostgresEventStore(tx)
                    event = build_envelope(
                        AI_REQUEST_COMPLETED,
                        tenant_id=904,
                        data={"operation": "chat", "status": "succeeded"},
                    ).to_record()
                    await store.publish([event])
                    group = f"itest-backoff-{event['event_id']}"
                    assert (
                        await store.record_failure(
                            event["event_id"],
                            group,
                            "transient",
                            max_attempts=3,
                            retry_delay_seconds=60,
                        )
                        == "failed"
                    )
                    assert event["event_id"] not in {
                        row["event_id"]
                        for row in await store.list_undelivered(group, limit=500)
                    }
                    backlog = await store.delivery_backlog()
                    assert backlog["delayed"] >= 1

                    await tx.execute(
                        """
                        UPDATE ai.event_deliveries
                        SET next_attempt_at = now() - interval '1 second'
                        WHERE event_id = $1 AND consumer_group = $2
                        """,
                        event["event_id"],
                        group,
                    )
                    assert event["event_id"] in {
                        row["event_id"]
                        for row in await store.list_undelivered(group, limit=500)
                    }

                    assert (
                        await store.record_failure(
                            event["event_id"],
                            group,
                            "terminal",
                            max_attempts=2,
                        )
                        == "dead"
                    )
                    dead = await store.list_dead_letters(904, limit=100)
                    assert event["event_id"] in {row["event_id"] for row in dead}
                    assert await store.list_dead_letters(905, limit=100) == []
                    assert await store.replay(905, event["event_id"], group) is False
                    assert await store.replay(904, event["event_id"], group) is True
                    assert (await store.delivery_stats(904, group))["pending"] == 1
                    raise _Rollback
            except _Rollback:
                pass
        finally:
            await db.close()

    asyncio.run(scenario())


def test_postgres_source_security_updates_are_transactional_and_versioned() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from ai_api.infrastructure.db import PostgresDatabase
    from ai_api.infrastructure.repositories.postgres_ai_repository import (
        PostgresAiRepository,
    )

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            try:
                async with db.transaction() as tx:
                    repository = PostgresAiRepository(tx)
                    import uuid

                    suffix = uuid.uuid4().hex[:10]
                    source = await tx.fetchrow(
                        """
                        INSERT INTO ai.knowledge_sources
                            (tenant_id, code, name, kind, classification, acl)
                        VALUES ($1, $2, $3, 'manual', 'internal', $4)
                        RETURNING id, version
                        """,
                        904,
                        f"itest-security-{suffix}",
                        "Security",
                        {"users": ["alice"]},
                    )
                    assert source["version"] == 1
                    document = await tx.fetchrow(
                        """
                        INSERT INTO ai.documents
                            (tenant_id, source_id, external_id, title, mime_type,
                             checksum, size_bytes, classification, acl, metadata,
                             status, indexed_at, search_indexed_at)
                        VALUES ($1, $2, 'doc-1', 'Doc', 'text/plain', $3, 4,
                                'internal', $4, '{}'::jsonb, 'indexed', now(), now())
                        RETURNING id
                        """,
                        904,
                        source["id"],
                        f"itest-security-checksum-{suffix}",
                        {"users": ["alice"]},
                    )
                    chunk = await tx.fetchrow(
                        """
                        INSERT INTO ai.document_chunks
                            (tenant_id, document_id, chunk_index, content,
                             classification, acl)
                        VALUES ($1, $2, 0, 'pump lubrication', 'internal', $3)
                        RETURNING id
                        """,
                        904,
                        document["id"],
                        {"users": ["alice"]},
                    )

                    cross_tenant = await repository.update_knowledge_source_acl(
                        905,
                        source["id"],
                        {"users": ["mallory"]},
                        expected_version=1,
                    )
                    assert cross_tenant is None

                    updated = await repository.update_knowledge_source_acl(
                        904,
                        source["id"],
                        {"users": ["bob"]},
                        expected_version=1,
                        refresh_job={
                            "type": "index",
                            "source_id": source["id"],
                            "idempotency_key": f"source-security-{source['id']}-v2",
                            "payload": {"force": False, "security_update": "acl"},
                        },
                    )
                    assert updated is not None
                    assert updated["version"] == 2
                    assert updated["acl"] == {"users": ["bob"]}
                    refresh_job = updated["_refresh_job"]
                    assert refresh_job is not None
                    assert refresh_job["source_id"] == source["id"]
                    assert refresh_job["status"] == "queued"

                    child_document = await tx.fetchrow(
                        """
                        SELECT acl, search_indexed_at FROM ai.documents
                        WHERE tenant_id = $1 AND id = $2
                        """,
                        904,
                        document["id"],
                    )
                    assert child_document["acl"] == {"users": ["bob"]}
                    assert child_document["search_indexed_at"] is None
                    child_chunk = await tx.fetchrow(
                        """
                        SELECT acl FROM ai.document_chunks
                        WHERE tenant_id = $1 AND id = $2
                        """,
                        904,
                        chunk["id"],
                    )
                    assert child_chunk["acl"] == {"users": ["bob"]}

                    stale = await repository.update_knowledge_source_acl(
                        904,
                        source["id"],
                        {"users": ["carol"]},
                        expected_version=1,
                    )
                    assert stale is None
                    current = await tx.fetchrow(
                        "SELECT acl, version FROM ai.knowledge_sources WHERE id = $1",
                        source["id"],
                    )
                    assert current["acl"] == {"users": ["bob"]}
                    assert current["version"] == 2

                    classified = (
                        await repository.update_knowledge_source_classification(
                            904,
                            source["id"],
                            "confidential",
                            expected_version=2,
                            refresh_job={
                                "type": "index",
                                "source_id": source["id"],
                                "idempotency_key": f"source-security-{source['id']}-v3",
                                "payload": {
                                    "force": False,
                                    "security_update": "classification",
                                },
                            },
                        )
                    )
                    assert classified is not None
                    assert classified["version"] == 3
                    assert classified["classification"] == "confidential"
                    assert classified["_refresh_job"] is not None

                    doc_after = await tx.fetchrow(
                        """
                        SELECT classification, search_indexed_at FROM ai.documents
                        WHERE tenant_id = $1 AND id = $2
                        """,
                        904,
                        document["id"],
                    )
                    assert doc_after["classification"] == "internal"
                    assert doc_after["search_indexed_at"] is None
                    chunk_after = await tx.fetchrow(
                        """
                        SELECT classification FROM ai.document_chunks
                        WHERE tenant_id = $1 AND id = $2
                        """,
                        904,
                        chunk["id"],
                    )
                    assert chunk_after["classification"] == "internal"

                    raise _Rollback
            except _Rollback:
                pass
        finally:
            await db.close()

    asyncio.run(scenario())
