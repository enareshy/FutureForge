"""Async PostgreSQL access.

A thin asyncpg pool wrapper. The pool is created lazily and is safe to call
from the app lifespan. When the database is unreachable, callers receive a
`DatabaseUnavailableError` rather than a leaked driver exception.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import asyncpg

from ai_api.config.settings import Settings
from ai_api.domain.errors import DatabaseUnavailableError
from ai_api.telemetry.logging import get_logger

logger = get_logger("db")


class _Transaction:
    """Adapter exposing the same query surface as PostgresDatabase."""

    def __init__(self, conn: asyncpg.Connection) -> None:
        self._conn = conn

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        return [dict(row) for row in await self._conn.fetch(query, *args)]

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        row = await self._conn.fetchrow(query, *args)
        return dict(row) if row is not None else None

    async def fetchval(self, query: str, *args: Any) -> Any:
        return await self._conn.fetchval(query, *args)

    async def execute(self, query: str, *args: Any) -> str:
        return await self._conn.execute(query, *args)


async def _init_connection(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )
    await conn.set_type_codec(
        "json",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


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
                self._pool = await asyncpg.create_pool(
                    dsn=self._settings.database_dsn,
                    min_size=1,
                    max_size=5,
                    command_timeout=self._settings.enterprise_api_timeout_seconds,
                    init=_init_connection,
                )
            except Exception as exc:  # noqa: BLE001 - surface a domain error
                logger.warning("db.connect_failed", error=str(exc))
                raise DatabaseUnavailableError("database is unavailable") from exc

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    async def ping(self) -> None:
        """Round-trip a trivial query so readiness reflects live connectivity.

        Unlike :meth:`connect`, this revalidates an already-cached pool, so a
        database that goes away after startup is reported as unavailable.
        """
        await self.fetchval("SELECT 1")

    async def _pool_or_connect(self) -> asyncpg.Pool:
        if self._pool is None:
            await self.connect()
        assert self._pool is not None
        return self._pool

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        pool = await self._pool_or_connect()
        rows = await pool.fetch(query, *args)
        return [dict(row) for row in rows]

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        pool = await self._pool_or_connect()
        row = await pool.fetchrow(query, *args)
        return dict(row) if row is not None else None

    async def fetchval(self, query: str, *args: Any) -> Any:
        pool = await self._pool_or_connect()
        return await pool.fetchval(query, *args)

    async def execute(self, query: str, *args: Any) -> str:
        pool = await self._pool_or_connect()
        return await pool.execute(query, *args)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[_Transaction]:
        pool = await self._pool_or_connect()
        async with pool.acquire() as conn, conn.transaction():
            yield _Transaction(conn)
