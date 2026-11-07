"""Least-privilege PostgreSQL role evidence.

These tests run against a database where
``infrastructure/db/roles/provision_roles.sql`` has been applied and migration
0019 is present. They connect as the real runtime roles rather than as the
owner, which is the property this suite exists to prove.

Run with:

    AI_TEST_ROLE_DB=1 \
    AI_ROLE_API_DSN=postgresql://ai_api:...@host/db \
    AI_ROLE_WORKER_DSN=postgresql://ai_worker:...@host/db \
    AI_ROLE_BACKUP_DSN=postgresql://ai_backup:...@host/db \
    AI_ROLE_RESTORE_DSN=postgresql://ai_restore:...@host/db \
    AI_ROLE_MIGRATE_DSN=postgresql://ai_migrate:...@host/db \
    python3 -m pytest -o addopts="" tests/test_db_roles.py

The suite never runs destructive DDL. Provider rows are removed by the worker
role in the fixture teardown; backup run writes are rolled back.
"""

from __future__ import annotations

import os
import uuid

import asyncpg
import pytest

TENANT_A = 990119
TENANT_B = 990120

_DSN_ENV = {
    "api": "AI_ROLE_API_DSN",
    "worker": "AI_ROLE_WORKER_DSN",
    "backup": "AI_ROLE_BACKUP_DSN",
    "restore": "AI_ROLE_RESTORE_DSN",
    "migrate": "AI_ROLE_MIGRATE_DSN",
}


def _require_roles() -> None:
    """Skip by default, but fail closed when the gate is authoritative.

    ``AI_REQUIRE_ROLE_DB=1`` is set by ``scripts/verify-db-roles.sh`` and by any
    SEC-19 gate job. In that mode a missing DSN is a hard failure: otherwise a
    green run with 14 skipped tests could be mistaken for role-separation
    evidence. It is never set by the ordinary hermetic suite.
    """
    required = os.environ.get("AI_REQUIRE_ROLE_DB", "") == "1"
    if os.environ.get("AI_TEST_ROLE_DB", "") != "1":
        message = "set AI_TEST_ROLE_DB=1 with the per-role DSNs to run"
        if required:
            pytest.fail(f"AI_REQUIRE_ROLE_DB=1 but role tests cannot run: {message}")
        pytest.skip(message)
    missing = [name for name in _DSN_ENV.values() if not os.environ.get(name)]
    if missing:
        message = "missing role DSN(s): " + ", ".join(missing)
        if required:
            pytest.fail(f"AI_REQUIRE_ROLE_DB=1 but {message}")
        pytest.skip(message)


async def _connect(profile: str) -> asyncpg.Connection:
    dsn = os.environ[_DSN_ENV[profile]]
    return await asyncpg.connect(dsn, timeout=10)


async def _set_context(
    conn: asyncpg.Connection,
    tenant_id: int | None,
    *,
    system: bool = False,
) -> None:
    if tenant_id is not None:
        await conn.execute(
            "SELECT set_config('ai.tenant_id', $1, true)", str(tenant_id)
        )
    await conn.execute(
        "SELECT set_config('ai.system_access', $1, true)",
        "on" if system else "off",
    )


async def _role_state(conn: asyncpg.Connection) -> asyncpg.Record:
    return await conn.fetchrow(
        """
        SELECT current_user AS role_name,
               r.rolsuper,
               r.rolcreatedb,
               r.rolcreaterole,
               r.rolbypassrls,
               COALESCE(
                 pg_has_role(current_user, to_regrole('ai_system_access'), 'MEMBER'),
                 false
               ) AS system_member,
               EXISTS (
                 SELECT 1
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'ai'
                   AND c.relowner = r.oid
                   AND c.relkind IN ('r', 'p')
               ) AS owns_ai_tables
        FROM pg_roles r
        WHERE r.rolname = current_user
        """
    )


@pytest.fixture
async def role_dsns() -> None:
    _require_roles()


@pytest.fixture
async def seeded_providers(role_dsns: None):
    worker = await _connect("worker")
    suffix = uuid.uuid4().hex[:8]
    codes = {"a": f"role-a-{suffix}", "b": f"role-b-{suffix}"}
    try:
        async with worker.transaction():
            await _set_context(worker, None, system=True)
            for tenant, key in ((TENANT_A, "a"), (TENANT_B, "b")):
                await worker.execute(
                    "INSERT INTO ai.providers (tenant_id, code, name) "
                    "VALUES ($1, $2, $3)",
                    tenant,
                    codes[key],
                    "role test",
                )
        yield codes
    finally:
        async with worker.transaction():
            await _set_context(worker, None, system=True)
            await worker.execute(
                "DELETE FROM ai.providers WHERE code = ANY($1::text[])",
                list(codes.values()),
            )
        await worker.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("profile", "createdb", "system_member"),
    [
        ("api", False, False),
        ("worker", False, True),
        ("backup", False, True),
        ("restore", True, True),
        ("migrate", False, True),
    ],
)
async def test_runtime_roles_are_least_privilege(
    role_dsns: None, profile: str, createdb: bool, system_member: bool
) -> None:
    conn = await _connect(profile)
    try:
        state = await _role_state(conn)
        assert state["role_name"] == f"ai_{profile}"
        assert state["rolsuper"] is False
        assert state["rolbypassrls"] is False
        assert state["rolcreaterole"] is False
        assert state["owns_ai_tables"] is False
        assert state["rolcreatedb"] is createdb
        assert state["system_member"] is system_member
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_api_cannot_honor_system_scope(seeded_providers) -> None:
    api = await _connect("api")
    try:
        async with api.transaction():
            await _set_context(api, TENANT_A, system=True)
            assert await api.fetchval("SELECT ai.system_access()") is False
            visible = await api.fetchval("SELECT count(*) FROM ai.providers")
            assert visible == 0
    finally:
        await api.close()


@pytest.mark.asyncio
async def test_api_can_write_own_tenant(seeded_providers) -> None:
    api = await _connect("api")
    suffix = uuid.uuid4().hex[:8]
    try:
        async with api.transaction() as tx:
            await _set_context(api, TENANT_A)
            await api.execute(
                "INSERT INTO ai.providers (tenant_id, code, name) "
                "VALUES ($1, $2, 'api own tenant')",
                TENANT_A,
                f"role-own-{suffix}",
            )
            assert await api.fetchval(
                "SELECT count(*) FROM ai.providers WHERE code = $1",
                f"role-own-{suffix}",
            ) == 1
            await tx.rollback()
    finally:
        await api.close()


@pytest.mark.asyncio
async def test_api_missing_context_fails_closed(seeded_providers) -> None:
    api = await _connect("api")
    try:
        async with api.transaction():
            assert await api.fetchval("SELECT count(*) FROM ai.providers") == 0
    finally:
        await api.close()


@pytest.mark.asyncio
async def test_api_cannot_read_or_write_other_tenant(seeded_providers) -> None:
    api = await _connect("api")
    try:
        async with api.transaction():
            await _set_context(api, TENANT_A)
            rows = await api.fetch(
                "SELECT tenant_id FROM ai.providers WHERE code = ANY($1::text[])",
                list(seeded_providers.values()),
            )
            assert [row["tenant_id"] for row in rows] == [TENANT_A]
            updated = await api.execute(
                "UPDATE ai.providers SET name = 'blocked' WHERE code = $1",
                seeded_providers["b"],
            )
            assert updated == "UPDATE 0"
    finally:
        await api.close()


@pytest.mark.asyncio
async def test_worker_system_scope_crosses_tenants(seeded_providers) -> None:
    worker = await _connect("worker")
    try:
        async with worker.transaction():
            await _set_context(worker, TENANT_A, system=True)
            assert await worker.fetchval("SELECT ai.system_access()") is True
            rows = await worker.fetch(
                "SELECT tenant_id FROM ai.providers WHERE code = ANY($1::text[])",
                list(seeded_providers.values()),
            )
            assert {row["tenant_id"] for row in rows} == {TENANT_A, TENANT_B}
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_worker_system_scope_requires_both_flag_and_role(
    seeded_providers,
) -> None:
    worker = await _connect("worker")
    try:
        async with worker.transaction():
            await _set_context(worker, TENANT_A, system=False)
            assert await worker.fetchval("SELECT ai.system_access()") is False
            rows = await worker.fetch(
                "SELECT tenant_id FROM ai.providers WHERE code = $1",
                seeded_providers["b"],
            )
            assert rows == []
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_backup_can_read_all_tenants_and_write_run_metadata(
    seeded_providers,
) -> None:
    backup = await _connect("backup")
    try:
        async with backup.transaction() as tx:
            await _set_context(backup, None, system=True)
            assert await backup.fetchval("SELECT ai.system_access()") is True
            rows = await backup.fetch(
                "SELECT tenant_id FROM ai.providers WHERE code = ANY($1::text[])",
                list(seeded_providers.values()),
            )
            assert {row["tenant_id"] for row in rows} == {TENANT_A, TENANT_B}
            await backup.execute(
                "INSERT INTO ai.backup_runs (run_id, kind, status, started_at) "
                "VALUES ($1, 'manual', 'succeeded', now())",
                f"role-test-{uuid.uuid4().hex}",
            )
            await tx.rollback()
    finally:
        await backup.close()


@pytest.mark.asyncio
async def test_restore_can_create_but_not_bypass_rls(seeded_providers) -> None:
    restore = await _connect("restore")
    try:
        state = await _role_state(restore)
        assert state["rolcreatedb"] is True
        assert state["rolsuper"] is False
        assert state["rolbypassrls"] is False
        assert await restore.fetchval(
            "SELECT has_schema_privilege(current_user, 'ai', 'CREATE')"
        )
    finally:
        await restore.close()


@pytest.mark.asyncio
async def test_migration_role_only_reaches_owner_by_set_role(role_dsns: None) -> None:
    migrate = await _connect("migrate")
    try:
        state = await _role_state(migrate)
        assert state["role_name"] == "ai_migrate"
        assert state["owns_ai_tables"] is False
        assert state["rolsuper"] is False
        async with migrate.transaction():
            await migrate.execute("SET LOCAL ROLE ai_owner")
            assert await migrate.fetchval("SELECT current_user") == "ai_owner"
            await migrate.execute("ROLLBACK")
    finally:
        await migrate.close()
