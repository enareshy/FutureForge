"""Real PostgreSQL/pgvector coverage for document versions and metadata updates.

These are opt-in integration tests that exercise the actual SQL against a
PostgreSQL instance with the ``ai`` schema migrated (including pgvector). They
are skipped unless ``AI_TEST_POSTGRES=1`` and the configured database is
reachable, matching the existing integration test conventions.

Run against a disposable database, for example:

    AI_TEST_POSTGRES=1 \\
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 \\
    POSTGRES_USER=postgres POSTGRES_PASSWORD=test \\
    pytest -o addopts="" tests/test_document_versions_postgres.py
"""

from __future__ import annotations

import asyncio
import os
import socket
import uuid

import pytest

from ai_api.application.ports import AiRepository
from ai_api.config.settings import get_settings
from ai_api.infrastructure.db import PostgresDatabase, system_scope, tenant_scope
from ai_api.infrastructure.repositories.postgres_ai_repository import (
    PostgresAiRepository,
)

pytestmark = pytest.mark.integration

TENANT = 990341


def _requires_postgres() -> None:
    if os.environ.get("AI_TEST_POSTGRES", "") != "1":
        pytest.skip("set AI_TEST_POSTGRES=1 to run PostgreSQL version tests")
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
            "DELETE FROM ai.document_versions WHERE tenant_id = $1", TENANT
        )
        await db.execute("DELETE FROM ai.embeddings WHERE tenant_id = $1", TENANT)
        await db.execute("DELETE FROM ai.document_chunks WHERE tenant_id = $1", TENANT)
        await db.execute("DELETE FROM ai.documents WHERE tenant_id = $1", TENANT)
        await db.execute(
            "DELETE FROM ai.knowledge_sources WHERE tenant_id = $1", TENANT
        )


async def _seed_source(db: PostgresDatabase) -> int:
    repository = PostgresAiRepository(db)
    suffix = uuid.uuid4().hex[:8]
    source = await repository.create_knowledge_source(
        TENANT,
        {
            "code": f"ver-{suffix}",
            "name": "Versioned",
            "kind": "manual",
            "classification": "internal",
            "acl": {},
            "config": {},
        },
    )
    return int(source["id"])


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


def test_replace_carries_version_forward_and_snapshots_history() -> None:
    async def scenario(db: PostgresDatabase, repository: AiRepository) -> None:
        source_id = await _seed_source(db)
        first = await repository.create_or_replace_document(
            TENANT,
            {
                "source_id": source_id,
                "external_id": "pump",
                "title": "Pump v1",
                "metadata": {"product": "P-100"},
            },
        )
        assert first["version"] == 1

        second = await repository.create_or_replace_document(
            TENANT,
            {
                "source_id": source_id,
                "external_id": "pump",
                "title": "Pump v2",
                "metadata": {"product": "P-100", "revision": "B"},
            },
        )
        assert second["version"] == 2
        assert second["id"] != first["id"]

        rows, total = await repository.list_document_versions(
            TENANT, int(second["id"]), limit=10, offset=0
        )
        assert total == 1
        assert rows[0]["version"] == 1
        assert rows[0]["reason"] == "superseded"
        assert rows[0]["title"] == "Pump v1"

        # The history row must never carry chunk text.
        raw = await db.fetchrow(
            """
            SELECT metadata::text AS metadata FROM ai.document_versions
            WHERE tenant_id = $1 AND document_id = $2
            """,
            TENANT,
            int(first["id"]),
        )
        assert raw is not None
        assert "content" not in (raw["metadata"] or "")

    _run(scenario)


def test_metadata_update_bumps_version_and_keeps_content() -> None:
    async def scenario(db: PostgresDatabase, repository: AiRepository) -> None:
        source_id = await _seed_source(db)
        document = await repository.create_or_replace_document(
            TENANT,
            {"source_id": source_id, "external_id": "valve", "title": "Valve"},
        )
        document_id = int(document["id"])
        await repository.add_chunks(
            TENANT,
            document_id,
            [
                {
                    "chunk_index": 0,
                    "content": "valve lapping procedure",
                    "classification": "internal",
                    "acl": {},
                }
            ],
        )

        updated = await repository.update_document_metadata(
            TENANT,
            document_id,
            title="Valve Manual",
            metadata={"product": "V-200", "revision": "C"},
            expected_version=1,
        )
        assert updated is not None
        assert updated["version"] == 2
        assert updated["title"] == "Valve Manual"
        assert updated["metadata"] == {"product": "V-200", "revision": "C"}
        assert updated["search_indexed_at"] is None

        chunks, chunk_total = await repository.list_document_chunks(
            TENANT, document_id, limit=10, offset=0
        )
        assert chunk_total == 1
        assert chunks[0]["content"] == "valve lapping procedure"

        stale = await repository.update_document_metadata(
            TENANT,
            document_id,
            title="Should Not Apply",
            expected_version=1,
        )
        assert stale is None
        current = await repository.get_document(TENANT, document_id)
        assert current is not None
        assert current["title"] == "Valve Manual"

        history, total = await repository.list_document_versions(
            TENANT, document_id, limit=10, offset=0
        )
        assert total == 1
        assert history[0]["reason"] == "metadata_update"

    _run(scenario)


def test_delete_snapshots_deleted_version() -> None:
    async def scenario(db: PostgresDatabase, repository: AiRepository) -> None:
        source_id = await _seed_source(db)
        document = await repository.create_or_replace_document(
            TENANT,
            {"source_id": source_id, "external_id": "gasket", "title": "Gasket"},
        )
        document_id = int(document["id"])
        assert await repository.delete_document(TENANT, document_id) is True
        assert await repository.get_document(TENANT, document_id) is None

        history = await db.fetch(
            """
            SELECT version, reason, external_id FROM ai.document_versions
            WHERE tenant_id = $1 AND external_id = 'gasket'
            """,
            TENANT,
        )
        assert len(history) == 1
        assert history[0]["reason"] == "deleted"
        assert history[0]["version"] == 1
        assert history[0]["external_id"] == "gasket"

    _run(scenario)
