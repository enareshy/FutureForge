"""Async PostgreSQL access.

A thin asyncpg pool wrapper. The pool is created lazily and is safe to call
from the app lifespan. When the database is unreachable, callers receive a
`DatabaseUnavailableError` rather than a leaked driver exception.

Every transaction explicitly installs the tenant/system context used by the
row-level security policies in ``ai``. The setting is transaction-local, so a
pooled connection cannot carry one request's tenant into the next.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime
from decimal import Decimal
from typing import Any, TypeVar
from uuid import UUID

import asyncpg

from ai_api.config.settings import Settings
from ai_api.domain.errors import DatabaseUnavailableError
from ai_api.infrastructure.db.tenant_context import current_rls_context
from ai_api.telemetry.logging import get_logger
from ai_api.telemetry.rls_metrics import RLS_CONTEXT_MISSING, RLS_DENIED, sql_operation

logger = get_logger("db")

T = TypeVar("T")

_GLOBAL_TABLES_WITHOUT_RLS = ("ai.backup_runs", "ai.schema_migrations")


class _Transaction:
    """Adapter exposing the same query surface as PostgresDatabase."""

    def __init__(self, conn: asyncpg.Connection) -> None:
        self._conn = conn

    async def _run(self, method: str, query: str, *args: Any) -> Any:
        _note_context_missing(query)
        try:
            return await getattr(self._conn, method)(query, *args)
        except Exception as exc:
            _note_denied(exc, query)
            raise

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        rows = await self._run("fetch", query, *args)
        return [dict(row) for row in rows]

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        row = await self._run("fetchrow", query, *args)
        return dict(row) if row is not None else None

    async def fetchval(self, query: str, *args: Any) -> Any:
        return await self._run("fetchval", query, *args)

    async def execute(self, query: str, *args: Any) -> str:
        return await self._run("execute", query, *args)


async def _init_connection(conn: asyncpg.Connection) -> None:
    # NUMERIC columns (e.g. predictive risk scores) come back as ``Decimal``;
    # without a fallback the encoder raises "Object of type Decimal is not JSON
    # serializable" whenever such a value reaches a JSONB payload (checkpoints,
    # step summaries, audit payloads). Coerce common DB scalars so persistence
    # is never blocked by a non-native type, and fall back to ``str`` otherwise.
    def encoder(value: Any) -> str:
        return json.dumps(value, default=_json_fallback)

    await conn.set_type_codec(
        "jsonb",
        encoder=encoder,
        decoder=json.loads,
        schema="pg_catalog",
    )
    await conn.set_type_codec(
        "json",
        encoder=encoder,
        decoder=json.loads,
        schema="pg_catalog",
    )


def _json_fallback(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    return str(value)


def _requires_tenant_context(query: str) -> bool:
    if "ai." not in query:
        return False
    return not any(table in query for table in _GLOBAL_TABLES_WITHOUT_RLS)


def _note_context_missing(query: str) -> None:
    if not current_rls_context().is_missing:
        return
    if not _requires_tenant_context(query):
        return
    RLS_CONTEXT_MISSING.labels(operation=sql_operation(query)).inc()


def _note_denied(exc: BaseException, query: str) -> None:
    if not isinstance(exc, asyncpg.PostgresError):
        return
    sqlstate = getattr(exc, "sqlstate", None)
    message = str(exc).lower()
    if sqlstate != "42501" and "row-level security" not in message:
        return
    if "row-level security" not in message:
        return
    operation = sql_operation(query)
    RLS_DENIED.labels(operation=operation).inc()
    logger.warning("db.rls_denied", operation=operation, sqlstate=sqlstate)


class PostgresDatabase:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._pool: asyncpg.Pool | None = None
        self._lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._pool is not None

    async def connect(self) -> None:
        async with self._lock:
            if self._pool is not None:
                return
            try:
                pool = await asyncpg.create_pool(
                    dsn=self._settings.database_dsn,
                    min_size=1,
                    max_size=5,
                    command_timeout=self._settings.enterprise_api_timeout_seconds,
                    init=_init_connection,
                )
            except Exception as exc:  # noqa: BLE001 - surface a domain error
                logger.warning("db.connect_failed", error=str(exc))
                raise DatabaseUnavailableError("database is unavailable") from exc
            try:
                async with pool.acquire() as conn:
                    await self._verify_role(conn)
                    if self._settings.ai_rls_verify:
                        await self._verify_rls(conn)
            except Exception:
                await pool.close()
                raise
            self._pool = pool

    async def _verify_role(self, conn: asyncpg.Connection) -> None:
        """Reject owner, superuser, BYPASSRLS, and wrong system-scope roles.

        This runs whenever a role profile or expected role is configured, even
        if ``AI_RLS_VERIFY`` is temporarily disabled. It is a deployment
        assertion, not a substitute for RLS: a shared runtime role can still
        set another tenant id, which is why API authorization remains primary.
        """
        expected = self._settings.ai_db_expected_role.strip()
        profile = self._settings.ai_db_role_profile.strip().lower()
        if not expected and not profile:
            return
        row = await conn.fetchrow(
            """
            SELECT current_user AS role_name,
                   r.rolsuper,
                   r.rolcreatedb,
                   r.rolcreaterole,
                   r.rolbypassrls,
                   COALESCE(
                     pg_has_role(
                       current_user,
                       to_regrole('ai_system_access'),
                       'MEMBER'
                     ),
                     false
                   ) AS system_member,
                   EXISTS (
                     SELECT 1
                     FROM pg_class c
                     JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = $1
                       AND c.relowner = r.oid
                       AND c.relkind IN ('r', 'p')
                   ) AS owns_ai_tables
            FROM pg_roles r
            WHERE r.rolname = current_user
            """,
            self._settings.ai_db_schema,
        )
        if row is None:
            logger.error("db.role_verification_failed", reason="role_not_found")
            raise DatabaseUnavailableError("database role is not permitted")

        role_name = str(row["role_name"])
        reasons: list[str] = []
        if expected and role_name != expected:
            reasons.append("unexpected_role")
        if row["rolsuper"]:
            reasons.append("superuser")
        if row["rolbypassrls"]:
            reasons.append("bypassrls")
        if row["owns_ai_tables"]:
            reasons.append("owns_ai_tables")
        if profile in {"api", "worker"}:
            if row["rolcreatedb"]:
                reasons.append("createdb")
            if row["rolcreaterole"]:
                reasons.append("createrole")
        if profile == "api" and row["system_member"]:
            reasons.append("api_system_member")
        if profile in {"worker", "backup", "migrate"} and not row["system_member"]:
            reasons.append("system_membership_missing")

        if reasons:
            logger.error(
                "db.role_verification_failed",
                reason=",".join(reasons),
                role=role_name,
                profile=profile or "unset",
            )
            raise DatabaseUnavailableError("database role is not permitted")
        logger.info(
            "db.role_verified",
            role=role_name,
            profile=profile or "unset",
            system_scope_allowed=bool(row["system_member"]),
        )

    async def _verify_rls(self, conn: asyncpg.Connection) -> None:
        """Fail startup when the migration's RLS invariants are absent.

        Superusers and roles with BYPASSRLS still bypass policies; this check
        only proves the policies are enabled and forced on every table that is
        expected to have them. The deployment runbook documents role review.
        """

        row = await conn.fetchrow(
            """
            SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'ai'
              AND c.relkind = 'r'
              AND c.relname NOT IN ('schema_migrations', 'backup_runs')
              AND (
                    NOT c.relrowsecurity
                 OR NOT c.relforcerowsecurity
                 OR NOT EXISTS (
                        SELECT 1 FROM pg_policies p
                        WHERE p.schemaname = 'ai'
                          AND p.tablename = c.relname
                          AND p.policyname = 'tenant_isolation'
                    )
              )
            ORDER BY c.relname
            LIMIT 1
            """
        )
        if row is not None:
            logger.error("db.rls_not_enforced", table=str(row["relname"]))
            raise DatabaseUnavailableError("database row-level security is not enforced")

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    async def ping(self) -> None:
        """Round-trip a trivial query so readiness reflects live connectivity.

        Unlike :meth:`connect`, this revalidates an already-cached pool, so a
        database that goes away after startup is reported as unavailable.
        """
        pool = await self._pool_or_connect()
        await pool.fetchval("SELECT 1")

    async def _pool_or_connect(self) -> asyncpg.Pool:
        if self._pool is None:
            await self.connect()
        assert self._pool is not None
        return self._pool

    async def _apply_context(self, conn: asyncpg.Connection) -> None:
        context = current_rls_context()
        tenant = "" if context.tenant_id is None else str(context.tenant_id)
        system = "on" if context.system else "off"
        await conn.execute(
            """
            SELECT set_config('ai.tenant_id', $1, true),
                   set_config('ai.system_access', $2, true)
            """,
            tenant,
            system,
        )

    async def _run(self, query: str, args: tuple[Any, ...], method: str) -> Any:
        _note_context_missing(query)
        pool = await self._pool_or_connect()
        async with pool.acquire() as conn, conn.transaction():
            await self._apply_context(conn)
            try:
                return await getattr(conn, method)(query, *args)
            except Exception as exc:
                _note_denied(exc, query)
                raise

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        rows = await self._run(query, args, "fetch")
        return [dict(row) for row in rows]

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        row = await self._run(query, args, "fetchrow")
        return dict(row) if row is not None else None

    async def fetchval(self, query: str, *args: Any) -> Any:
        return await self._run(query, args, "fetchval")

    async def execute(self, query: str, *args: Any) -> str:
        return await self._run(query, args, "execute")

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[_Transaction]:
        pool = await self._pool_or_connect()
        async with pool.acquire() as conn, conn.transaction():
            await self._apply_context(conn)
            yield _Transaction(conn)
