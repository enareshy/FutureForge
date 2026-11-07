"""PostgreSQL-backed implementation of the AiRepository port."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

import asyncpg

from ai_api.domain.errors import ConflictError
from ai_api.infrastructure.db.database import PostgresDatabase


def _vector_literal(values: list[float] | tuple[float, ...]) -> str:
    return "[" + ",".join(f"{float(v):.8g}" for v in values) + "]"


class PostgresAiRepository:
    def __init__(self, db: PostgresDatabase) -> None:
        self._db = db

    @asynccontextmanager
    async def _write_transaction(self) -> AsyncIterator[Any]:
        """Join the caller's transaction when one is already open.

        Repositories are usually built around the database pool, but tests and
        composite callers sometimes construct them around an existing
        transaction. Reusing that transaction keeps the update atomic and
        composable instead of nesting or failing on a missing ``transaction``.
        """
        transaction = getattr(self._db, "transaction", None)
        if transaction is None:
            yield self._db
            return
        async with transaction() as tx:
            yield tx

    async def list_knowledge_sources(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = await self._db.fetch(
            """
            SELECT id, code, name, kind, uri, classification, acl, status,
                   version, created_at, updated_at
            FROM ai.knowledge_sources
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            tenant_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            "SELECT count(*) FROM ai.knowledge_sources WHERE tenant_id = $1", tenant_id
        )
        return items, int(total or 0)

    async def create_knowledge_source(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            INSERT INTO ai.knowledge_sources
                (tenant_id, code, name, kind, uri, classification, acl, config)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (tenant_id, code) DO NOTHING
            RETURNING id, code, name, kind, uri, classification, acl, status,
                      version, created_at, updated_at
            """,
            tenant_id,
            data["code"],
            data["name"],
            data["kind"],
            data.get("uri"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("config", {}),
        )

    async def get_knowledge_source(
        self, tenant_id: int, source_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, code, name, kind, uri, classification, acl, status,
                   version, created_at, updated_at
            FROM ai.knowledge_sources
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            source_id,
        )

    async def update_knowledge_source_acl(
        self,
        tenant_id: int,
        source_id: int,
        acl: dict[str, Any],
        *,
        expected_version: int,
        refresh_job: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        async with self._write_transaction() as tx:
            row = await tx.fetchrow(
                """
                UPDATE ai.knowledge_sources
                SET acl = $3, version = version + 1, updated_at = now()
                WHERE tenant_id = $1 AND id = $2 AND version = $4
                RETURNING id, code, name, kind, uri, classification, acl, status,
                          version, created_at, updated_at
                """,
                tenant_id,
                source_id,
                acl,
                expected_version,
            )
            if row is None:
                return None
            row = dict(row)
            # Source ACLs are inherited by descendants at ingestion. Propagate
            # the authoritative value in the same transaction so a newly granted
            # (or revoked) policy takes effect without waiting for reindexing.
            await tx.execute(
                """
                UPDATE ai.documents
                SET acl = $3, search_indexed_at = NULL, updated_at = now()
                WHERE tenant_id = $1 AND source_id = $2
                """,
                tenant_id,
                source_id,
                acl,
            )
            await tx.execute(
                """
                UPDATE ai.document_chunks
                SET acl = $3
                WHERE tenant_id = $1 AND document_id IN (
                    SELECT id FROM ai.documents
                    WHERE tenant_id = $1 AND source_id = $2
                )
                """,
                tenant_id,
                source_id,
                acl,
            )
            if refresh_job is not None:
                row["_refresh_job"] = await self._insert_refresh_job(
                    tx, tenant_id, refresh_job
                )
            return row

    async def update_knowledge_source_classification(
        self,
        tenant_id: int,
        source_id: int,
        classification: str,
        *,
        expected_version: int,
        refresh_job: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        async with self._write_transaction() as tx:
            row = await tx.fetchrow(
                """
                UPDATE ai.knowledge_sources
                SET classification = $3, version = version + 1, updated_at = now()
                WHERE tenant_id = $1 AND id = $2 AND version = $4
                RETURNING id, code, name, kind, uri, classification, acl, status,
                          version, created_at, updated_at
                """,
                tenant_id,
                source_id,
                classification,
                expected_version,
            )
            if row is None:
                return None
            row = dict(row)
            # Child classifications are intentionally not lowered here: effective
            # classification is the maximum of source/document/chunk, so an
            # increase is immediate and a downgrade cannot silently relax a
            # document that was explicitly classified higher.
            await tx.execute(
                """
                UPDATE ai.documents
                SET search_indexed_at = NULL, updated_at = now()
                WHERE tenant_id = $1 AND source_id = $2
                """,
                tenant_id,
                source_id,
            )
            if refresh_job is not None:
                row["_refresh_job"] = await self._insert_refresh_job(
                    tx, tenant_id, refresh_job
                )
            return row

    async def _insert_refresh_job(
        self, db: Any, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        job = await db.fetchrow(
            """
            INSERT INTO ai.jobs
                (tenant_id, type, source_id, idempotency_key, payload, stage,
                 next_attempt_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
            RETURNING id, type, status, source_id, progress, attempts, max_attempts,
                      stage, error_class, lease_expires_at, next_attempt_at,
                      created_at, started_at, finished_at
            """,
            tenant_id,
            data["type"],
            data.get("source_id"),
            data.get("idempotency_key"),
            data.get("payload", {}),
            data.get("stage"),
            data.get("next_attempt_at"),
        )
        if job is None and data.get("idempotency_key"):
            job = await db.fetchrow(
                """
                SELECT id, type, status, source_id, progress, attempts, max_attempts,
                       stage, error_class, lease_expires_at, next_attempt_at,
                       created_at, started_at, finished_at
                FROM ai.jobs
                WHERE tenant_id = $1 AND idempotency_key = $2
                """,
                tenant_id,
                data["idempotency_key"],
            )
        return job

    async def create_job(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        job = await self._db.fetchrow(
            """
            INSERT INTO ai.jobs
                (tenant_id, type, source_id, idempotency_key, payload, stage,
                 next_attempt_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
            RETURNING id, type, status, source_id, progress, attempts, max_attempts,
                      stage, error_class, lease_expires_at, next_attempt_at,
                      created_at, started_at, finished_at
            """,
            tenant_id,
            data["type"],
            data.get("source_id"),
            data.get("idempotency_key"),
            data.get("payload", {}),
            data.get("stage"),
            data.get("next_attempt_at"),
        )
        if job is None and data.get("idempotency_key"):
            job = await self._db.fetchrow(
                """
                SELECT id, type, status, source_id, progress, attempts, max_attempts,
                       stage, error_class, lease_expires_at, next_attempt_at,
                       created_at, started_at, finished_at
                FROM ai.jobs
                WHERE tenant_id = $1 AND idempotency_key = $2
                """,
                tenant_id,
                data["idempotency_key"],
            )
        return job

    async def get_job(self, tenant_id: int, job_id: int) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, type, status, source_id, progress, attempts, max_attempts,
                   stage, error_class, lease_expires_at, next_attempt_at, payload,
                   result, error, created_at, started_at, finished_at
            FROM ai.jobs
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            job_id,
        )

    async def record_execution(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.executions
                (tenant_id, actor_id, agent_id, model_id, operation, status,
                 input, output, latency_ms, token_usage, completed_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
            RETURNING id, request_id
            """,
            tenant_id,
            data.get("actor_id"),
            data.get("agent_id"),
            data.get("model_id"),
            data["operation"],
            data.get("status", "succeeded"),
            data.get("input", {}),
            data.get("output"),
            data.get("latency_ms"),
            data.get("token_usage", {}),
        )
        assert row is not None
        return row

    async def record_usage(self, tenant_id: int, data: dict[str, Any]) -> None:
        await self._db.execute(
            """
            INSERT INTO ai.usage_records
                (tenant_id, execution_id, provider_code, model_code, kind,
                 quantity, unit, unit_cost, total_cost, currency)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            """,
            tenant_id,
            data.get("execution_id"),
            data.get("provider_code"),
            data.get("model_code"),
            data["kind"],
            data.get("quantity", 0),
            data.get("unit", "tokens"),
            data.get("unit_cost"),
            data.get("total_cost"),
            data.get("currency", "USD"),
        )

    async def usage_summary(
        self, tenant_id: int, *, since: datetime | None
    ) -> dict[str, Any]:
        clauses = ["tenant_id = $1"]
        args: list[Any] = [tenant_id]
        if since is not None:
            args.append(since)
            clauses.append(f"created_at >= ${len(args)}")
        where = " AND ".join(clauses)
        total = await self._db.fetchrow(
            f"""
            SELECT COALESCE(SUM(quantity), 0) AS quantity,
                   COALESCE(SUM(total_cost), 0) AS total_cost
            FROM ai.usage_records
            WHERE {where}
            """,
            *args,
        )
        by_kind = await self._db.fetch(
            f"""
            SELECT kind,
                   COALESCE(SUM(quantity), 0) AS quantity,
                   COALESCE(SUM(total_cost), 0) AS total_cost
            FROM ai.usage_records
            WHERE {where}
            GROUP BY kind
            ORDER BY kind
            """,
            *args,
        )
        return {
            "quantity": int((total or {}).get("quantity", 0)),
            "total_cost": float((total or {}).get("total_cost", 0) or 0),
            "currency": "USD",
            "by_kind": [
                {
                    "kind": row["kind"],
                    "quantity": int(row["quantity"]),
                    "total_cost": float(row["total_cost"] or 0),
                }
                for row in by_kind
            ],
        }

    async def list_usage(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = await self._db.fetch(
            """
            SELECT id, kind, provider_code, model_code, quantity, unit,
                   total_cost, currency, created_at
            FROM ai.usage_records
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            tenant_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            "SELECT count(*) FROM ai.usage_records WHERE tenant_id = $1", tenant_id
        )
        return items, int(total or 0)

    async def write_audit(self, tenant_id: int, data: dict[str, Any]) -> None:
        await self._db.execute(
            """
            INSERT INTO ai.audit_events
                (tenant_id, execution_id, actor_id, action, resource_type,
                 resource_id, outcome, request_id, detail)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            tenant_id,
            data.get("execution_id"),
            data.get("actor_id"),
            data["action"],
            data.get("resource_type"),
            data.get("resource_id"),
            data.get("outcome", "success"),
            data.get("request_id"),
            data.get("detail", {}),
        )

    async def list_audit(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = await self._db.fetch(
            """
            SELECT id, actor_id, action, resource_type, resource_id, outcome,
                   request_id::text AS request_id, detail, created_at
            FROM ai.audit_events
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            tenant_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            "SELECT count(*) FROM ai.audit_events WHERE tenant_id = $1", tenant_id
        )
        return items, int(total or 0)

    async def list_agents(self, tenant_id: int) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT id, code, name, description, kind, enabled, created_at, updated_at
            FROM ai.agents
            WHERE tenant_id = $1
            ORDER BY code
            """,
            tenant_id,
        )

    async def get_agent(self, tenant_id: int, agent_id: int) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            SELECT {self._AGENT_COLUMNS}
            FROM ai.agents
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            agent_id,
        )

    async def create_agent_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        await self._db.execute(
            """
            INSERT INTO ai.agents (tenant_id, code, name, description, kind, config)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (tenant_id, code) DO NOTHING
            """,
            tenant_id,
            data["code"],
            data["name"],
            data.get("description"),
            data.get("kind", "knowledge_assistant"),
            data.get("config", {}),
        )
        row = await self._db.fetchrow(
            """
            SELECT id, code, name, description, kind, enabled, created_at, updated_at
            FROM ai.agents WHERE tenant_id = $1 AND code = $2
            """,
            tenant_id,
            data["code"],
        )
        assert row is not None
        return row

    async def create_agent_version_if_absent(
        self, tenant_id: int, agent_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        await self._db.execute(
            """
            INSERT INTO ai.agent_versions (agent_id, version, definition, status)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (agent_id, version) DO NOTHING
            """,
            agent_id,
            data["version"],
            data.get("definition", {}),
            data.get("status", "active"),
        )
        row = await self._db.fetchrow(
            """
            SELECT id, agent_id, version, definition, status, created_at
            FROM ai.agent_versions WHERE agent_id = $1 AND version = $2
            """,
            agent_id,
            data["version"],
        )
        assert row is not None
        return row

    async def list_agent_versions(
        self, tenant_id: int, agent_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT v.id, v.agent_id, v.version, v.definition, v.status, v.created_at
            FROM ai.agent_versions v
            JOIN ai.agents a ON a.id = v.agent_id
            WHERE a.tenant_id = $1 AND v.agent_id = $2
            ORDER BY v.version DESC
            """,
            tenant_id,
            agent_id,
        )

    async def get_active_agent_version(
        self, tenant_id: int, agent_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT v.id, v.agent_id, v.version, v.definition, v.status, v.created_at
            FROM ai.agent_versions v
            JOIN ai.agents a ON a.id = v.agent_id
            WHERE a.tenant_id = $1 AND v.agent_id = $2 AND v.status = 'active'
            ORDER BY v.version DESC
            LIMIT 1
            """,
            tenant_id,
            agent_id,
        )

    async def list_executions(
        self,
        tenant_id: int,
        *,
        agent_id: int | None,
        operation: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1"]
        args: list[Any] = [tenant_id]
        if agent_id is not None:
            args.append(agent_id)
            clauses.append(f"agent_id = ${len(args)}")
        if operation is not None:
            args.append(operation)
            clauses.append(f"operation = ${len(args)}")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"""
            SELECT id, request_id::text AS request_id, actor_id, agent_id, model_id,
                   operation, status, input, output, error, latency_ms,
                   token_usage, created_at, completed_at
            FROM ai.executions
            WHERE {where}
            ORDER BY created_at DESC
            LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}
            """,
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.executions WHERE {where}", *args
        )
        return items, int(total or 0)

    async def get_execution(
        self, tenant_id: int, execution_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, request_id::text AS request_id, actor_id, agent_id, model_id,
                   operation, status, input, output, error, latency_ms,
                   token_usage, created_at, completed_at
            FROM ai.executions
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            execution_id,
        )

    async def record_feedback(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.feedback
                (tenant_id, execution_id, message_id, actor_id, rating, comment, category)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, execution_id, message_id, actor_id, rating, comment, category, created_at
            """,
            tenant_id,
            data.get("execution_id"),
            data.get("message_id"),
            data.get("actor_id"),
            data.get("rating"),
            data.get("comment"),
            data.get("category"),
        )
        assert row is not None
        return row

    async def list_feedback(
        self,
        tenant_id: int,
        *,
        execution_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1"]
        args: list[Any] = [tenant_id]
        if execution_id is not None:
            args.append(execution_id)
            clauses.append(f"execution_id = ${len(args)}")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"""
            SELECT id, execution_id, message_id, actor_id, rating, comment, category,
                   created_at
            FROM ai.feedback
            WHERE {where}
            ORDER BY created_at DESC
            LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}
            """,
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.feedback WHERE {where}", *args
        )
        return items, int(total or 0)

    async def get_governance_policy(self, tenant_id: int) -> dict[str, Any] | None:
        row = await self._db.fetchrow(
            "SELECT policy FROM ai.governance_policies WHERE tenant_id = $1", tenant_id
        )
        if row is None:
            return None
        return row.get("policy") or {}

    async def upsert_governance_policy(
        self, tenant_id: int, policy: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.governance_policies (tenant_id, policy)
            VALUES ($1, $2)
            ON CONFLICT (tenant_id)
            DO UPDATE SET policy = EXCLUDED.policy, updated_at = now()
            RETURNING policy
            """,
            tenant_id,
            policy,
        )
        return (row or {}).get("policy") or {}

    # --- Knowledge ingestion / retrieval (Phase 7) ----------------------

    async def create_or_replace_document(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        """Replace a document's indexed content, carrying its version forward.

        The previous row is snapshotted into ``ai.document_versions`` before the
        delete so an update stays explainable, then the new content is inserted
        at ``previous.version + 1``. A caller-supplied ``version`` is ignored:
        only the database assigns versions, so a client cannot rewind history.
        """
        async with self._db.transaction() as tx:
            previous = await tx.fetchrow(
                """
                SELECT id, source_id, external_id, version, title, mime_type,
                       checksum, size_bytes, classification, acl, metadata, status
                FROM ai.documents
                WHERE tenant_id = $1 AND source_id = $2 AND external_id = $3
                FOR UPDATE
                """,
                tenant_id,
                data["source_id"],
                data["external_id"],
            )
            version = 1
            if previous is not None:
                version = int(previous["version"] or 1) + 1
                await self._snapshot_version(
                    tx,
                    tenant_id,
                    previous,
                    reason=data.get("version_reason", "superseded"),
                )
                await tx.execute(
                    """
                    DELETE FROM ai.documents
                    WHERE tenant_id = $1 AND source_id = $2 AND external_id = $3
                    """,
                    tenant_id,
                    data["source_id"],
                    data["external_id"],
                )
            document = await tx.fetchrow(
                """
                INSERT INTO ai.documents
                    (tenant_id, source_id, external_id, title, mime_type, uri, object_key,
                     checksum, size_bytes, classification, acl, metadata, status,
                     indexed_at, version)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'indexed',
                        now(), $13)
                RETURNING id, source_id, external_id, title, mime_type, uri, object_key,
                          checksum, size_bytes, classification, acl, metadata, status,
                          indexed_at, search_indexed_at, error_class, created_at,
                          updated_at, version
                """,
                tenant_id,
                data["source_id"],
                data["external_id"],
                data.get("title"),
                data.get("mime_type"),
                data.get("uri"),
                data.get("object_key"),
                data.get("checksum"),
                data.get("size_bytes"),
                data.get("classification", "internal"),
                data.get("acl", {}),
                data.get("metadata", {}),
                version,
            )
        assert document is not None
        return document

    async def _snapshot_version(
        self,
        tx: Any,
        tenant_id: int,
        document: dict[str, Any],
        *,
        reason: str,
    ) -> None:
        """Record a metadata-only snapshot of a superseded document version.

        Only descriptive fields are retained. Chunk text is never copied, so a
        version row cannot resurrect content after a redaction or delete.
        """
        await tx.execute(
            """
            INSERT INTO ai.document_versions
                (tenant_id, document_id, source_id, external_id, version, title,
                 mime_type, checksum, size_bytes, classification, acl, metadata,
                 status, reason)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (tenant_id, document_id, version) DO NOTHING
            """,
            tenant_id,
            document["id"],
            document["source_id"],
            document["external_id"],
            int(document.get("version") or 1),
            document.get("title"),
            document.get("mime_type"),
            document.get("checksum"),
            document.get("size_bytes"),
            document.get("classification", "internal"),
            document.get("acl") or {},
            document.get("metadata") or {},
            document.get("status") or "indexed",
            reason,
        )
        # Bounded retention keyed on the stable identity, since a reindex gives
        # the document a new physical id but should not reset its history cap.
        await tx.execute(
            """
            DELETE FROM ai.document_versions
            WHERE tenant_id = $1
              AND (source_id, external_id) = ($2, $3)
              AND version <= (
                  SELECT version FROM ai.document_versions
                  WHERE tenant_id = $1
                    AND (source_id, external_id) = ($2, $3)
                  ORDER BY version DESC OFFSET 50 LIMIT 1
              )
            """,
            tenant_id,
            document["source_id"],
            document["external_id"],
        )

    async def update_document_metadata(
        self,
        tenant_id: int,
        document_id: int,
        *,
        title: str | None = None,
        metadata: dict[str, Any] | None = None,
        expected_version: int | None = None,
    ) -> dict[str, Any] | None:
        """Update title/metadata in place, bumping version and search state.

        Content and chunks are untouched, but ``search_indexed_at`` is cleared so
        the search copy is refreshed with the new metadata on the next reindex.
        """
        async with self._db.transaction() as tx:
            current = await tx.fetchrow(
                """
                SELECT id, source_id, external_id, version, title, mime_type,
                       checksum, size_bytes, classification, acl, metadata, status
                FROM ai.documents
                WHERE tenant_id = $1 AND id = $2
                FOR UPDATE
                """,
                tenant_id,
                document_id,
            )
            if current is None:
                return None
            if (
                expected_version is not None
                and int(current["version"] or 1) != expected_version
            ):
                return None
            await self._snapshot_version(
                tx, tenant_id, current, reason="metadata_update"
            )
            return await tx.fetchrow(
                """
                UPDATE ai.documents
                SET title = COALESCE($3, title),
                    metadata = COALESCE($4, metadata),
                    version = version + 1,
                    search_indexed_at = NULL,
                    updated_at = now()
                WHERE tenant_id = $1 AND id = $2
                RETURNING id, source_id, external_id, title, mime_type, uri, object_key,
                          checksum, size_bytes, classification, acl, metadata, status,
                          indexed_at, search_indexed_at, error_class, created_at,
                          updated_at, version
                """,
                tenant_id,
                document_id,
                title,
                metadata,
            )

    async def list_document_versions(
        self,
        tenant_id: int,
        document_id: int,
        *,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        # History follows the logical document, not the physical row: a reindex
        # replaces the document row (new id), so match on the stable identity
        # ``(source_id, external_id)`` as well as the current id.
        identity = """
            SELECT source_id, external_id FROM ai.documents
            WHERE tenant_id = $1 AND id = $2
        """
        rows = await self._db.fetch(
            f"""
            SELECT id, document_id, source_id, external_id, version, title,
                   mime_type, checksum, size_bytes, classification, acl,
                   metadata, status, reason, superseded_at
            FROM ai.document_versions
            WHERE tenant_id = $1
              AND (document_id = $2
                   OR (source_id, external_id) IN ({identity}))
            ORDER BY version DESC, id DESC
            LIMIT $3 OFFSET $4
            """,
            tenant_id,
            document_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"""
            SELECT count(*) FROM ai.document_versions
            WHERE tenant_id = $1
              AND (document_id = $2
                   OR (source_id, external_id) IN ({identity}))
            """,
            tenant_id,
            document_id,
        )
        return rows, int(total or 0)

    async def add_chunks(
        self, tenant_id: int, document_id: int, chunks: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for chunk in chunks:
            row = await self._db.fetchrow(
                """
                INSERT INTO ai.document_chunks
                    (tenant_id, document_id, chunk_index, content, token_count, checksum,
                     classification, acl, metadata, page, section)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING id, document_id, chunk_index, content, token_count, checksum,
                          classification, acl, metadata, page, section
                """,
                tenant_id,
                document_id,
                chunk["chunk_index"],
                chunk["content"],
                chunk.get("token_count"),
                chunk.get("checksum"),
                chunk.get("classification", "internal"),
                chunk.get("acl", {}),
                chunk.get("metadata", {}),
                chunk.get("page"),
                chunk.get("section"),
            )
            assert row is not None
            rows.append(row)
        return rows

    async def add_embeddings(self, tenant_id: int, rows: list[dict[str, Any]]) -> int:
        count = 0
        for row in rows:
            await self._db.execute(
                """
                INSERT INTO ai.embeddings (tenant_id, chunk_id, model_code, dimensions, embedding)
                VALUES ($1, $2, $3, $4, $5::vector)
                ON CONFLICT (chunk_id, model_code)
                DO UPDATE SET embedding = EXCLUDED.embedding,
                              dimensions = EXCLUDED.dimensions,
                              created_at = now()
                """,
                tenant_id,
                row["chunk_id"],
                row["model_code"],
                int(row.get("dimensions", 1536)),
                _vector_literal(row["embedding"]),
            )
            count += 1
        return count

    async def vector_search(
        self, tenant_id: int, embedding: list[float], *, limit: int
    ) -> list[dict[str, Any]]:
        literal = _vector_literal(embedding)
        return await self._db.fetch(
            """
            SELECT c.id AS chunk_id, c.document_id, c.chunk_index, c.content,
                   c.classification, c.acl, c.page, c.section,
                   d.source_id, d.title, d.mime_type, d.external_id,
                   d.status AS document_status, d.created_at AS document_created_at,
                   d.updated_at AS document_updated_at, d.metadata AS document_metadata,
                   s.code AS source_code, s.name AS source_name,
                   1 - (e.embedding <=> $2::vector) AS score
            FROM ai.embeddings e
            JOIN ai.document_chunks c ON c.id = e.chunk_id
            JOIN ai.documents d ON d.id = c.document_id
            JOIN ai.knowledge_sources s ON s.id = d.source_id
            WHERE e.tenant_id = $1
            ORDER BY e.embedding <=> $2::vector
            LIMIT $3
            """,
            tenant_id,
            literal,
            limit,
        )

    async def lexical_search(
        self, tenant_id: int, query: str, *, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT c.id AS chunk_id, c.document_id, c.chunk_index, c.content,
                   c.classification, c.acl, c.page, c.section,
                   d.source_id, d.title, d.mime_type, d.external_id,
                   d.status AS document_status, d.created_at AS document_created_at,
                   d.updated_at AS document_updated_at, d.metadata AS document_metadata,
                   s.code AS source_code, s.name AS source_name,
                   ts_rank(to_tsvector('english', c.content),
                           plainto_tsquery('english', $2)) AS score
            FROM ai.document_chunks c
            JOIN ai.documents d ON d.id = c.document_id
            JOIN ai.knowledge_sources s ON s.id = d.source_id
            WHERE c.tenant_id = $1
              AND to_tsvector('english', c.content) @@ plainto_tsquery('english', $2)
            ORDER BY score DESC
            LIMIT $3
            """,
            tenant_id,
            query,
            limit,
        )

    async def list_documents(
        self,
        tenant_id: int,
        source_id: int,
        *,
        limit: int,
        offset: int,
        classification_ceiling_rank: int,
    ) -> tuple[list[dict[str, Any]], int]:
        """List active-source documents within the tenant's classification ceiling.

        ACL matching stays in ``KnowledgeService`` so the exact same
        ``AccessControl.allows`` implementation used by download and retrieval is
        applied before pagination and totals. This query only narrows by tenant,
        source state and the classification ceiling.
        """
        items = await self._db.fetch(
            """
            WITH eligible AS (
                SELECT d.id, d.source_id, d.external_id, d.title, d.mime_type,
                       d.classification, d.acl, d.status, d.size_bytes, d.checksum,
                       d.metadata, d.version, d.indexed_at, d.search_indexed_at,
                       d.error_class, d.created_at, d.updated_at,
                       s.classification AS source_classification,
                       s.acl AS source_acl, s.status AS source_status,
                       GREATEST(
                           CASE COALESCE(NULLIF(d.classification, ''), 'internal')
                               WHEN 'public' THEN 0
                               WHEN 'internal' THEN 1
                               WHEN 'confidential' THEN 2
                               WHEN 'restricted' THEN 3
                               ELSE 4
                           END,
                           CASE COALESCE(NULLIF(s.classification, ''), 'internal')
                               WHEN 'public' THEN 0
                               WHEN 'internal' THEN 1
                               WHEN 'confidential' THEN 2
                               WHEN 'restricted' THEN 3
                               ELSE 4
                           END
                       ) AS effective_rank
                FROM ai.documents d
                JOIN ai.knowledge_sources s ON s.id = d.source_id
                WHERE d.tenant_id = $1 AND d.source_id = $2
                  AND s.status <> 'disabled'
            )
            SELECT id, source_id, external_id, title, mime_type, classification,
                   acl, status, size_bytes, checksum, metadata, version, indexed_at,
                   search_indexed_at, error_class, created_at, updated_at,
                   source_classification, source_acl, source_status
            FROM eligible
            WHERE effective_rank <= $3
            ORDER BY created_at DESC, id DESC
            LIMIT $4 OFFSET $5
            """,
            tenant_id,
            source_id,
            classification_ceiling_rank,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            """
            SELECT count(*)
            FROM ai.documents d
            JOIN ai.knowledge_sources s ON s.id = d.source_id
            WHERE d.tenant_id = $1 AND d.source_id = $2
              AND s.status <> 'disabled'
              AND GREATEST(
                  CASE COALESCE(NULLIF(d.classification, ''), 'internal')
                      WHEN 'public' THEN 0
                      WHEN 'internal' THEN 1
                      WHEN 'confidential' THEN 2
                      WHEN 'restricted' THEN 3
                      ELSE 4
                  END,
                  CASE COALESCE(NULLIF(s.classification, ''), 'internal')
                      WHEN 'public' THEN 0
                      WHEN 'internal' THEN 1
                      WHEN 'confidential' THEN 2
                      WHEN 'restricted' THEN 3
                      ELSE 4
                  END
              ) <= $3
            """,
            tenant_id,
            source_id,
            classification_ceiling_rank,
        )
        return items, int(total or 0)

    async def set_source_status(self, tenant_id: int, source_id: int, status: str) -> None:
        await self._db.execute(
            "UPDATE ai.knowledge_sources SET status = $3 WHERE tenant_id = $1 AND id = $2",
            tenant_id,
            source_id,
            status,
        )

    async def claim_job(
        self,
        tenant_id: int,
        job_id: int,
        *,
        lease_seconds: float,
        due_only: bool = True,
    ) -> dict[str, Any] | None:
        """Atomically lease an eligible job so two workers cannot both run it.

        The eligibility test, the row lock (``FOR UPDATE SKIP LOCKED``) and the
        ``UPDATE`` are one statement, so a concurrent claimant either locks a
        still-eligible row or gets ``None``. Like ``claim_agent_execution``, an
        expired ``running`` lease is reclaimable; a live lease is not.
        """
        return await self._db.fetchrow(
            """
            UPDATE ai.jobs
            SET status = 'running',
                stage = 'processing',
                started_at = now(),
                attempts = attempts + 1,
                lease_expires_at = now() + ($3 || ' seconds')::interval,
                next_attempt_at = NULL
            WHERE id = (
                SELECT id FROM ai.jobs
                WHERE tenant_id = $1 AND id = $2
                  AND (
                        (status = 'queued'
                         AND (NOT $4
                              OR next_attempt_at IS NULL
                              OR next_attempt_at <= now()))
                     OR (status = 'running'
                         AND lease_expires_at IS NOT NULL
                         AND lease_expires_at < now())
                  )
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, tenant_id, type, status, source_id, progress, attempts,
                      max_attempts, stage, error_class, lease_expires_at,
                      next_attempt_at, payload, created_at, started_at, finished_at
            """,
            tenant_id,
            job_id,
            str(lease_seconds),
            due_only,
        )

    async def update_job(
        self,
        tenant_id: int,
        job_id: int,
        fields: dict[str, Any],
        *,
        expected_attempts: int | None = None,
    ) -> dict[str, Any] | None:
        # Only the columns named in ``fields`` are written, so an omitted key is
        # left untouched while an explicit ``None`` clears it. The previous
        # ``COALESCE`` form could not clear a column: a success or retry write
        # passing ``lease_expires_at=None``/``error=None`` silently kept the
        # stale value, diverging from the memory repository's ``dict.update``.
        allowed = (
            "status",
            "progress",
            "attempts",
            "result",
            "error",
            "started_at",
            "finished_at",
            "stage",
            "error_class",
            "lease_expires_at",
            "next_attempt_at",
        )
        args: list[Any] = [tenant_id, job_id]
        assignments: list[str] = []
        for column in allowed:
            if column in fields:
                args.append(fields[column])
                assignments.append(f"{column} = ${len(args)}")
        if not assignments:
            return await self.get_job(tenant_id, job_id)
        fence = ""
        if expected_attempts is not None:
            args.append(int(expected_attempts))
            fence = f" AND attempts = ${len(args)}"
        return await self._db.fetchrow(
            f"""
            UPDATE ai.jobs
            SET {", ".join(assignments)}
            WHERE tenant_id = $1 AND id = $2{fence}
            RETURNING id, type, status, source_id, progress, attempts, max_attempts,
                      stage, error_class, lease_expires_at, next_attempt_at,
                      created_at, started_at, finished_at, result, error
            """,
            *args,
        )

    async def delete_source(self, tenant_id: int, source_id: int) -> bool:
        result = await self._db.execute(
            "DELETE FROM ai.knowledge_sources WHERE tenant_id = $1 AND id = $2",
            tenant_id,
            source_id,
        )
        return result.endswith("1")

    async def delete_document(self, tenant_id: int, document_id: int) -> bool:
        async with self._db.transaction() as tx:
            current = await tx.fetchrow(
                """
                SELECT id, source_id, external_id, version, title, mime_type,
                       checksum, size_bytes, classification, acl, metadata, status
                FROM ai.documents
                WHERE tenant_id = $1 AND id = $2
                FOR UPDATE
                """,
                tenant_id,
                document_id,
            )
            if current is None:
                return False
            await self._snapshot_version(tx, tenant_id, current, reason="deleted")
            result = await tx.execute(
                "DELETE FROM ai.documents WHERE tenant_id = $1 AND id = $2",
                tenant_id,
                document_id,
            )
        return result.endswith("1")

    async def list_jobs_by_status(
        self, status: str, *, limit: int, due_only: bool = True
    ) -> list[dict[str, Any]]:
        due_clause = (
            "AND (next_attempt_at IS NULL OR next_attempt_at <= now())"
            if due_only
            else ""
        )
        return await self._db.fetch(
            f"""
            SELECT id, tenant_id, type, status, source_id, attempts, max_attempts,
                   stage, error_class, lease_expires_at, next_attempt_at, payload
            FROM ai.jobs
            WHERE status = $1 {due_clause}
            ORDER BY id
            LIMIT $2
            """,
            status,
            limit,
        )

    async def list_tenant_ids(
        self, *, limit: int, after_tenant_id: int = 0
    ) -> list[int]:
        rows = await self._db.fetch(
            """
            SELECT tenant_id FROM (
                SELECT DISTINCT tenant_id FROM ai.knowledge_sources
                UNION SELECT DISTINCT tenant_id FROM ai.documents
                UNION SELECT DISTINCT tenant_id FROM ai.jobs
            ) AS tenants
            WHERE tenant_id > $1
            ORDER BY tenant_id
            LIMIT $2
            """,
            after_tenant_id,
            limit,
        )
        return [int(row["tenant_id"]) for row in rows]

    async def job_metrics(self, *, stale_before: datetime) -> dict[str, Any]:
        status_rows = await self._db.fetch(
            "SELECT status, count(*) AS count FROM ai.jobs GROUP BY status"
        )
        overdue = await self._db.fetchval(
            """
            SELECT count(*) FROM ai.jobs
            WHERE idempotency_key LIKE 'source-security-%'
              AND status IN ('queued', 'running', 'failed')
              AND COALESCE(next_attempt_at, created_at) < $1
            """,
            stale_before,
        )
        return {
            "by_status": {row["status"]: int(row["count"]) for row in status_rows},
            "security_refresh_overdue": int(overdue or 0),
        }

    async def list_jobs(
        self, tenant_id: int, *, status: str | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            """
            SELECT id, type, status, source_id, progress, attempts, max_attempts,
                   stage, error_class, lease_expires_at,
                   created_at, started_at, finished_at
            FROM ai.jobs
            WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
            ORDER BY id DESC
            LIMIT $3 OFFSET $4
            """,
            tenant_id,
            status,
            limit,
            offset,
        )
        total_row = await self._db.fetchrow(
            """
            SELECT count(*) AS total
            FROM ai.jobs
            WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
            """,
            tenant_id,
            status,
        )
        return rows, int(total_row["total"]) if total_row else 0

    async def list_source_chunks(
        self, tenant_id: int, source_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT d.id AS document_id, d.external_id, d.title, d.mime_type,
                   d.object_key,
                   c.chunk_index, c.content, c.classification, c.acl, c.metadata,
                   c.page, c.section,
                   d.classification AS document_classification,
                   d.acl AS document_acl, d.status AS document_status,
                   d.metadata AS document_metadata, d.version AS document_version,
                   s.classification AS source_classification,
                   s.acl AS source_acl, s.status AS source_status
            FROM ai.documents d
            JOIN ai.document_chunks c ON c.document_id = d.id
            JOIN ai.knowledge_sources s ON s.id = d.source_id
            WHERE d.tenant_id = $1 AND d.source_id = $2
            ORDER BY d.id, c.chunk_index
            """,
            tenant_id,
            source_id,
        )

    async def list_document_chunks(
        self, tenant_id: int, document_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            """
            SELECT c.id AS chunk_id, c.document_id, c.chunk_index, c.content,
                   c.classification, c.acl, c.metadata, c.page, c.section
            FROM ai.document_chunks c
            JOIN ai.documents d ON d.id = c.document_id
            WHERE d.tenant_id = $1 AND c.document_id = $2
            ORDER BY c.chunk_index, c.id
            LIMIT $3 OFFSET $4
            """,
            tenant_id,
            document_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            """
            SELECT count(*) FROM ai.document_chunks c
            JOIN ai.documents d ON d.id = c.document_id
            WHERE d.tenant_id = $1 AND c.document_id = $2
            """,
            tenant_id,
            document_id,
        )
        return rows, int(total or 0)

    async def get_authoritative_chunks(
        self, tenant_id: int, chunk_ids: list[int]
    ) -> list[dict[str, Any]]:
        """Current chunk/document/source state for the given chunk ids.

        Retrieval uses this to re-check authorization against live labels instead
        of trusting labels copied into a search index. Rows are tenant-scoped, so
        a cross-tenant or deleted chunk id simply resolves to nothing.
        """
        if not chunk_ids:
            return []
        return await self._db.fetch(
            """
            SELECT c.id AS chunk_id, c.document_id, c.chunk_index, c.content,
                   c.classification AS chunk_classification, c.acl AS chunk_acl,
                   c.page, c.section,
                   d.source_id, d.title, d.mime_type, d.external_id,
                   d.status AS document_status,
                   d.classification AS document_classification,
                   d.acl AS document_acl,
                   d.created_at AS document_created_at,
                   d.updated_at AS document_updated_at,
                   d.metadata AS document_metadata, d.version AS document_version,
                   s.code AS source_code, s.name AS source_name,
                   s.status AS source_status,
                   s.classification AS source_classification,
                   s.acl AS source_acl
            FROM ai.document_chunks c
            JOIN ai.documents d ON d.id = c.document_id
            JOIN ai.knowledge_sources s ON s.id = d.source_id
            WHERE c.tenant_id = $1 AND c.id = ANY($2::bigint[])
            """,
            tenant_id,
            chunk_ids,
        )

    async def existing_document_ids(
        self, tenant_id: int, document_ids: list[int]
    ) -> set[int]:
        if not document_ids:
            return set()
        rows = await self._db.fetch(
            """
            SELECT id FROM ai.documents
            WHERE tenant_id = $1 AND id = ANY($2::bigint[])
            """,
            tenant_id,
            document_ids,
        )
        return {int(row["id"]) for row in rows}

    async def source_states(
        self, tenant_id: int, source_ids: list[int]
    ) -> dict[int, str]:
        if not source_ids:
            return {}
        rows = await self._db.fetch(
            """
            SELECT id, status FROM ai.knowledge_sources
            WHERE tenant_id = $1 AND id = ANY($2::bigint[])
            """,
            tenant_id,
            source_ids,
        )
        return {int(row["id"]): row["status"] for row in rows}

    async def get_document(
        self, tenant_id: int, document_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT d.id, d.source_id, d.external_id, d.title, d.mime_type, d.uri,
                   d.object_key, d.checksum, d.size_bytes, d.classification, d.acl,
                   d.metadata, d.status, d.indexed_at, d.search_indexed_at,
                   d.error_class, d.created_at, d.updated_at, d.version,
                   s.code AS source_code,
                   s.classification AS source_classification, s.acl AS source_acl,
                   s.status AS source_status
            FROM ai.documents d
            JOIN ai.knowledge_sources s ON s.id = d.source_id
            WHERE d.tenant_id = $1 AND d.id = $2
            """,
            tenant_id,
            document_id,
        )

    async def find_document_by_checksum(
        self, tenant_id: int, checksum: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT d.id, d.source_id, d.external_id, d.title, d.mime_type,
                   d.object_key, d.size_bytes, d.status,
                   d.classification, d.created_at, s.code AS source_code
            FROM ai.documents d
            JOIN ai.knowledge_sources s ON s.id = d.source_id
            WHERE d.tenant_id = $1 AND d.checksum = $2
            ORDER BY d.created_at DESC
            LIMIT 1
            """,
            tenant_id,
            checksum,
        )

    async def set_document_search_state(
        self,
        tenant_id: int,
        document_id: int,
        *,
        search_indexed_at: datetime | None,
        status: str | None = None,
        error_class: str | None = None,
    ) -> None:
        await self._db.execute(
            """
            UPDATE ai.documents
            SET search_indexed_at = COALESCE($3, search_indexed_at),
                status = COALESCE($4, status),
                error_class = $5
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            document_id,
            search_indexed_at,
            status,
            error_class,
        )

    # --- ML experiment tracking and model registry (Phase 11) ------------
    async def create_experiment_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.experiments
                (tenant_id, code, name, description, problem_type,
                 tracking_backend, external_experiment_id, tags)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (tenant_id, code) DO NOTHING
            RETURNING id, code, name, description, problem_type,
                      tracking_backend, external_experiment_id, tags,
                      created_at, updated_at
            """,
            tenant_id,
            data["code"],
            data["name"],
            data.get("description"),
            data.get("problem_type", "classification"),
            data.get("tracking_backend", "local"),
            data.get("external_experiment_id"),
            data.get("tags", {}),
        )
        if row is not None:
            return row
        existing = await self._db.fetchrow(
            """
            SELECT id, code, name, description, problem_type,
                   tracking_backend, external_experiment_id, tags,
                   created_at, updated_at
            FROM ai.experiments
            WHERE tenant_id = $1 AND code = $2
            """,
            tenant_id,
            data["code"],
        )
        assert existing is not None
        return existing

    async def list_experiments(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            """
            SELECT id, code, name, description, problem_type,
                   tracking_backend, external_experiment_id, tags,
                   created_at, updated_at
            FROM ai.experiments
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            tenant_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            "SELECT count(*) FROM ai.experiments WHERE tenant_id = $1", tenant_id
        )
        return rows, int(total or 0)

    async def get_experiment(
        self, tenant_id: int, experiment_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, code, name, description, problem_type,
                   tracking_backend, external_experiment_id, tags,
                   created_at, updated_at
            FROM ai.experiments
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            experiment_id,
        )

    async def update_experiment_tracking(
        self,
        tenant_id: int,
        experiment_id: int,
        *,
        tracking_backend: str,
        external_experiment_id: str | None,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            UPDATE ai.experiments
            SET tracking_backend = $3, external_experiment_id = $4
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, code, name, description, problem_type,
                      tracking_backend, external_experiment_id, tags,
                      created_at, updated_at
            """,
            tenant_id,
            experiment_id,
            tracking_backend,
            external_experiment_id,
        )

    async def create_experiment_run(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.experiment_runs
                (tenant_id, experiment_id, run_name, status, external_run_id,
                 artifact_uri, params, metrics, training_config, dataset_ref,
                 code_version, logged_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id, experiment_id, run_uuid::text AS run_uuid, run_name, status,
                      external_run_id, artifact_uri, params, metrics,
                      training_config, dataset_ref, code_version, logged_by,
                      created_at, finished_at
            """,
            tenant_id,
            data["experiment_id"],
            data.get("run_name"),
            data.get("status", "running"),
            data.get("external_run_id"),
            data.get("artifact_uri"),
            data.get("params", {}),
            data.get("metrics", {}),
            data.get("training_config", {}),
            data.get("dataset_ref", {}),
            data.get("code_version"),
            data.get("logged_by"),
        )
        assert row is not None
        return row

    async def list_experiment_runs(
        self,
        tenant_id: int,
        *,
        experiment_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            """
            SELECT id, experiment_id, run_uuid::text AS run_uuid, run_name, status,
                   external_run_id, artifact_uri, params, metrics,
                   training_config, dataset_ref, code_version, logged_by,
                   created_at, finished_at
            FROM ai.experiment_runs
            WHERE tenant_id = $1 AND ($2::bigint IS NULL OR experiment_id = $2)
            ORDER BY created_at DESC
            LIMIT $3 OFFSET $4
            """,
            tenant_id,
            experiment_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            """
            SELECT count(*) FROM ai.experiment_runs
            WHERE tenant_id = $1 AND ($2::bigint IS NULL OR experiment_id = $2)
            """,
            tenant_id,
            experiment_id,
        )
        return rows, int(total or 0)

    async def get_experiment_run(
        self, tenant_id: int, run_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, experiment_id, run_uuid::text AS run_uuid, run_name, status,
                   external_run_id, artifact_uri, params, metrics,
                   training_config, dataset_ref, code_version, logged_by,
                   created_at, finished_at
            FROM ai.experiment_runs
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            run_id,
        )

    async def update_experiment_run(
        self, tenant_id: int, run_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {"status", "metrics", "params", "artifact_uri", "external_run_id", "finished_at"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return await self.get_experiment_run(tenant_id, run_id)
        assignments = ", ".join(f"{column} = ${index + 3}" for index, column in enumerate(updates))
        return await self._db.fetchrow(
            f"""
            UPDATE ai.experiment_runs
            SET {assignments}
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, experiment_id, run_uuid::text AS run_uuid, run_name, status,
                      external_run_id, artifact_uri, params, metrics,
                      training_config, dataset_ref, code_version, logged_by,
                      created_at, finished_at
            """,
            tenant_id,
            run_id,
            *updates.values(),
        )

    async def create_ml_model_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.ml_models
                (tenant_id, code, name, description, problem_type, framework, task, stage)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (tenant_id, code) DO NOTHING
            RETURNING id, code, name, description, problem_type, framework,
                      task, stage, created_at, updated_at
            """,
            tenant_id,
            data["code"],
            data["name"],
            data.get("description"),
            data.get("problem_type", "classification"),
            data.get("framework", "scikit-learn"),
            data.get("task"),
            data.get("stage", "none"),
        )
        if row is not None:
            return row
        existing = await self._db.fetchrow(
            """
            SELECT id, code, name, description, problem_type, framework,
                   task, stage, created_at, updated_at
            FROM ai.ml_models
            WHERE tenant_id = $1 AND code = $2
            """,
            tenant_id,
            data["code"],
        )
        assert existing is not None
        return existing

    async def list_ml_models(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            """
            SELECT id, code, name, description, problem_type, framework,
                   task, stage, created_at, updated_at
            FROM ai.ml_models
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            tenant_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            "SELECT count(*) FROM ai.ml_models WHERE tenant_id = $1", tenant_id
        )
        return rows, int(total or 0)

    async def get_ml_model(self, tenant_id: int, model_id: int) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, code, name, description, problem_type, framework,
                   task, stage, created_at, updated_at
            FROM ai.ml_models
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            model_id,
        )

    async def set_ml_model_stage(
        self, tenant_id: int, model_id: int, stage: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            UPDATE ai.ml_models
            SET stage = $3
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, code, name, description, problem_type, framework,
                      task, stage, created_at, updated_at
            """,
            tenant_id,
            model_id,
            stage,
        )

    async def create_ml_model_version(
        self, tenant_id: int, model_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.ml_model_versions
                (ml_model_id, version, run_id, status, framework, metrics,
                 parameters, validation, artifact_uri, external_model_version)
            SELECT m.id,
                   COALESCE(
                       (SELECT MAX(version) FROM ai.ml_model_versions
                        WHERE ml_model_id = m.id),
                       0
                   ) + 1,
                   $3, $4, $5, $6, $7, $8, $9, $10
            FROM ai.ml_models m
            WHERE m.tenant_id = $1 AND m.id = $2
            RETURNING id, ml_model_id, version, run_id, status, framework,
                      metrics, parameters, validation, artifact_uri,
                      external_model_version, created_at
            """,
            tenant_id,
            model_id,
            data.get("run_id"),
            data.get("status", "staging"),
            data.get("framework"),
            data.get("metrics", {}),
            data.get("parameters", {}),
            data.get("validation", {}),
            data.get("artifact_uri"),
            data.get("external_model_version"),
        )
        assert row is not None
        return row

    async def list_ml_model_versions(
        self, tenant_id: int, model_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT v.id, v.ml_model_id, v.version, v.run_id, v.status,
                   v.framework, v.metrics, v.parameters, v.validation,
                   v.artifact_uri, v.external_model_version, v.created_at
            FROM ai.ml_model_versions v
            JOIN ai.ml_models m ON m.id = v.ml_model_id
            WHERE m.tenant_id = $1 AND v.ml_model_id = $2
            ORDER BY v.version DESC
            """,
            tenant_id,
            model_id,
        )

    async def get_ml_model_version(
        self, tenant_id: int, model_id: int, version: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT v.id, v.ml_model_id, v.version, v.run_id, v.status,
                   v.framework, v.metrics, v.parameters, v.validation,
                   v.artifact_uri, v.external_model_version, v.created_at
            FROM ai.ml_model_versions v
            JOIN ai.ml_models m ON m.id = v.ml_model_id
            WHERE m.tenant_id = $1 AND v.ml_model_id = $2 AND v.version = $3
            """,
            tenant_id,
            model_id,
            version,
        )

    async def update_ml_model_version(
        self, tenant_id: int, model_id: int, version: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {"status", "metrics", "validation", "artifact_uri", "external_model_version"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return await self.get_ml_model_version(tenant_id, model_id, version)
        assignments = ", ".join(
            f"{column} = ${index + 4}" for index, column in enumerate(updates)
        )
        return await self._db.fetchrow(
            f"""
            UPDATE ai.ml_model_versions v
            SET {assignments}
            FROM ai.ml_models m
            WHERE v.ml_model_id = m.id AND m.tenant_id = $1
              AND v.ml_model_id = $2 AND v.version = $3
            RETURNING v.id, v.ml_model_id, v.version, v.run_id, v.status,
                      v.framework, v.metrics, v.parameters, v.validation,
                      v.artifact_uri, v.external_model_version, v.created_at
            """,
            tenant_id,
            model_id,
            version,
            *updates.values(),
        )

    async def create_evaluation_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.evaluations (tenant_id, code, name, kind, config)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (tenant_id, code) DO NOTHING
            RETURNING id, code, name, kind, config, created_at
            """,
            tenant_id,
            data["code"],
            data["name"],
            data.get("kind", "retrieval"),
            data.get("config", {}),
        )
        if row is not None:
            return row
        existing = await self._db.fetchrow(
            """
            SELECT id, code, name, kind, config, created_at
            FROM ai.evaluations
            WHERE tenant_id = $1 AND code = $2
            """,
            tenant_id,
            data["code"],
        )
        assert existing is not None
        return existing

    async def list_evaluations(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            """
            SELECT id, code, name, kind, config, created_at
            FROM ai.evaluations
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            tenant_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            "SELECT count(*) FROM ai.evaluations WHERE tenant_id = $1", tenant_id
        )
        return rows, int(total or 0)

    async def get_evaluation(
        self, tenant_id: int, evaluation_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, code, name, kind, config, created_at
            FROM ai.evaluations
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            evaluation_id,
        )

    async def record_evaluation_result(
        self, tenant_id: int, evaluation_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.evaluation_results (evaluation_id, case_id, metrics, passed)
            VALUES ($1, $2, $3, $4)
            RETURNING id, evaluation_id, case_id, metrics, passed, created_at
            """,
            evaluation_id,
            data["case_id"],
            data.get("metrics", {}),
            data.get("passed"),
        )
        assert row is not None
        return row

    async def list_evaluation_results(
        self, tenant_id: int, evaluation_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            """
            SELECT r.id, r.evaluation_id, r.case_id, r.metrics, r.passed, r.created_at
            FROM ai.evaluation_results r
            JOIN ai.evaluations e ON e.id = r.evaluation_id
            WHERE e.tenant_id = $1 AND r.evaluation_id = $2
            ORDER BY r.created_at DESC
            LIMIT $3 OFFSET $4
            """,
            tenant_id,
            evaluation_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            """
            SELECT count(*)
            FROM ai.evaluation_results r
            JOIN ai.evaluations e ON e.id = r.evaluation_id
            WHERE e.tenant_id = $1 AND r.evaluation_id = $2
            """,
            tenant_id,
            evaluation_id,
        )
        return rows, int(total or 0)

    # --- Assistant conversations (Stage 3) ------------------------------
    _CONVERSATION_COLUMNS = (
        "id, tenant_id, actor_id, title, status, metadata, created_at, updated_at"
    )
    _MESSAGE_COLUMNS = (
        "id, tenant_id, conversation_id, role, content, answer_status, warnings, "
        "citations_required, citation_status, confidence, "
        "is_mock, model_code, provider_code, token_usage, latency_ms, execution_id, "
        "request_id, error, task_type, generation_status, prompt_version, "
        "parent_message_id, cancelled_at, created_at"
    )
    _SOURCE_COLUMNS = (
        "id, message_id, rank, source_id, document_id, chunk_id, source_code, "
        "chunk_index, page, section, score, snippet"
    )

    async def create_conversation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.assistant_conversations (tenant_id, actor_id, title, metadata)
            VALUES ($1, $2, $3, $4)
            RETURNING {self._CONVERSATION_COLUMNS}
            """,
            tenant_id,
            data.get("actor_id"),
            data.get("title"),
            data.get("metadata", {}),
        )
        assert row is not None
        return row

    async def list_conversations(
        self, tenant_id: int, actor_id: int | None, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            f"""
            SELECT {self._CONVERSATION_COLUMNS}
            FROM ai.assistant_conversations
            WHERE tenant_id = $1 AND status <> 'deleted'
              AND ($2::bigint IS NULL OR actor_id = $2)
            ORDER BY updated_at DESC
            LIMIT $3 OFFSET $4
            """,
            tenant_id,
            actor_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            """
            SELECT count(*) FROM ai.assistant_conversations
            WHERE tenant_id = $1 AND status <> 'deleted'
              AND ($2::bigint IS NULL OR actor_id = $2)
            """,
            tenant_id,
            actor_id,
        )
        return rows, int(total or 0)

    async def get_conversation(
        self, tenant_id: int, conversation_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            SELECT {self._CONVERSATION_COLUMNS}
            FROM ai.assistant_conversations
            WHERE tenant_id = $1 AND id = $2 AND status <> 'deleted'
            """,
            tenant_id,
            conversation_id,
        )

    async def delete_conversation(self, tenant_id: int, conversation_id: int) -> bool:
        row = await self._db.fetchval(
            """
            UPDATE ai.assistant_conversations
            SET status = 'deleted', deleted_at = now(), updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status <> 'deleted'
            RETURNING id
            """,
            tenant_id,
            conversation_id,
        )
        return row is not None

    async def touch_conversation(self, tenant_id: int, conversation_id: int) -> None:
        await self._db.execute(
            """
            UPDATE ai.assistant_conversations SET updated_at = now()
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            conversation_id,
        )

    async def update_conversation(
        self, tenant_id: int, conversation_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.assistant_conversations
            SET title = COALESCE($3, title),
                status = COALESCE($4, status),
                metadata = COALESCE($5, metadata),
                updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status <> 'deleted'
            RETURNING {self._CONVERSATION_COLUMNS}
            """,
            tenant_id,
            conversation_id,
            data.get("title"),
            data.get("status"),
            data.get("metadata"),
        )

    async def add_message(
        self, tenant_id: int, conversation_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.assistant_messages
                (tenant_id, conversation_id, role, content, answer_status, warnings,
                 citations_required, citation_status, confidence,
                 is_mock, model_code, provider_code, token_usage, latency_ms,
                 execution_id, request_id, error, task_type, generation_status,
                 prompt_version, parent_message_id, cancelled_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, NULLIF($16, '')::uuid, $17, $18, $19,
                    $20, $21, $22)
            RETURNING {self._MESSAGE_COLUMNS}
            """,
            tenant_id,
            conversation_id,
            data["role"],
            data.get("content", ""),
            data.get("answer_status"),
            data.get("warnings") or [],
            bool(data.get("citations_required", False)),
            data.get("citation_status"),
            data.get("confidence"),
            data.get("is_mock"),
            data.get("model_code"),
            data.get("provider_code"),
            data.get("token_usage", {}),
            data.get("latency_ms"),
            data.get("execution_id"),
            data.get("request_id"),
            data.get("error"),
            data.get("task_type"),
            data.get("generation_status") or "completed",
            data.get("prompt_version"),
            data.get("parent_message_id"),
            data.get("cancelled_at"),
        )
        assert row is not None
        return row

    async def update_message(
        self, tenant_id: int, message_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.assistant_messages
            SET content = COALESCE($3, content),
                answer_status = COALESCE($4, answer_status),
                warnings = COALESCE($5, warnings),
                citations_required = COALESCE($6, citations_required),
                citation_status = COALESCE($7, citation_status),
                confidence = COALESCE($8, confidence),
                token_usage = COALESCE($9, token_usage),
                latency_ms = COALESCE($10, latency_ms),
                error = COALESCE($11, error),
                generation_status = COALESCE($12, generation_status),
                cancelled_at = CASE
                    WHEN $12 = 'cancelled' THEN COALESCE(cancelled_at, now())
                    ELSE cancelled_at
                END
            WHERE tenant_id = $1 AND id = $2
            RETURNING {self._MESSAGE_COLUMNS}
            """,
            tenant_id,
            message_id,
            data.get("content"),
            data.get("answer_status"),
            data.get("warnings"),
            data.get("citations_required"),
            data.get("citation_status"),
            data.get("confidence"),
            data.get("token_usage"),
            data.get("latency_ms"),
            data.get("error"),
            data.get("generation_status"),
        )

    async def list_messages(
        self, tenant_id: int, conversation_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            f"""
            SELECT {self._MESSAGE_COLUMNS}
            FROM ai.assistant_messages
            WHERE tenant_id = $1 AND conversation_id = $2
            ORDER BY created_at, id
            LIMIT $3 OFFSET $4
            """,
            tenant_id,
            conversation_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            """
            SELECT count(*) FROM ai.assistant_messages
            WHERE tenant_id = $1 AND conversation_id = $2
            """,
            tenant_id,
            conversation_id,
        )
        return rows, int(total or 0)

    async def list_recent_messages(
        self, tenant_id: int, conversation_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        rows = await self._db.fetch(
            f"""
            SELECT {self._MESSAGE_COLUMNS}
            FROM (
                SELECT * FROM ai.assistant_messages
                WHERE tenant_id = $1 AND conversation_id = $2
                ORDER BY created_at DESC, id DESC
                LIMIT $3
            ) recent
            ORDER BY created_at, id
            """,
            tenant_id,
            conversation_id,
            limit,
        )
        return rows

    async def add_message_sources(
        self, tenant_id: int, message_id: int, sources: list[dict[str, Any]]
    ) -> None:
        for source in sources:
            await self._db.execute(
                """
                INSERT INTO ai.assistant_message_sources
                    (tenant_id, message_id, rank, source_id, document_id, chunk_id,
                     source_code, chunk_index, page, section, score, snippet)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (message_id, rank) DO NOTHING
                """,
                tenant_id,
                message_id,
                source["rank"],
                source.get("source_id"),
                source.get("document_id"),
                source.get("chunk_id"),
                source.get("source_code"),
                source.get("chunk_index"),
                source.get("page"),
                source.get("section"),
                source.get("score"),
                source.get("snippet"),
            )

    async def get_message_sources(
        self, tenant_id: int, message_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"""
            SELECT {self._SOURCE_COLUMNS}
            FROM ai.assistant_message_sources
            WHERE tenant_id = $1 AND message_id = $2
            ORDER BY rank
            """,
            tenant_id,
            message_id,
        )

    async def get_message(
        self, tenant_id: int, message_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            SELECT {self._MESSAGE_COLUMNS}
            FROM ai.assistant_messages
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            message_id,
        )

    _CONTEXT_COLUMNS = (
        "id, tenant_id, conversation_id, message_id, context_type, object_id, "
        "display_name, source_system, revision, lifecycle_state, metadata, "
        "provenance, created_at"
    )

    async def add_context_refs(
        self, tenant_id: int, message_id: int, refs: list[dict[str, Any]]
    ) -> None:
        for ref in refs:
            await self._db.execute(
                """
                INSERT INTO ai.assistant_context_refs
                    (tenant_id, conversation_id, message_id, context_type, object_id,
                     display_name, source_system, revision, lifecycle_state,
                     metadata, provenance)
                VALUES (
                    $1,
                    (SELECT conversation_id FROM ai.assistant_messages
                     WHERE tenant_id = $1 AND id = $2),
                    $2, $3, $4, $5, $6, $7, $8, $9, $10
                )
                ON CONFLICT (message_id, context_type, object_id) DO UPDATE
                SET display_name = EXCLUDED.display_name,
                    source_system = EXCLUDED.source_system,
                    revision = EXCLUDED.revision,
                    lifecycle_state = EXCLUDED.lifecycle_state,
                    metadata = EXCLUDED.metadata,
                    provenance = EXCLUDED.provenance
                """,
                tenant_id,
                message_id,
                ref["context_type"],
                ref["object_id"],
                ref.get("display_name"),
                ref.get("source_system"),
                ref.get("revision"),
                ref.get("lifecycle_state"),
                ref.get("metadata", {}),
                ref.get("provenance", {}),
            )

    async def list_context_refs(
        self, tenant_id: int, message_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"""
            SELECT {self._CONTEXT_COLUMNS}
            FROM ai.assistant_context_refs
            WHERE tenant_id = $1 AND message_id = $2
            ORDER BY id
            """,
            tenant_id,
            message_id,
        )

    async def get_conversation_summary(
        self, tenant_id: int, conversation_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT conversation_id, tenant_id, summary, through_message_id,
                   token_estimate, created_at, updated_at
            FROM ai.assistant_conversation_summaries
            WHERE tenant_id = $1 AND conversation_id = $2
            """,
            tenant_id,
            conversation_id,
        )

    async def upsert_conversation_summary(
        self, tenant_id: int, conversation_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.assistant_conversation_summaries
                (tenant_id, conversation_id, summary, through_message_id,
                 token_estimate)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (conversation_id) DO UPDATE
            SET summary = EXCLUDED.summary,
                through_message_id = EXCLUDED.through_message_id,
                token_estimate = EXCLUDED.token_estimate,
                updated_at = now()
            RETURNING conversation_id, tenant_id, summary, through_message_id,
                      token_estimate, created_at, updated_at
            """,
            tenant_id,
            conversation_id,
            data["summary"],
            data.get("through_message_id"),
            data.get("token_estimate"),
        )
        assert row is not None
        return row

    # --- Copilot tool trace + controlled actions (Stage 5) -------------
    _TOOL_INVOCATION_COLUMNS = (
        "id, tenant_id, conversation_id, message_id, tool_code, status, "
        "read_only, arguments, result_summary, error_class, duration_ms, "
        "request_id, created_at"
    )
    _ACTION_COLUMNS = (
        "id, tenant_id, conversation_id, message_id, action_type, target, "
        "summary, arguments, expected_effect, evidence, operation_hash, "
        "risk_class, status, requested_by, requested_by_name, approved_by, "
        "approved_by_name, decision_reason, decided_at, executed_by, "
        "executed_by_name, executed_at, result, error_class, request_id, "
        "expires_at, created_at, updated_at"
    )

    async def record_copilot_tool_invocation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.copilot_tool_invocations
                (tenant_id, conversation_id, message_id, tool_code, status,
                 read_only, arguments, result_summary, error_class, duration_ms,
                 request_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING {self._TOOL_INVOCATION_COLUMNS}
            """,
            tenant_id,
            data.get("conversation_id"),
            data.get("message_id"),
            data["tool_code"],
            data.get("status") or "succeeded",
            bool(data.get("read_only", True)),
            data.get("arguments") or {},
            data.get("result_summary") or {},
            data.get("error_class"),
            data.get("duration_ms"),
            data.get("request_id"),
        )
        assert row is not None
        return row

    async def list_copilot_tool_invocations(
        self, tenant_id: int, message_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"""
            SELECT {self._TOOL_INVOCATION_COLUMNS}
            FROM ai.copilot_tool_invocations
            WHERE tenant_id = $1 AND message_id = $2
            ORDER BY id
            """,
            tenant_id,
            message_id,
        )

    async def create_copilot_action(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        try:
            row = await self._db.fetchrow(
                f"""
                INSERT INTO ai.copilot_actions
                    (tenant_id, conversation_id, message_id, action_type, target,
                     summary, arguments, expected_effect, evidence,
                     operation_hash, risk_class, status, requested_by,
                     requested_by_name, request_id, expires_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'proposed',
                        $12, $13, $14, $15)
                RETURNING {self._ACTION_COLUMNS}
                """,
                tenant_id,
                data.get("conversation_id"),
                data.get("message_id"),
                data["action_type"],
                data.get("target"),
                data["summary"],
                data.get("arguments") or {},
                data.get("expected_effect"),
                data.get("evidence") or [],
                data["operation_hash"],
                data.get("risk_class") or "controlled_mutation",
                data.get("requested_by"),
                data.get("requested_by_name"),
                data.get("request_id"),
                data.get("expires_at"),
            )
        except asyncpg.UniqueViolationError:
            return None
        return row

    async def get_copilot_action(
        self, tenant_id: int, action_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            SELECT {self._ACTION_COLUMNS}
            FROM ai.copilot_actions
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            action_id,
        )

    async def get_copilot_action_by_hash(
        self, tenant_id: int, operation_hash: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            SELECT {self._ACTION_COLUMNS}
            FROM ai.copilot_actions
            WHERE tenant_id = $1 AND operation_hash = $2
            """,
            tenant_id,
            operation_hash,
        )

    async def list_copilot_actions(
        self,
        tenant_id: int,
        *,
        status: str | None,
        conversation_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1"]
        args: list[Any] = [tenant_id]
        if status is not None:
            args.append(status)
            clauses.append(f"status = ${len(args)}")
        if conversation_id is not None:
            args.append(conversation_id)
            clauses.append(f"conversation_id = ${len(args)}")
        where = " AND ".join(clauses)
        rows = await self._db.fetch(
            f"""
            SELECT {self._ACTION_COLUMNS}
            FROM ai.copilot_actions
            WHERE {where}
            ORDER BY created_at DESC, id DESC
            LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}
            """,
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.copilot_actions WHERE {where}", *args
        )
        return rows, int(total or 0)

    async def decide_copilot_action(
        self,
        tenant_id: int,
        action_id: int,
        *,
        status: str,
        reviewer_actor_id: int | None,
        reviewer_name: str | None,
        reason: str | None,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.copilot_actions
            SET status = $3,
                approved_by = $4,
                approved_by_name = $5,
                decision_reason = $6,
                decided_at = now(),
                updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status = 'proposed'
            RETURNING {self._ACTION_COLUMNS}
            """,
            tenant_id,
            action_id,
            status,
            reviewer_actor_id,
            reviewer_name,
            reason,
        )

    async def claim_copilot_action_execution(
        self,
        tenant_id: int,
        action_id: int,
        *,
        executor_actor_id: int | None,
        executor_name: str | None,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.copilot_actions
            SET executed_by = $3,
                executed_by_name = $4,
                executed_at = now(),
                updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status = 'approved'
              AND executed_by IS NULL
            RETURNING {self._ACTION_COLUMNS}
            """,
            tenant_id,
            action_id,
            executor_actor_id,
            executor_name,
        )

    async def complete_copilot_action(
        self,
        tenant_id: int,
        action_id: int,
        *,
        status: str,
        result: dict[str, Any],
        error_class: str | None,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.copilot_actions
            SET status = $3,
                result = $4,
                error_class = $5,
                updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status = 'approved'
            RETURNING {self._ACTION_COLUMNS}
            """,
            tenant_id,
            action_id,
            status,
            result or {},
            error_class,
        )

    # --- Enterprise search: saved searches + history (Stage 4) ----------
    _SAVED_COLUMNS = (
        "id, tenant_id, actor_id, name, query, mode, filters, sort, metadata, "
        "created_at, updated_at"
    )
    _HISTORY_COLUMNS = (
        "id, tenant_id, actor_id, query, mode, filters, sort, result_count, "
        "fallback, created_at"
    )

    async def create_saved_search(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.search_saved
                (tenant_id, actor_id, name, query, mode, filters, sort, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING {self._SAVED_COLUMNS}
            """,
            tenant_id,
            data.get("actor_id"),
            data["name"],
            data["query"],
            data.get("mode", "hybrid"),
            data.get("filters", []),
            data.get("sort", "relevance"),
            data.get("metadata", {}),
        )
        assert row is not None
        return row

    async def list_saved_searches(
        self, tenant_id: int, actor_id: int | None, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            f"""
            SELECT {self._SAVED_COLUMNS}
            FROM ai.search_saved
            WHERE tenant_id = $1 AND actor_id IS NOT DISTINCT FROM $2
              AND deleted_at IS NULL
            ORDER BY updated_at DESC, id DESC
            LIMIT $3 OFFSET $4
            """,
            tenant_id,
            actor_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            """
            SELECT count(*) FROM ai.search_saved
            WHERE tenant_id = $1 AND actor_id IS NOT DISTINCT FROM $2
              AND deleted_at IS NULL
            """,
            tenant_id,
            actor_id,
        )
        return rows, int(total or 0)

    async def get_saved_search(
        self, tenant_id: int, saved_id: int, actor_id: int | None
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            SELECT {self._SAVED_COLUMNS}
            FROM ai.search_saved
            WHERE tenant_id = $1 AND id = $2 AND actor_id IS NOT DISTINCT FROM $3
              AND deleted_at IS NULL
            """,
            tenant_id,
            saved_id,
            actor_id,
        )

    async def delete_saved_search(
        self, tenant_id: int, saved_id: int, actor_id: int | None
    ) -> bool:
        row = await self._db.fetchval(
            """
            UPDATE ai.search_saved
            SET deleted_at = now(), updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND actor_id IS NOT DISTINCT FROM $3
              AND deleted_at IS NULL
            RETURNING id
            """,
            tenant_id,
            saved_id,
            actor_id,
        )
        return row is not None

    async def record_search_history(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.search_history
                (tenant_id, actor_id, query, mode, filters, sort, result_count, fallback)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING {self._HISTORY_COLUMNS}
            """,
            tenant_id,
            data.get("actor_id"),
            data["query"],
            data.get("mode", "hybrid"),
            data.get("filters", []),
            data.get("sort", "relevance"),
            data.get("result_count", 0),
            data.get("fallback", False),
        )
        assert row is not None
        return row

    async def list_search_history(
        self, tenant_id: int, actor_id: int | None, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            f"""
            SELECT {self._HISTORY_COLUMNS}
            FROM ai.search_history
            WHERE tenant_id = $1 AND actor_id IS NOT DISTINCT FROM $2
            ORDER BY created_at DESC, id DESC
            LIMIT $3 OFFSET $4
            """,
            tenant_id,
            actor_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            """
            SELECT count(*) FROM ai.search_history
            WHERE tenant_id = $1 AND actor_id IS NOT DISTINCT FROM $2
            """,
            tenant_id,
            actor_id,
        )
        return rows, int(total or 0)

    async def delete_search_history(
        self, tenant_id: int, history_id: int, actor_id: int | None
    ) -> bool:
        row = await self._db.fetchval(
            """
            DELETE FROM ai.search_history
            WHERE tenant_id = $1 AND id = $2 AND actor_id IS NOT DISTINCT FROM $3
            RETURNING id
            """,
            tenant_id,
            history_id,
            actor_id,
        )
        return row is not None

    async def clear_search_history(self, tenant_id: int, actor_id: int | None) -> int:
        rows = await self._db.fetch(
            """
            DELETE FROM ai.search_history
            WHERE tenant_id = $1 AND actor_id IS NOT DISTINCT FROM $2
            RETURNING id
            """,
            tenant_id,
            actor_id,
        )
        return len(rows)

    # --- Enterprise search: index health + reconciliation (Stage 4) -----
    # `missing` = indexed in pgvector but the search backend sync failed
    # (search_indexed_at IS NULL); `stale` = content changed, awaiting reindex.
    _PROBLEM_PREDICATE = (
        "(d.status IN ('stale', 'failed', 'pending', 'indexing') "
        "OR d.error_class IS NOT NULL "
        "OR (d.status = 'indexed' AND d.search_indexed_at IS NULL))"
    )

    async def search_index_stats(self, tenant_id: int) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            SELECT count(*) AS total,
                   count(*) FILTER (
                     WHERE status = 'indexed' AND search_indexed_at IS NOT NULL
                       AND error_class IS NULL) AS indexed,
                   count(*) FILTER (WHERE status IN ('pending', 'indexing')) AS pending,
                   count(*) FILTER (WHERE status = 'stale') AS stale,
                   count(*) FILTER (
                     WHERE status = 'indexed' AND search_indexed_at IS NULL) AS missing,
                   count(*) FILTER (
                     WHERE status = 'failed' OR error_class IS NOT NULL) AS failed,
                   max(COALESCE(search_indexed_at, indexed_at)) AS last_indexed_at
            FROM ai.documents
            WHERE tenant_id = $1
            """,
            tenant_id,
        )
        chunks = await self._db.fetchval(
            "SELECT count(*) FROM ai.document_chunks WHERE tenant_id = $1", tenant_id
        )
        embeddings = await self._db.fetchval(
            "SELECT count(*) FROM ai.embeddings WHERE tenant_id = $1", tenant_id
        )
        job_rows = await self._db.fetch(
            """
            SELECT status, count(*) AS n FROM ai.jobs
            WHERE tenant_id = $1 AND type = 'index'
            GROUP BY status
            """,
            tenant_id,
        )
        assert row is not None
        return {
            "documents_total": int(row["total"] or 0),
            "documents_indexed": int(row["indexed"] or 0),
            "documents_pending": int(row["pending"] or 0),
            "documents_stale": int(row["stale"] or 0),
            "documents_missing": int(row["missing"] or 0),
            "documents_failed": int(row["failed"] or 0),
            "chunks_total": int(chunks or 0),
            "embeddings_total": int(embeddings or 0),
            "jobs": {r["status"]: int(r["n"]) for r in job_rows},
            "last_indexed_at": row["last_indexed_at"],
        }

    async def search_index_status_by_source(
        self, tenant_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT s.id AS source_id, s.code AS source_code, s.status AS source_status,
                   count(d.id) AS documents_total,
                   count(*) FILTER (
                     WHERE d.status = 'indexed' AND d.search_indexed_at IS NOT NULL
                       AND d.error_class IS NULL) AS indexed,
                   count(*) FILTER (
                     WHERE d.status IN ('pending', 'indexing')) AS pending,
                   count(*) FILTER (WHERE d.status = 'stale') AS stale,
                   count(*) FILTER (
                     WHERE d.status = 'indexed' AND d.search_indexed_at IS NULL) AS missing,
                   count(*) FILTER (
                     WHERE d.status = 'failed' OR d.error_class IS NOT NULL) AS failed
            FROM ai.knowledge_sources s
            LEFT JOIN ai.documents d
              ON d.source_id = s.id AND d.tenant_id = s.tenant_id
            WHERE s.tenant_id = $1
            GROUP BY s.id, s.code, s.status
            ORDER BY s.id
            """,
            tenant_id,
        )

    async def list_problem_documents(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"""
            SELECT d.id AS document_id, d.source_id, d.external_id, d.title, d.status,
                   d.search_indexed_at, d.indexed_at, d.error_class,
                   s.code AS source_code
            FROM ai.documents d
            JOIN ai.knowledge_sources s ON s.id = d.source_id
            WHERE d.tenant_id = $1 AND {self._PROBLEM_PREDICATE}
            ORDER BY d.updated_at DESC, d.id DESC
            LIMIT $2
            """,
            tenant_id,
            limit,
        )

    async def sources_needing_reindex(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"""
            SELECT DISTINCT d.source_id, s.code AS source_code,
                   s.status AS source_status
            FROM ai.documents d
            JOIN ai.knowledge_sources s ON s.id = d.source_id
            WHERE d.tenant_id = $1 AND {self._PROBLEM_PREDICATE}
            ORDER BY d.source_id
            LIMIT $2
            """,
            tenant_id,
            limit,
        )

    # --- Enterprise search: duplicate/conflict findings (Stage 4/P5) -----
    _DUPLICATE_COLUMNS = (
        "id, tenant_id, dedupe_key, kind, match_type, confidence, document_a_id, "
        "document_b_id, evidence, status, note, reviewed_by, reviewed_at, "
        "created_at, updated_at"
    )

    async def list_documents_for_dedup(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT d.id, d.source_id, d.external_id, d.title, d.checksum, d.status,
                   d.classification, d.created_at, s.code AS source_code
            FROM ai.documents d
            JOIN ai.knowledge_sources s ON s.id = d.source_id
            WHERE d.tenant_id = $1
            ORDER BY d.id
            LIMIT $2
            """,
            tenant_id,
            limit,
        )

    async def upsert_duplicate_findings(
        self, tenant_id: int, findings: list[dict[str, Any]]
    ) -> dict[str, int]:
        created = updated = skipped = 0
        for finding in findings:
            row = await self._db.fetchrow(
                """
                INSERT INTO ai.search_duplicate_findings
                    (tenant_id, dedupe_key, kind, match_type, confidence,
                     document_a_id, document_b_id, evidence)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (tenant_id, dedupe_key) DO UPDATE
                SET kind = EXCLUDED.kind,
                    match_type = EXCLUDED.match_type,
                    confidence = EXCLUDED.confidence,
                    evidence = EXCLUDED.evidence,
                    updated_at = now()
                WHERE ai.search_duplicate_findings.status = 'open'
                RETURNING (xmax = 0) AS inserted
                """,
                tenant_id,
                finding["dedupe_key"],
                finding["kind"],
                finding["match_type"],
                finding["confidence"],
                finding["document_a_id"],
                finding["document_b_id"],
                finding.get("evidence", {}),
            )
            if row is None:
                skipped += 1
            elif row["inserted"]:
                created += 1
            else:
                updated += 1
        return {"total": len(findings), "created": created, "updated": updated, "skipped": skipped}

    async def list_duplicate_findings(
        self,
        tenant_id: int,
        *,
        status: str | None,
        kind: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            f"""
            SELECT {self._DUPLICATE_COLUMNS}
            FROM ai.search_duplicate_findings
            WHERE tenant_id = $1
              AND ($2::text IS NULL OR status = $2)
              AND ($3::text IS NULL OR kind = $3)
            ORDER BY confidence DESC, id DESC
            LIMIT $4 OFFSET $5
            """,
            tenant_id,
            status,
            kind,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            """
            SELECT count(*) FROM ai.search_duplicate_findings
            WHERE tenant_id = $1
              AND ($2::text IS NULL OR status = $2)
              AND ($3::text IS NULL OR kind = $3)
            """,
            tenant_id,
            status,
            kind,
        )
        return rows, int(total or 0)

    async def get_duplicate_finding(
        self, tenant_id: int, finding_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            SELECT {self._DUPLICATE_COLUMNS}
            FROM ai.search_duplicate_findings
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            finding_id,
        )

    async def update_duplicate_finding(
        self,
        tenant_id: int,
        finding_id: int,
        *,
        status: str,
        note: str | None,
        reviewed_by: int | None,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.search_duplicate_findings
            SET status = $3,
                note = COALESCE($4, note),
                reviewed_by = $5,
                reviewed_at = now(),
                updated_at = now()
            WHERE tenant_id = $1 AND id = $2
            RETURNING {self._DUPLICATE_COLUMNS}
            """,
            tenant_id,
            finding_id,
            status,
            note,
            reviewed_by,
        )

    # --- Stage 6: agent catalog and immutable versions ------------------

    _AGENT_COLUMNS = (
        "id, code, name, description, kind, category, owner, team, "
        "lifecycle_status, current_version_id, enabled, lock_version, "
        "duplicated_from_agent_id, suspended_at, archived_at, deleted_at, "
        "working_config, created_by, updated_by, created_at, updated_at"
    )
    _AGENT_VERSION_COLUMNS = (
        "id, agent_id, version, definition, status, validation, config_hash, "
        "published_at, published_by, created_by, lock_version, created_at"
    )
    _TOOL_COLUMNS = (
        "id, code, name, description, category, owner, enabled, lifecycle_status, "
        "current_version_id, lock_version, created_at, updated_at"
    )
    _TOOL_VERSION_COLUMNS = (
        "id, tool_id, version, definition, status, validation, config_hash, "
        "published_at, published_by, created_at"
    )
    _AGENT_EXECUTION_COLUMNS = (
        "tenant_id, id, request_id::text AS request_id, actor_id, agent_id, agent_version_id, "
        "parent_execution_id, operation, status, idempotency_key, plan, budgets, "
        "current_step, step_count, tool_call_count, model_call_count, input, "
        "input_snapshot, input_hash, output, output_snapshot, error, latency_ms, "
        "token_usage, cancel_requested_at, lease_owner, lease_expires_at, "
        "lease_generation, started_at, completed_at, state_version, created_at, "
        "schedule_id, schedule_run_key, memory_scope, delegation_depth, "
        "delegated_by_agent_id"
    )

    async def list_agent_catalog(
        self,
        tenant_id: int,
        *,
        query: str | None,
        lifecycle_status: str | None,
        category: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if lifecycle_status:
            args.append(lifecycle_status)
            clauses.append(f"lifecycle_status = ${len(args)}")
        if category:
            args.append(category)
            clauses.append(f"category = ${len(args)}")
        if query:
            args.append(f"%{query}%")
            clauses.append(
                f"(code ILIKE ${len(args)} OR name ILIKE ${len(args)} "
                f"OR COALESCE(description, '') ILIKE ${len(args)})"
            )
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"""SELECT {self._AGENT_COLUMNS} FROM ai.agents WHERE {where}
                ORDER BY name, code LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}""",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.agents WHERE {where}", *args
        )
        return items, int(total or 0)

    async def create_agent(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.agents
                (tenant_id, code, name, description, kind, category, owner, team,
                 lifecycle_status, enabled, config, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
            ON CONFLICT (tenant_id, code) DO NOTHING
            RETURNING {self._AGENT_COLUMNS}
            """,
            tenant_id,
            data["code"],
            data["name"],
            data.get("description"),
            data.get("kind", "workflow"),
            data.get("category"),
            data.get("owner"),
            data.get("team"),
            data.get("lifecycle_status", "draft"),
            bool(data.get("enabled", False)),
            data.get("config", {}),
            data.get("created_by"),
        )
        if row is None:
            raise ConflictError("agent code already exists")
        return row

    async def update_agent_draft(
        self,
        tenant_id: int,
        agent_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.agents
            SET name = COALESCE($4, name),
                description = COALESCE($5, description),
                category = COALESCE($6, category),
                owner = COALESCE($7, owner),
                team = COALESCE($8, team),
                kind = COALESCE($9, kind),
                updated_by = $10,
                lock_version = lock_version + 1,
                updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND lock_version = $3
              AND lifecycle_status IN ('draft', 'validating', 'published')
            RETURNING {self._AGENT_COLUMNS}
            """,
            tenant_id,
            agent_id,
            expected_lock,
            fields.get("name"),
            fields.get("description"),
            fields.get("category"),
            fields.get("owner"),
            fields.get("team"),
            fields.get("kind"),
            fields.get("updated_by"),
        )

    async def set_agent_lifecycle(
        self,
        tenant_id: int,
        agent_id: int,
        *,
        lifecycle_status: str,
        enabled: bool,
        updated_by: str | None,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.agents
            SET lifecycle_status = $3, enabled = $4, updated_by = $5,
                lock_version = lock_version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2
            RETURNING {self._AGENT_COLUMNS}
            """,
            tenant_id,
            agent_id,
            lifecycle_status,
            enabled,
            updated_by,
        )

    async def create_agent_version(
        self, tenant_id: int, agent_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            WITH next_version AS (
                SELECT COALESCE(MAX(v.version), 0) + 1 AS version
                FROM ai.agent_versions v
                JOIN ai.agents a ON a.id = v.agent_id
                WHERE v.agent_id = $2 AND a.tenant_id = $1
            )
            INSERT INTO ai.agent_versions
                (agent_id, version, definition, status, validation, config_hash,
                 created_by)
            SELECT $2, COALESCE($3::int, next_version.version),
                   $4::jsonb, $5::text, $6::jsonb, $7::text, $8::text
            FROM next_version
            RETURNING {self._AGENT_VERSION_COLUMNS}
            """,
            tenant_id,
            agent_id,
            data.get("version"),
            data.get("definition", {}),
            data.get("status", "draft"),
            data.get("validation", {}),
            data.get("config_hash"),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def update_agent_version(
        self,
        tenant_id: int,
        agent_id: int,
        version_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            UPDATE ai.agent_versions v
            SET definition = COALESCE($4, v.definition),
                validation = COALESCE($5, v.validation),
                status = COALESCE($6, v.status),
                lock_version = v.lock_version + 1
            FROM ai.agents a
            WHERE v.agent_id = a.id AND a.tenant_id = $1
              AND v.agent_id = $2 AND v.id = $3
              AND v.lock_version = $7
              AND v.status IN ('draft', 'validating')
            RETURNING v.id, v.agent_id, v.version, v.definition, v.status,
                      v.validation, v.config_hash, v.published_at,
                      v.published_by, v.created_by, v.lock_version, v.created_at
            """,
            tenant_id,
            agent_id,
            version_id,
            fields.get("definition"),
            fields.get("validation"),
            fields.get("status"),
            expected_lock,
        )

    async def get_agent_version(
        self, tenant_id: int, agent_id: int, version_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT v.id, v.agent_id, v.version, v.definition, v.status,
                   v.validation, v.config_hash, v.published_at, v.published_by,
                   v.created_by, v.lock_version, v.created_at
            FROM ai.agent_versions v
            JOIN ai.agents a ON a.id = v.agent_id
            WHERE a.tenant_id = $1 AND v.agent_id = $2 AND v.id = $3
            """,
            tenant_id,
            agent_id,
            version_id,
        )

    async def publish_agent_version(
        self,
        tenant_id: int,
        agent_id: int,
        version_id: int,
        *,
        fields: dict[str, Any],
        tool_links: list[dict[str, Any]],
        updated_by: str | None,
    ) -> dict[str, Any] | None:
        async with self._db.transaction() as tx:
            version = await tx.fetchrow(
                """
                UPDATE ai.agent_versions v
                SET status = 'published',
                    validation = $4,
                    config_hash = $5,
                    published_at = now(),
                    published_by = $6,
                    lock_version = v.lock_version + 1
                FROM ai.agents a
                WHERE v.agent_id = a.id AND a.tenant_id = $1
                  AND v.agent_id = $2 AND v.id = $3
                  AND v.status IN ('draft', 'validating')
                RETURNING v.id, v.agent_id, v.version, v.definition, v.status,
                          v.validation, v.config_hash, v.published_at,
                          v.published_by, v.created_by, v.lock_version, v.created_at
                """,
                tenant_id,
                agent_id,
                version_id,
                fields.get("validation", {}),
                fields.get("config_hash"),
                updated_by,
            )
            if version is None:
                return None
            await tx.execute(
                "DELETE FROM ai.agent_version_tools WHERE agent_version_id = $1",
                version_id,
            )
            for link in tool_links:
                await tx.execute(
                    """
                    INSERT INTO ai.agent_version_tools
                        (tenant_id, agent_version_id, tool_id, tool_version_id)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (agent_version_id, tool_id) DO NOTHING
                    """,
                    tenant_id,
                    version_id,
                    link["tool_id"],
                    link["tool_version_id"],
                )
            await tx.execute(
                """
                UPDATE ai.agents
                SET current_version_id = $3,
                    lifecycle_status = CASE
                      WHEN lifecycle_status = 'disabled' THEN 'disabled'
                      ELSE 'published' END,
                    enabled = CASE
                      WHEN lifecycle_status = 'disabled' THEN false
                      ELSE true END,
                    updated_by = $4,
                    lock_version = lock_version + 1, updated_at = now()
                WHERE tenant_id = $1 AND id = $2
                """,
                tenant_id,
                agent_id,
                version_id,
                updated_by,
            )
            return version

    async def set_agent_current_version(
        self, tenant_id: int, agent_id: int, version_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.agents a
            SET current_version_id = $3,
                lifecycle_status = CASE
                  WHEN a.lifecycle_status = 'disabled' THEN 'disabled'
                  ELSE 'published' END,
                enabled = CASE
                  WHEN a.lifecycle_status = 'disabled' THEN false
                  ELSE true END,
                updated_by = $4,
                lock_version = lock_version + 1, updated_at = now()
            WHERE a.tenant_id = $1 AND a.id = $2
              AND EXISTS (
                SELECT 1 FROM ai.agent_versions v
                WHERE v.id = $3 AND v.agent_id = a.id
                  AND v.status IN ('published', 'active')
              )
            RETURNING {self._AGENT_COLUMNS}
            """,
            tenant_id,
            agent_id,
            version_id,
            updated_by,
        )

    async def list_agent_version_tools(
        self, tenant_id: int, agent_version_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT id, tenant_id, agent_version_id, tool_id, tool_version_id, created_at
            FROM ai.agent_version_tools
            WHERE tenant_id = $1 AND agent_version_id = $2
            ORDER BY tool_id
            """,
            tenant_id,
            agent_version_id,
        )

    # --- Stage 6: persisted tool registry -------------------------------

    async def list_agent_tools(
        self,
        tenant_id: int,
        *,
        query: str | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1"]
        args: list[Any] = [tenant_id]
        if enabled is not None:
            args.append(enabled)
            clauses.append(f"enabled = ${len(args)}")
        if query:
            args.append(f"%{query}%")
            clauses.append(
                f"(code ILIKE ${len(args)} OR name ILIKE ${len(args)})"
            )
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._TOOL_COLUMNS} FROM ai.agent_tools WHERE {where} "
            f"ORDER BY code LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.agent_tools WHERE {where}", *args
        )
        return items, int(total or 0)

    async def create_agent_tool(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.agent_tools
                (tenant_id, code, name, description, category, owner, enabled,
                 lifecycle_status, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
            ON CONFLICT (tenant_id, code) DO NOTHING
            RETURNING {self._TOOL_COLUMNS}
            """,
            tenant_id,
            data["code"],
            data["name"],
            data.get("description"),
            data.get("category"),
            data.get("owner"),
            bool(data.get("enabled", True)),
            data.get("lifecycle_status", "draft"),
            data.get("created_by"),
        )
        if row is None:
            raise ConflictError("tool code already exists")
        return row

    async def get_agent_tool(
        self, tenant_id: int, tool_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._TOOL_COLUMNS} FROM ai.agent_tools "
            "WHERE tenant_id = $1 AND id = $2",
            tenant_id,
            tool_id,
        )

    async def update_agent_tool(
        self,
        tenant_id: int,
        tool_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.agent_tools
            SET name = COALESCE($4, name),
                description = COALESCE($5, description),
                category = COALESCE($6, category),
                owner = COALESCE($7, owner),
                enabled = COALESCE($8, enabled),
                updated_by = $9,
                lock_version = lock_version + 1,
                updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND lock_version = $3
            RETURNING {self._TOOL_COLUMNS}
            """,
            tenant_id,
            tool_id,
            expected_lock,
            fields.get("name"),
            fields.get("description"),
            fields.get("category"),
            fields.get("owner"),
            fields.get("enabled"),
            fields.get("updated_by"),
        )

    async def create_agent_tool_version(
        self, tenant_id: int, tool_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            WITH next_version AS (
                SELECT COALESCE(MAX(version), 0) + 1 AS version
                FROM ai.agent_tool_versions WHERE tool_id = $2
            )
            INSERT INTO ai.agent_tool_versions
                (tool_id, tenant_id, version, definition, status, validation,
                 config_hash, created_by)
            SELECT $2, $1, COALESCE($3, next_version.version), $4, $5, $6, $7, $8
            FROM next_version
            RETURNING {self._TOOL_VERSION_COLUMNS}
            """,
            tenant_id,
            tool_id,
            data.get("version"),
            data.get("definition", {}),
            data.get("status", "draft"),
            data.get("validation", {}),
            data.get("config_hash"),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def get_agent_tool_version(
        self, tenant_id: int, tool_id: int, version_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            SELECT {self._TOOL_VERSION_COLUMNS}
            FROM ai.agent_tool_versions
            WHERE tenant_id = $1 AND tool_id = $2 AND id = $3
            """,
            tenant_id,
            tool_id,
            version_id,
        )

    async def list_agent_tool_versions(
        self, tenant_id: int, tool_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"""
            SELECT {self._TOOL_VERSION_COLUMNS}
            FROM ai.agent_tool_versions
            WHERE tenant_id = $1 AND tool_id = $2
            ORDER BY version DESC
            """,
            tenant_id,
            tool_id,
        )

    async def update_agent_tool_version(
        self,
        tenant_id: int,
        tool_id: int,
        version_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.agent_tool_versions
            SET definition = COALESCE($4, definition),
                validation = COALESCE($5, validation),
                status = COALESCE($6, status),
                config_hash = COALESCE($7, config_hash)
            WHERE tenant_id = $1 AND tool_id = $2 AND id = $3
              AND status IN ('draft', 'validating')
            RETURNING {self._TOOL_VERSION_COLUMNS}
            """,
            tenant_id,
            tool_id,
            version_id,
            fields.get("definition"),
            fields.get("validation"),
            fields.get("status"),
            fields.get("config_hash"),
        )

    async def publish_agent_tool_version(
        self,
        tenant_id: int,
        tool_id: int,
        version_id: int,
        *,
        fields: dict[str, Any],
        updated_by: str | None,
    ) -> dict[str, Any] | None:
        async with self._db.transaction() as tx:
            version = await tx.fetchrow(
                f"""
                UPDATE ai.agent_tool_versions
                SET status = 'published', validation = $4, config_hash = $5,
                    published_at = now(), published_by = $6
                WHERE tenant_id = $1 AND tool_id = $2 AND id = $3
                  AND status IN ('draft', 'validating')
                RETURNING {self._TOOL_VERSION_COLUMNS}
                """,
                tenant_id,
                tool_id,
                version_id,
                fields.get("validation", {}),
                fields.get("config_hash"),
                updated_by,
            )
            if version is None:
                return None
            await tx.execute(
                """
                UPDATE ai.agent_tools
                SET current_version_id = $3, lifecycle_status = 'published',
                    enabled = true, updated_by = $4,
                    lock_version = lock_version + 1, updated_at = now()
                WHERE tenant_id = $1 AND id = $2
                """,
                tenant_id,
                tool_id,
                version_id,
                updated_by,
            )
            return version

    # --- Stage 6: durable agent execution ------------------------------

    async def create_agent_execution(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.executions
                (tenant_id, actor_id, agent_id, agent_version_id,
                 parent_execution_id, operation, status, idempotency_key, plan,
                 budgets, input, input_snapshot, input_hash, delegation_depth,
                 delegated_by_agent_id, schedule_id, schedule_run_key, memory_scope)
            VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17)
            ON CONFLICT (tenant_id, idempotency_key)
              WHERE idempotency_key IS NOT NULL DO NOTHING
            RETURNING {self._AGENT_EXECUTION_COLUMNS}
            """,
            tenant_id,
            data.get("actor_id"),
            data["agent_id"],
            data.get("agent_version_id"),
            data.get("parent_execution_id"),
            data.get("status", "queued"),
            data.get("idempotency_key"),
            data.get("plan", {}),
            data.get("budgets", {}),
            data.get("input", {}),
            data.get("input_snapshot"),
            data.get("input_hash"),
            int(data.get("delegation_depth") or 0),
            data.get("delegated_by_agent_id"),
            data.get("schedule_id"),
            data.get("schedule_run_key"),
            data.get("memory_scope"),
        )
        if row is None and data.get("idempotency_key"):
            row = await self._db.fetchrow(
                f"""
                SELECT {self._AGENT_EXECUTION_COLUMNS} FROM ai.executions
                WHERE tenant_id = $1 AND operation = 'agent'
                  AND idempotency_key = $2
                """,
                tenant_id,
                data["idempotency_key"],
            )
        if row is None:
            raise ConflictError("could not create agent execution")
        return row

    async def get_agent_execution(
        self, tenant_id: int, execution_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            SELECT {self._AGENT_EXECUTION_COLUMNS} FROM ai.executions
            WHERE tenant_id = $1 AND id = $2 AND operation = 'agent'
            """,
            tenant_id,
            execution_id,
        )

    async def list_agent_executions(
        self,
        tenant_id: int,
        *,
        state: str | None,
        agent_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "operation = 'agent'"]
        args: list[Any] = [tenant_id]
        if state:
            args.append(state)
            clauses.append(f"status = ${len(args)}")
        if agent_id is not None:
            args.append(agent_id)
            clauses.append(f"agent_id = ${len(args)}")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._AGENT_EXECUTION_COLUMNS} FROM ai.executions "
            f"WHERE {where} ORDER BY created_at DESC "
            f"LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.executions WHERE {where}", *args
        )
        return items, int(total or 0)

    async def update_agent_execution(
        self,
        tenant_id: int,
        execution_id: int,
        *,
        expected_state: str | None,
        fields: dict[str, Any],
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None:
        allowed = {
            "status",
            "plan",
            "budgets",
            "current_step",
            "step_count",
            "tool_call_count",
            "model_call_count",
            "output",
            "output_snapshot",
            "error",
            "latency_ms",
            "token_usage",
            "cancel_requested_at",
            "lease_owner",
            "lease_expires_at",
            "started_at",
            "completed_at",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return await self.get_agent_execution(tenant_id, execution_id)
        args: list[Any] = [tenant_id, execution_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        expected = ""
        if expected_state is not None:
            args.append(expected_state)
            expected = f" AND status = ${len(args)}"
        fence = ""
        if lease_owner is not None:
            args.append(lease_owner)
            fence += f" AND lease_owner = ${len(args)}"
        if lease_generation is not None:
            args.append(int(lease_generation))
            fence += f" AND lease_generation = ${len(args)}"
        return await self._db.fetchrow(
            f"""
            UPDATE ai.executions
            SET {", ".join(sets)}, state_version = state_version + 1
            WHERE tenant_id = $1 AND id = $2 AND operation = 'agent'{expected}{fence}
            RETURNING {self._AGENT_EXECUTION_COLUMNS}
            """,
            *args,
        )

    async def claim_agent_execution(
        self, *, worker_id: str, lease_seconds: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.executions
            SET status = 'running', lease_owner = $1,
                lease_expires_at = now() + ($2 || ' seconds')::interval,
                lease_generation = lease_generation + 1,
                started_at = COALESCE(started_at, now()),
                state_version = state_version + 1
            WHERE id = (
                SELECT id FROM ai.executions
                WHERE operation = 'agent'
                  AND (status = 'queued'
                       OR (status = 'running' AND lease_expires_at < now()))
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING {self._AGENT_EXECUTION_COLUMNS}
            """,
            worker_id,
            str(int(lease_seconds)),
        )

    async def renew_agent_execution_lease(
        self,
        tenant_id: int,
        execution_id: int,
        *,
        worker_id: str,
        lease_generation: int,
        lease_seconds: int,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.executions
            SET lease_expires_at = now() + ($5 || ' seconds')::interval
            WHERE tenant_id = $1 AND id = $2 AND operation = 'agent'
              AND lease_owner = $3 AND lease_generation = $4
              AND status IN ('running', 'cancel_requested')
            RETURNING {self._AGENT_EXECUTION_COLUMNS}
            """,
            tenant_id,
            execution_id,
            worker_id,
            int(lease_generation),
            str(int(lease_seconds)),
        )

    async def start_agent_execution(
        self,
        tenant_id: int,
        execution_id: int,
        *,
        worker_id: str,
        lease_seconds: int,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.executions
            SET status = 'running', lease_owner = $3,
                lease_expires_at = now() + ($4 || ' seconds')::interval,
                lease_generation = lease_generation + 1,
                started_at = COALESCE(started_at, now()),
                state_version = state_version + 1
            WHERE tenant_id = $1 AND id = $2 AND operation = 'agent'
              AND status = 'queued'
            RETURNING {self._AGENT_EXECUTION_COLUMNS}
            """,
            tenant_id,
            execution_id,
            worker_id,
            str(int(lease_seconds)),
        )

    async def upsert_execution_step(
        self,
        tenant_id: int,
        execution_id: int,
        data: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None:
        args: list[Any] = [
            tenant_id,
            execution_id,
            data["step_key"],
            data["sequence"],
            data.get("tool_code"),
            data.get("tool_version_id"),
            data.get("status"),
            data.get("attempts"),
            data.get("max_attempts"),
            data.get("input_summary"),
            data.get("output_summary"),
            data.get("error_class"),
            data.get("error_message"),
            data.get("started_at"),
            data.get("finished_at"),
        ]
        fence = ""
        if lease_owner is not None:
            args.append(lease_owner)
            fence += f" AND e.lease_owner = ${len(args)}"
        if lease_generation is not None:
            args.append(int(lease_generation))
            fence += f" AND e.lease_generation = ${len(args)}"
        guard = (
            "WHERE EXISTS (SELECT 1 FROM ai.executions e "
            "WHERE e.tenant_id = $1 AND e.id = $2 AND e.operation = 'agent'"
            f"{fence})"
        )
        return await self._db.fetchrow(
            f"""
            INSERT INTO ai.agent_execution_steps
                (tenant_id, execution_id, step_key, sequence, tool_code,
                 tool_version_id, status, attempts, max_attempts, input_summary,
                 output_summary, error_class, error_message, started_at, finished_at)
            SELECT $1, $2, $3, $4, $5, $6,
                   COALESCE($7, 'pending'), COALESCE($8, 0),
                   COALESCE($9, 3), COALESCE($10, '{{}}'::jsonb),
                   COALESCE($11, '{{}}'::jsonb), $12, $13, $14, $15
            {guard}
            ON CONFLICT (execution_id, step_key) DO UPDATE
            SET status = COALESCE(EXCLUDED.status, ai.agent_execution_steps.status),
                attempts = COALESCE(EXCLUDED.attempts, ai.agent_execution_steps.attempts),
                output_summary = COALESCE(EXCLUDED.output_summary,
                                          ai.agent_execution_steps.output_summary),
                error_class = EXCLUDED.error_class,
                error_message = EXCLUDED.error_message,
                started_at = COALESCE(EXCLUDED.started_at,
                                      ai.agent_execution_steps.started_at),
                finished_at = EXCLUDED.finished_at
            {guard}
            RETURNING id, tenant_id, execution_id, step_key, sequence, tool_code,
                      tool_version_id, status, attempts, max_attempts,
                      input_summary, output_summary, error_class, error_message,
                      started_at, finished_at, created_at
            """,
            *args,
        )

    async def list_execution_steps(
        self, tenant_id: int, execution_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT id, step_key, sequence, tool_code, tool_version_id, status,
                   attempts, max_attempts, input_summary, output_summary,
                   error_class, error_message, started_at, finished_at, created_at
            FROM ai.agent_execution_steps
            WHERE tenant_id = $1 AND execution_id = $2
            ORDER BY sequence
            """,
            tenant_id,
            execution_id,
        )

    async def record_tool_invocation(
        self,
        tenant_id: int,
        execution_id: int,
        data: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None:
        args: list[Any] = [
            tenant_id,
            execution_id,
            data.get("step_id"),
            data["tool_code"],
            data.get("tool_version_id"),
            data.get("status"),
            data.get("attempt"),
            data.get("idempotency_key"),
            data.get("outcome_certainty"),
            data.get("arguments_hash"),
            data.get("arguments_summary"),
        ]
        fence = ""
        if lease_owner is not None:
            args.append(lease_owner)
            fence += f" AND e.lease_owner = ${len(args)}"
        if lease_generation is not None:
            args.append(int(lease_generation))
            fence += f" AND e.lease_generation = ${len(args)}"
        guard = (
            "WHERE EXISTS (SELECT 1 FROM ai.executions e "
            "WHERE e.tenant_id = $1 AND e.id = $2 AND e.operation = 'agent'"
            f"{fence})"
        )
        return await self._db.fetchrow(
            f"""
            INSERT INTO ai.agent_tool_invocations
                (tenant_id, execution_id, step_id, tool_code, tool_version_id,
                 status, attempt, idempotency_key, outcome_certainty,
                 arguments_hash, arguments_summary)
            SELECT $1, $2, $3, $4, $5, COALESCE($6, 'running'),
                   COALESCE($7, 1), $8, COALESCE($9, 'certain'), $10,
                   COALESCE($11, '{{}}'::jsonb)
            {guard}
            RETURNING id, tenant_id, execution_id, step_id, tool_code,
                      tool_version_id, status, attempt, idempotency_key,
                      outcome_certainty, arguments_hash, arguments_summary,
                      result, result_summary, error_class, error_message,
                      started_at, finished_at
            """,
            *args,
        )

    async def list_tool_invocations(
        self, tenant_id: int, execution_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT id, execution_id, step_id, tool_code, tool_version_id, status,
                   attempt, idempotency_key, outcome_certainty, arguments_hash,
                   arguments_summary, result, result_summary, error_class,
                   error_message, started_at, finished_at
            FROM ai.agent_tool_invocations
            WHERE tenant_id = $1 AND execution_id = $2
            ORDER BY started_at, id
            """,
            tenant_id,
            execution_id,
        )

    async def latest_tool_invocation(
        self, tenant_id: int, execution_id: int, step_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, execution_id, step_id, tool_code, tool_version_id, status,
                   attempt, idempotency_key, outcome_certainty, arguments_hash,
                   arguments_summary, result, result_summary, error_class,
                   error_message, started_at, finished_at
            FROM ai.agent_tool_invocations
            WHERE tenant_id = $1 AND execution_id = $2 AND step_id = $3
            ORDER BY id DESC LIMIT 1
            """,
            tenant_id,
            execution_id,
            step_id,
        )

    async def update_tool_invocation(
        self,
        tenant_id: int,
        invocation_id: int,
        fields: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None:
        allowed = {
            "status",
            "result",
            "result_summary",
            "error_class",
            "error_message",
            "outcome_certainty",
            "finished_at",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return None
        args: list[Any] = [tenant_id, invocation_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        fence = ""
        if lease_owner is not None:
            args.append(lease_owner)
            fence += f" AND e.lease_owner = ${len(args)}"
        if lease_generation is not None:
            args.append(int(lease_generation))
            fence += f" AND e.lease_generation = ${len(args)}"
        return await self._db.fetchrow(
            f"""
            UPDATE ai.agent_tool_invocations i
            SET {", ".join(sets)}
            FROM ai.executions e
            WHERE i.tenant_id = $1 AND i.id = $2
              AND e.tenant_id = i.tenant_id AND e.id = i.execution_id
              AND e.operation = 'agent'{fence}
            RETURNING i.id, i.tenant_id, i.execution_id, i.step_id, i.tool_code,
                      i.tool_version_id, i.status, i.attempt, i.idempotency_key,
                      i.outcome_certainty, i.arguments_hash, i.arguments_summary,
                      i.result, i.result_summary, i.error_class, i.error_message,
                      i.started_at, i.finished_at
            """,
            *args,
        )

    async def add_execution_checkpoint(
        self,
        tenant_id: int,
        execution_id: int,
        data: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None:
        sequence = int(data.get("sequence") or 0)
        args: list[Any] = [tenant_id, execution_id, sequence, data.get("state", {})]
        fence = ""
        if lease_owner is not None:
            args.append(lease_owner)
            fence += f" AND e.lease_owner = ${len(args)}"
        if lease_generation is not None:
            args.append(int(lease_generation))
            fence += f" AND e.lease_generation = ${len(args)}"
        return await self._db.fetchrow(
            f"""
            WITH next_sequence AS (
                SELECT CASE WHEN $3 > 0 THEN $3
                            ELSE COALESCE(MAX(sequence), 0) + 1 END AS sequence,
                       (SELECT count(*) FROM ai.executions e
                        WHERE e.tenant_id = $1 AND e.id = $2
                          AND e.operation = 'agent'{fence}) AS allowed
                FROM ai.agent_checkpoints
                WHERE execution_id = $2
            )
            INSERT INTO ai.agent_checkpoints
                (tenant_id, execution_id, sequence, state)
            SELECT $1, $2, sequence, $4
            FROM next_sequence
            WHERE allowed > 0
            RETURNING id, tenant_id, execution_id, sequence, state, created_at
            """,
            *args,
        )

    async def latest_execution_checkpoint(
        self, tenant_id: int, execution_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, tenant_id, execution_id, sequence, state, created_at
            FROM ai.agent_checkpoints
            WHERE tenant_id = $1 AND execution_id = $2
            ORDER BY sequence DESC LIMIT 1
            """,
            tenant_id,
            execution_id,
        )

    async def list_agent_artifacts(
        self, tenant_id: int, *, execution_id: int | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1"]
        args: list[Any] = [tenant_id]
        if execution_id is not None:
            args.append(execution_id)
            clauses.append(f"execution_id = ${len(args)}")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            "SELECT id, tenant_id, execution_id, artifact_type, title, content, "
            f"created_by, created_at FROM ai.agent_artifacts WHERE {where} "
            f"ORDER BY created_at DESC LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.agent_artifacts WHERE {where}", *args
        )
        return items, int(total or 0)

    async def create_agent_artifact(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.agent_artifacts
                (tenant_id, execution_id, artifact_type, title, content, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, tenant_id, execution_id, artifact_type, title, content,
                      created_by, created_at
            """,
            tenant_id,
            data.get("execution_id"),
            data["artifact_type"],
            data["title"],
            data["content"],
            data.get("created_by"),
        )
        assert row is not None
        return row

    # --- Stage 6: approvals --------------------------------------------

    async def create_agent_approval(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        await self._db.execute(
            """
            UPDATE ai.agent_approvals
            SET status = 'expired', decided_at = COALESCE(decided_at, now())
            WHERE tenant_id = $1 AND execution_id = $2
              AND operation_hash = $3 AND consumed_at IS NULL
              AND status IN ('pending', 'approved') AND expires_at <= now()
            """,
            tenant_id,
            data["execution_id"],
            data["operation_hash"],
        )
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.agent_approvals
                (tenant_id, execution_id, step_id, step_key, tool_code,
                 tool_version_id, operation_hash, target, input_summary,
                 expected_effect, evidence, risk_class, requested_by,
                 requested_by_name, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                    $14, $15)
            ON CONFLICT (tenant_id, execution_id, operation_hash)
              WHERE consumed_at IS NULL AND status IN ('pending', 'approved')
              DO NOTHING
            RETURNING id, tenant_id, execution_id, step_id, step_key, tool_code,
                      tool_version_id, operation_hash, target, input_summary,
                      expected_effect, evidence, risk_class, requested_by,
                      requested_by_name, status, expires_at, reviewer_actor_id,
                      reviewer_name, decision_reason, decided_at, consumed_at,
                      consumed_by, created_at
            """,
            tenant_id,
            data["execution_id"],
            data.get("step_id"),
            data["step_key"],
            data["tool_code"],
            data.get("tool_version_id"),
            data["operation_hash"],
            data.get("target"),
            data.get("input_summary", {}),
            data.get("expected_effect"),
            data.get("evidence", []),
            data["risk_class"],
            data.get("requested_by"),
            data.get("requested_by_name"),
            data["expires_at"],
        )
        if row is None:
            row = await self._db.fetchrow(
                """
                SELECT id, tenant_id, execution_id, step_id, step_key, tool_code,
                       tool_version_id, operation_hash, target, input_summary,
                       expected_effect, evidence, risk_class, requested_by,
                       requested_by_name, status, expires_at, reviewer_actor_id,
                       reviewer_name, decision_reason, decided_at, consumed_at,
                       consumed_by, created_at
                FROM ai.agent_approvals
                WHERE tenant_id = $1 AND execution_id = $2
                  AND operation_hash = $3 AND consumed_at IS NULL
                  AND status IN ('pending', 'approved')
                ORDER BY created_at DESC LIMIT 1
                """,
                tenant_id,
                data["execution_id"],
                data["operation_hash"],
            )
        if row is None:
            raise ConflictError("could not create approval request")
        return row

    async def get_agent_approval(
        self, tenant_id: int, approval_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, tenant_id, execution_id, step_id, step_key, tool_code,
                   tool_version_id, operation_hash, target, input_summary,
                   expected_effect, evidence, risk_class, requested_by,
                   requested_by_name, status, expires_at, reviewer_actor_id,
                   reviewer_name, decision_reason, decided_at, consumed_at, consumed_by,
                   created_at
            FROM ai.agent_approvals
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            approval_id,
        )

    async def find_pending_approval(
        self, tenant_id: int, execution_id: int, operation_hash: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, tenant_id, execution_id, step_id, step_key, tool_code,
                   tool_version_id, operation_hash, target, input_summary,
                   expected_effect, evidence, risk_class, requested_by,
                   requested_by_name, status, expires_at, reviewer_actor_id,
                   reviewer_name, decision_reason, decided_at, consumed_at, consumed_by,
                   created_at
            FROM ai.agent_approvals
            WHERE tenant_id = $1 AND execution_id = $2
              AND operation_hash = $3 AND status = 'pending'
              AND consumed_at IS NULL AND expires_at > now()
            """,
            tenant_id,
            execution_id,
            operation_hash,
        )

    async def list_agent_approvals(
        self,
        tenant_id: int,
        *,
        status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1"]
        args: list[Any] = [tenant_id]
        if status:
            args.append(status)
            clauses.append(f"status = ${len(args)}")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"""
            SELECT id, tenant_id, execution_id, step_id, step_key, tool_code,
                   tool_version_id, operation_hash, target, input_summary,
                   expected_effect, evidence, risk_class, requested_by,
                   requested_by_name, status, expires_at, reviewer_actor_id,
                   reviewer_name, decision_reason, decided_at, consumed_at, consumed_by,
                   created_at
            FROM ai.agent_approvals WHERE {where}
            ORDER BY created_at DESC
            LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}
            """,
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.agent_approvals WHERE {where}", *args
        )
        return items, int(total or 0)

    async def decide_agent_approval(
        self,
        tenant_id: int,
        approval_id: int,
        *,
        status: str,
        reviewer_actor_id: int | None,
        reviewer_name: str | None,
        reason: str | None,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            UPDATE ai.agent_approvals
            SET status = $3, reviewer_actor_id = $4, reviewer_name = $5,
                decision_reason = $6, decided_at = now()
            WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
              AND consumed_at IS NULL AND expires_at > now()
            RETURNING id, tenant_id, execution_id, step_id, step_key, tool_code,
                      tool_version_id, operation_hash, target, input_summary,
                      expected_effect, evidence, risk_class, requested_by,
                      requested_by_name, status, expires_at, reviewer_actor_id,
                      reviewer_name, decision_reason, decided_at, consumed_at,
                      consumed_by, created_at
            """,
            tenant_id,
            approval_id,
            status,
            reviewer_actor_id,
            reviewer_name,
            reason,
        )

    async def consume_agent_approval(
        self,
        tenant_id: int,
        approval_id: int,
        *,
        execution_id: int,
        operation_hash: str,
        consumed_by: str,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            UPDATE ai.agent_approvals
            SET consumed_at = now(), consumed_by = $5
            WHERE tenant_id = $1 AND id = $2 AND execution_id = $3
              AND operation_hash = $4 AND status = 'approved'
              AND consumed_at IS NULL AND expires_at > now()
            RETURNING id, tenant_id, execution_id, step_id, step_key, tool_code,
                      tool_version_id, operation_hash, target, input_summary,
                      expected_effect, evidence, risk_class, requested_by,
                      requested_by_name, status, expires_at, reviewer_actor_id,
                      reviewer_name, decision_reason, decided_at, consumed_at,
                      consumed_by, created_at
            """,
            tenant_id,
            approval_id,
            execution_id,
            operation_hash,
            consumed_by,
        )

    # --- Stage 6 completion: templates, memory, schedules, delegation ---

    _TEMPLATE_COLUMNS = (
        "id, tenant_id, code, name, description, category, use_case, definition, "
        "system_tools, enabled, created_by, created_at, updated_at"
    )
    _MEMORY_COLUMNS = (
        "id, tenant_id, agent_id, scope, execution_id, conversation_id, "
        "owner_actor_id, owner_username, memory_key, content, metadata, "
        "classification, expires_at, created_at, updated_at"
    )
    _SCHEDULE_COLUMNS = (
        "id, tenant_id, agent_id, name, enabled, schedule_kind, cron, run_at, "
        "timezone, input, input_text, next_run_at, last_run_at, last_run_key, "
        "last_execution_id, last_status, failure_count, created_by, created_at, "
        "updated_at"
    )
    _DELEGATION_COLUMNS = (
        "id, tenant_id, parent_execution_id, child_execution_id, parent_agent_id, "
        "child_agent_id, step_key, mode, status, depth, input_summary, "
        "result_summary, error_class, created_at, updated_at"
    )

    async def list_agent_templates(
        self,
        tenant_id: int,
        *,
        category: str | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1"]
        args: list[Any] = [tenant_id]
        if category:
            args.append(category)
            clauses.append(f"category = ${len(args)}")
        if enabled is not None:
            args.append(enabled)
            clauses.append(f"enabled = ${len(args)}")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._TEMPLATE_COLUMNS} FROM ai.agent_templates "
            f"WHERE {where} ORDER BY name LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.agent_templates WHERE {where}", *args
        )
        return items, int(total or 0)

    async def get_agent_template(
        self, tenant_id: int, template_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._TEMPLATE_COLUMNS} FROM ai.agent_templates "
            "WHERE tenant_id = $1 AND id = $2",
            tenant_id,
            template_id,
        )

    async def upsert_agent_template(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.agent_templates
                (tenant_id, code, name, description, category, use_case,
                 definition, system_tools, enabled, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (tenant_id, code) DO UPDATE
              SET name = EXCLUDED.name,
                  description = EXCLUDED.description,
                  category = EXCLUDED.category,
                  use_case = EXCLUDED.use_case,
                  definition = EXCLUDED.definition,
                  system_tools = EXCLUDED.system_tools,
                  enabled = EXCLUDED.enabled,
                  updated_at = now()
            RETURNING {self._TEMPLATE_COLUMNS}
            """,
            tenant_id,
            data["code"],
            data["name"],
            data.get("description"),
            data.get("category"),
            data.get("use_case"),
            data.get("definition", {}),
            data.get("system_tools", []),
            bool(data.get("enabled", True)),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def list_agent_memory(
        self,
        tenant_id: int,
        *,
        agent_id: int | None,
        scope: str | None,
        execution_id: int | None,
        conversation_id: int | None,
        owner_actor_id: int | None,
        include_expired: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1"]
        args: list[Any] = [tenant_id]
        for column, value in (
            ("agent_id", agent_id),
            ("scope", scope),
            ("execution_id", execution_id),
            ("conversation_id", conversation_id),
            ("owner_actor_id", owner_actor_id),
        ):
            if value is not None:
                args.append(value)
                clauses.append(f"{column} = ${len(args)}")
        if not include_expired:
            clauses.append("(expires_at IS NULL OR expires_at > now())")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._MEMORY_COLUMNS} FROM ai.agent_memory_entries "
            f"WHERE {where} ORDER BY updated_at DESC "
            f"LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.agent_memory_entries WHERE {where}", *args
        )
        return items, int(total or 0)

    async def get_agent_memory(
        self, tenant_id: int, entry_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._MEMORY_COLUMNS} FROM ai.agent_memory_entries "
            "WHERE tenant_id = $1 AND id = $2",
            tenant_id,
            entry_id,
        )

    async def upsert_agent_memory(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.agent_memory_entries
                (tenant_id, agent_id, scope, execution_id, conversation_id,
                 owner_actor_id, owner_username, memory_key, content, metadata,
                 classification, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (tenant_id, agent_id, scope, owner_actor_id, memory_key)
            DO UPDATE SET content = EXCLUDED.content,
                          metadata = EXCLUDED.metadata,
                          classification = EXCLUDED.classification,
                          expires_at = EXCLUDED.expires_at,
                          execution_id = EXCLUDED.execution_id,
                          conversation_id = EXCLUDED.conversation_id,
                          updated_at = now()
            RETURNING {self._MEMORY_COLUMNS}
            """,
            tenant_id,
            data.get("agent_id"),
            data.get("scope", "agent"),
            data.get("execution_id"),
            data.get("conversation_id"),
            data.get("owner_actor_id"),
            data.get("owner_username"),
            data["memory_key"],
            data["content"],
            data.get("metadata", {}),
            data.get("classification", "internal"),
            data.get("expires_at"),
        )
        assert row is not None
        return row

    async def delete_agent_memory(
        self, tenant_id: int, entry_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"DELETE FROM ai.agent_memory_entries WHERE tenant_id = $1 AND id = $2 "
            f"RETURNING {self._MEMORY_COLUMNS}",
            tenant_id,
            entry_id,
        )

    async def purge_expired_agent_memory(self, tenant_id: int) -> int:
        deleted = await self._db.fetchval(
            "WITH gone AS (DELETE FROM ai.agent_memory_entries "
            "WHERE tenant_id = $1 AND expires_at IS NOT NULL AND expires_at <= now() "
            "RETURNING 1) SELECT count(*) FROM gone",
            tenant_id,
        )
        return int(deleted or 0)

    async def create_agent_schedule(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.agent_schedules
                (tenant_id, agent_id, name, enabled, schedule_kind, cron, run_at,
                 timezone, input, input_text, next_run_at, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING {self._SCHEDULE_COLUMNS}
            """,
            tenant_id,
            data["agent_id"],
            data["name"],
            bool(data.get("enabled", True)),
            data.get("schedule_kind", "once"),
            data.get("cron"),
            data.get("run_at"),
            data.get("timezone", "UTC"),
            data.get("input", {}),
            data.get("input_text"),
            data.get("next_run_at"),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def get_agent_schedule(
        self, tenant_id: int, schedule_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._SCHEDULE_COLUMNS} FROM ai.agent_schedules "
            "WHERE tenant_id = $1 AND id = $2",
            tenant_id,
            schedule_id,
        )

    async def list_agent_schedules(
        self,
        tenant_id: int,
        *,
        agent_id: int | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1"]
        args: list[Any] = [tenant_id]
        if agent_id is not None:
            args.append(agent_id)
            clauses.append(f"agent_id = ${len(args)}")
        if enabled is not None:
            args.append(enabled)
            clauses.append(f"enabled = ${len(args)}")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._SCHEDULE_COLUMNS} FROM ai.agent_schedules "
            f"WHERE {where} ORDER BY created_at DESC "
            f"LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.agent_schedules WHERE {where}", *args
        )
        return items, int(total or 0)

    async def update_agent_schedule(
        self, tenant_id: int, schedule_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "name",
            "enabled",
            "cron",
            "run_at",
            "timezone",
            "input",
            "input_text",
            "next_run_at",
            "last_run_at",
            "last_run_key",
            "last_execution_id",
            "last_status",
            "failure_count",
            "schedule_kind",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return await self.get_agent_schedule(tenant_id, schedule_id)
        args: list[Any] = [tenant_id, schedule_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        return await self._db.fetchrow(
            f"UPDATE ai.agent_schedules SET {', '.join(sets)}, updated_at = now() "
            f"WHERE tenant_id = $1 AND id = $2 RETURNING {self._SCHEDULE_COLUMNS}",
            *args,
        )

    async def delete_agent_schedule(self, tenant_id: int, schedule_id: int) -> bool:
        deleted = await self._db.fetchval(
            "WITH gone AS (DELETE FROM ai.agent_schedules "
            "WHERE tenant_id = $1 AND id = $2 RETURNING 1) SELECT count(*) FROM gone",
            tenant_id,
            schedule_id,
        )
        return bool(deleted)

    async def claim_due_schedules(
        self, *, limit: int, now: Any
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"""
            WITH due AS (
                SELECT s.id FROM ai.agent_schedules s
                WHERE s.enabled
                  AND s.next_run_at IS NOT NULL
                  AND s.next_run_at <= $1
                ORDER BY s.next_run_at
                FOR UPDATE SKIP LOCKED
                LIMIT $2
            )
            UPDATE ai.agent_schedules s
            SET last_run_key = to_char(
                  s.next_run_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US'
                ),
                last_run_at = s.next_run_at,
                next_run_at = NULL,
                updated_at = now()
            FROM due
            WHERE s.id = due.id
            RETURNING {", ".join(f"s.{c.strip()}" for c in self._SCHEDULE_COLUMNS.split(","))}
            """,
            now,
            int(limit),
        )

    async def create_agent_delegation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.agent_delegations
                (tenant_id, parent_execution_id, child_execution_id,
                 parent_agent_id, child_agent_id, step_key, mode, status, depth,
                 input_summary, result_summary, error_class)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (parent_execution_id, step_key) DO UPDATE
              SET child_execution_id = COALESCE(
                    ai.agent_delegations.child_execution_id,
                    EXCLUDED.child_execution_id),
                  status = EXCLUDED.status,
                  result_summary = EXCLUDED.result_summary,
                  error_class = EXCLUDED.error_class,
                  updated_at = now()
            RETURNING {self._DELEGATION_COLUMNS}
            """,
            tenant_id,
            data["parent_execution_id"],
            data.get("child_execution_id"),
            data.get("parent_agent_id"),
            data["child_agent_id"],
            data["step_key"],
            data.get("mode", "sequential"),
            data.get("status", "pending"),
            int(data.get("depth", 1)),
            data.get("input_summary", {}),
            data.get("result_summary", {}),
            data.get("error_class"),
        )
        assert row is not None
        return row

    async def update_agent_delegation(
        self, tenant_id: int, delegation_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "child_execution_id",
            "status",
            "result_summary",
            "error_class",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return await self.get_agent_delegation(tenant_id, delegation_id)
        args: list[Any] = [tenant_id, delegation_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        return await self._db.fetchrow(
            f"UPDATE ai.agent_delegations SET {', '.join(sets)}, updated_at = now() "
            f"WHERE tenant_id = $1 AND id = $2 RETURNING {self._DELEGATION_COLUMNS}",
            *args,
        )

    async def get_agent_delegation(
        self, tenant_id: int, delegation_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._DELEGATION_COLUMNS} FROM ai.agent_delegations "
            "WHERE tenant_id = $1 AND id = $2",
            tenant_id,
            delegation_id,
        )

    async def list_agent_delegations(
        self, tenant_id: int, parent_execution_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"SELECT {self._DELEGATION_COLUMNS} FROM ai.agent_delegations "
            "WHERE tenant_id = $1 AND parent_execution_id = $2 "
            "ORDER BY created_at, id",
            tenant_id,
            parent_execution_id,
        )

    async def agent_execution_stats(
        self, tenant_id: int, *, agent_id: int | None
    ) -> dict[str, Any]:
        args: list[Any] = [tenant_id]
        clause = "tenant_id = $1 AND operation = 'agent'"
        if agent_id is not None:
            args.append(agent_id)
            clause += f" AND agent_id = ${len(args)}"
        row = await self._db.fetchrow(
            f"""
            SELECT count(*) AS total,
                   count(*) FILTER (WHERE status IN ('completed', 'succeeded')) AS succeeded,
                   count(*) FILTER (WHERE status = 'failed') AS failed,
                   count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
                   count(*) FILTER (WHERE status = 'waiting_approval') AS waiting_approval,
                   count(*) FILTER (WHERE status IN ('queued', 'running')) AS active,
                   avg(latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS avg_latency_ms,
                   COALESCE(sum((token_usage->>'total_tokens')::bigint), 0) AS total_tokens
            FROM ai.executions WHERE {clause}
            """,
            *args,
        )
        out = dict(row or {})
        return {
            "total": int(out.get("total") or 0),
            "succeeded": int(out.get("succeeded") or 0),
            "failed": int(out.get("failed") or 0),
            "cancelled": int(out.get("cancelled") or 0),
            "waiting_approval": int(out.get("waiting_approval") or 0),
            "active": int(out.get("active") or 0),
            "avg_latency_ms": float(out["avg_latency_ms"])
            if out.get("avg_latency_ms") is not None
            else None,
            "total_tokens": int(out.get("total_tokens") or 0),
        }

    async def delete_agent(
        self, tenant_id: int, agent_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.agents
            SET lifecycle_status = 'archived', enabled = false,
                archived_at = COALESCE(archived_at, now()),
                deleted_at = now(), updated_by = $3,
                lock_version = lock_version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING {self._AGENT_COLUMNS}
            """,
            tenant_id,
            agent_id,
            updated_by,
        )

    async def update_agent_working_config(
        self,
        tenant_id: int,
        agent_id: int,
        working_config: dict[str, Any],
        *,
        updated_by: str | None,
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.agents
            SET working_config = $3, updated_by = $4,
                lock_version = lock_version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING {self._AGENT_COLUMNS}
            """,
            tenant_id,
            agent_id,
            working_config,
            updated_by,
        )

    # --- Knowledge graph (Stage 7) --------------------------------------
    _ENTITY_COLUMNS = (
        "id, tenant_id, entity_type, stable_key, external_id, source_system, "
        "source_ref, name, description, classification, acl, lifecycle_status, "
        "confidence, properties, metadata, valid_from, valid_to, version, "
        "created_by, updated_by, created_at, updated_at, deleted_at"
    )
    _RELATIONSHIP_COLUMNS = (
        "id, tenant_id, relationship_type, source_entity_id, target_entity_id, "
        "properties, confidence, source_system, source_ref, lifecycle_status, "
        "valid_from, valid_to, version, created_by, updated_by, created_at, "
        "updated_at, deleted_at"
    )

    async def upsert_graph_entity(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.graph_entities
                (tenant_id, entity_type, stable_key, external_id, source_system,
                 source_ref, name, description, classification, acl,
                 lifecycle_status, confidence, properties, metadata, valid_from,
                 valid_to, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                    $15, $16, $17, $17)
            ON CONFLICT (tenant_id, entity_type, stable_key) DO UPDATE
              SET external_id = COALESCE(EXCLUDED.external_id, ai.graph_entities.external_id),
                  source_system = COALESCE(EXCLUDED.source_system, ai.graph_entities.source_system),
                  source_ref = COALESCE(EXCLUDED.source_ref, ai.graph_entities.source_ref),
                  name = COALESCE(EXCLUDED.name, ai.graph_entities.name),
                  description = COALESCE(EXCLUDED.description, ai.graph_entities.description),
                  classification = EXCLUDED.classification,
                  acl = EXCLUDED.acl,
                  lifecycle_status = EXCLUDED.lifecycle_status,
                  confidence = EXCLUDED.confidence,
                  properties = EXCLUDED.properties,
                  metadata = ai.graph_entities.metadata || EXCLUDED.metadata,
                  valid_from = COALESCE(EXCLUDED.valid_from, ai.graph_entities.valid_from),
                  valid_to = COALESCE(EXCLUDED.valid_to, ai.graph_entities.valid_to),
                  updated_by = EXCLUDED.updated_by,
                  version = ai.graph_entities.version + 1,
                  deleted_at = NULL,
                  updated_at = now()
            RETURNING {self._ENTITY_COLUMNS}
            """,
            tenant_id,
            data["entity_type"],
            data["stable_key"],
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("name"),
            data.get("description"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("lifecycle_status", "active"),
            data.get("confidence", 1.0),
            data.get("properties", {}),
            data.get("metadata", {}),
            data.get("valid_from"),
            data.get("valid_to"),
            data.get("updated_by") or data.get("created_by"),
        )
        assert row is not None
        return row

    async def get_graph_entity(
        self, tenant_id: int, entity_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._ENTITY_COLUMNS} FROM ai.graph_entities "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            entity_id,
        )

    async def get_graph_entity_by_key(
        self, tenant_id: int, entity_type: str, stable_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._ENTITY_COLUMNS} FROM ai.graph_entities "
            "WHERE tenant_id = $1 AND entity_type = $2 AND stable_key = $3 "
            "AND deleted_at IS NULL",
            tenant_id,
            entity_type,
            stable_key,
        )

    async def list_graph_entities(
        self,
        tenant_id: int,
        *,
        entity_types: list[str] | None,
        query: str | None,
        lifecycle_status: str | None,
        source_system: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if entity_types:
            args.append(list(entity_types))
            clauses.append(f"entity_type = ANY(${len(args)})")
        if lifecycle_status:
            args.append(lifecycle_status)
            clauses.append(f"lifecycle_status = ${len(args)}")
        if source_system:
            args.append(source_system)
            clauses.append(f"source_system = ${len(args)}")
        if query:
            args.append(f"%{query.lower()}%")
            clauses.append(
                f"(lower(name) LIKE ${len(args)} OR lower(stable_key) LIKE "
                f"${len(args)} OR lower(COALESCE(external_id, '')) LIKE ${len(args)})"
            )
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._ENTITY_COLUMNS} FROM ai.graph_entities WHERE {where} "
            f"ORDER BY updated_at DESC, id DESC LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.graph_entities WHERE {where}", *args
        )
        return items, int(total or 0)

    async def update_graph_entity(
        self, tenant_id: int, entity_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "external_id",
            "source_system",
            "source_ref",
            "name",
            "description",
            "classification",
            "acl",
            "lifecycle_status",
            "confidence",
            "properties",
            "metadata",
            "valid_from",
            "valid_to",
            "updated_by",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        args: list[Any] = [tenant_id, entity_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        sets.append("version = version + 1")
        sets.append("updated_at = now()")
        return await self._db.fetchrow(
            f"UPDATE ai.graph_entities SET {', '.join(sets)} "
            f"WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL "
            f"RETURNING {self._ENTITY_COLUMNS}",
            *args,
        )

    async def delete_graph_entity(
        self, tenant_id: int, entity_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.graph_entities
            SET lifecycle_status = 'archived', deleted_at = now(), updated_by = $3,
                version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING {self._ENTITY_COLUMNS}
            """,
            tenant_id,
            entity_id,
            updated_by,
        )

    async def add_graph_entity_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.graph_entity_versions
                (tenant_id, entity_id, version, snapshot, change_reason, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (tenant_id, entity_id, version) DO UPDATE
              SET snapshot = EXCLUDED.snapshot,
                  change_reason = EXCLUDED.change_reason
            RETURNING id, tenant_id, entity_id, version, snapshot, change_reason,
                      created_by, created_at
            """,
            tenant_id,
            data["entity_id"],
            data["version"],
            data.get("snapshot", {}),
            data.get("change_reason"),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def list_graph_entity_versions(
        self, tenant_id: int, entity_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            "SELECT id, tenant_id, entity_id, version, snapshot, change_reason, "
            "created_by, created_at FROM ai.graph_entity_versions "
            "WHERE tenant_id = $1 AND entity_id = $2 ORDER BY version DESC",
            tenant_id,
            entity_id,
        )

    async def upsert_graph_relationship(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.graph_relationships
                (tenant_id, relationship_type, source_entity_id, target_entity_id,
                 properties, confidence, source_system, source_ref,
                 lifecycle_status, valid_from, valid_to, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
            ON CONFLICT (tenant_id, relationship_type, source_entity_id,
                         target_entity_id)
              WHERE deleted_at IS NULL
            DO UPDATE
              SET properties = EXCLUDED.properties,
                  confidence = EXCLUDED.confidence,
                  source_system = COALESCE(
                    EXCLUDED.source_system, ai.graph_relationships.source_system),
                  source_ref = COALESCE(
                    EXCLUDED.source_ref, ai.graph_relationships.source_ref),
                  lifecycle_status = EXCLUDED.lifecycle_status,
                  valid_from = COALESCE(EXCLUDED.valid_from, ai.graph_relationships.valid_from),
                  valid_to = COALESCE(EXCLUDED.valid_to, ai.graph_relationships.valid_to),
                  updated_by = EXCLUDED.updated_by,
                  version = ai.graph_relationships.version + 1,
                  updated_at = now()
            RETURNING {self._RELATIONSHIP_COLUMNS}
            """,
            tenant_id,
            data["relationship_type"],
            data["source_entity_id"],
            data["target_entity_id"],
            data.get("properties", {}),
            data.get("confidence", 1.0),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("lifecycle_status", "active"),
            data.get("valid_from"),
            data.get("valid_to"),
            data.get("updated_by") or data.get("created_by"),
        )
        assert row is not None
        return row

    async def get_graph_relationship(
        self, tenant_id: int, relationship_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._RELATIONSHIP_COLUMNS} FROM ai.graph_relationships "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            relationship_id,
        )

    async def list_graph_relationships(
        self,
        tenant_id: int,
        *,
        entity_ids: list[int] | None,
        relationship_types: list[str] | None,
        direction: str,
        include_inactive: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if entity_ids:
            args.append(list(entity_ids))
            idx = len(args)
            if direction == "outgoing":
                clauses.append(f"source_entity_id = ANY(${idx})")
            elif direction == "incoming":
                clauses.append(f"target_entity_id = ANY(${idx})")
            else:
                clauses.append(
                    f"(source_entity_id = ANY(${idx}) OR target_entity_id = ANY(${idx}))"
                )
        if relationship_types:
            args.append(list(relationship_types))
            clauses.append(f"relationship_type = ANY(${len(args)})")
        if not include_inactive:
            clauses.append("lifecycle_status = 'active'")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._RELATIONSHIP_COLUMNS} FROM ai.graph_relationships "
            f"WHERE {where} ORDER BY id LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.graph_relationships WHERE {where}", *args
        )
        return items, int(total or 0)

    async def update_graph_relationship(
        self, tenant_id: int, relationship_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "properties",
            "confidence",
            "source_system",
            "source_ref",
            "lifecycle_status",
            "valid_from",
            "valid_to",
            "updated_by",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        args: list[Any] = [tenant_id, relationship_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        sets.append("version = version + 1")
        sets.append("updated_at = now()")
        return await self._db.fetchrow(
            f"UPDATE ai.graph_relationships SET {', '.join(sets)} "
            f"WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL "
            f"RETURNING {self._RELATIONSHIP_COLUMNS}",
            *args,
        )

    async def delete_graph_relationship(
        self, tenant_id: int, relationship_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.graph_relationships
            SET lifecycle_status = 'archived', deleted_at = now(), updated_by = $3,
                version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING {self._RELATIONSHIP_COLUMNS}
            """,
            tenant_id,
            relationship_id,
            updated_by,
        )

    async def add_graph_relationship_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.graph_relationship_versions
                (tenant_id, relationship_id, version, snapshot, change_reason, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (tenant_id, relationship_id, version) DO UPDATE
              SET snapshot = EXCLUDED.snapshot,
                  change_reason = EXCLUDED.change_reason
            RETURNING id, tenant_id, relationship_id, version, snapshot,
                      change_reason, created_by, created_at
            """,
            tenant_id,
            data["relationship_id"],
            data["version"],
            data.get("snapshot", {}),
            data.get("change_reason"),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def list_graph_neighbors(
        self,
        tenant_id: int,
        *,
        entity_ids: list[int],
        relationship_types: list[str] | None,
        direction: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        clauses = ["r.tenant_id = $1", "r.deleted_at IS NULL",
                   "r.lifecycle_status = 'active'"]
        args: list[Any] = [tenant_id, list(entity_ids)]
        if direction == "outgoing":
            clauses.append("r.source_entity_id = ANY($2)")
        elif direction == "incoming":
            clauses.append("r.target_entity_id = ANY($2)")
        else:
            clauses.append("(r.source_entity_id = ANY($2) OR r.target_entity_id = ANY($2))")
        if relationship_types:
            args.append(list(relationship_types))
            clauses.append(f"r.relationship_type = ANY(${len(args)})")
        where = " AND ".join(clauses)
        return await self._db.fetch(
            f"""
            SELECT r.id, r.relationship_type, r.source_entity_id,
                   r.target_entity_id, r.confidence, r.source_system,
                   r.properties, r.lifecycle_status
            FROM ai.graph_relationships r
            WHERE {where}
            ORDER BY r.id
            LIMIT ${len(args) + 1}
            """,
            *args,
            limit,
        )

    async def graph_entity_type_counts(self, tenant_id: int) -> list[dict[str, Any]]:
        return await self._db.fetch(
            "SELECT entity_type, count(*) AS total FROM ai.graph_entities "
            "WHERE tenant_id = $1 AND deleted_at IS NULL "
            "GROUP BY entity_type ORDER BY total DESC, entity_type",
            tenant_id,
        )

    async def graph_stats(self, tenant_id: int) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            SELECT
              (SELECT count(*) FROM ai.graph_entities
                 WHERE tenant_id = $1 AND deleted_at IS NULL) AS entities,
              (SELECT count(*) FROM ai.graph_relationships
                 WHERE tenant_id = $1 AND deleted_at IS NULL
                   AND lifecycle_status = 'active') AS relationships,
              (SELECT count(*) FROM ai.graph_entities
                 WHERE tenant_id = $1 AND deleted_at IS NULL
                   AND lifecycle_status = 'stale') AS stale_entities,
              (SELECT max(updated_at) FROM ai.graph_entities
                 WHERE tenant_id = $1) AS last_entity_update,
              (SELECT max(updated_at) FROM ai.graph_relationships
                 WHERE tenant_id = $1) AS last_relationship_update
            """,
            tenant_id,
        )
        out = dict(row or {})
        return {
            "entities": int(out.get("entities") or 0),
            "relationships": int(out.get("relationships") or 0),
            "stale_entities": int(out.get("stale_entities") or 0),
            "last_entity_update": out.get("last_entity_update"),
            "last_relationship_update": out.get("last_relationship_update"),
        }

    async def list_graph_entity_types(
        self, tenant_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            "SELECT id, tenant_id, code, name, description, category, "
            "property_schema, enabled, created_by, created_at, updated_at "
            "FROM ai.graph_entity_types WHERE tenant_id = $1 ORDER BY code",
            tenant_id,
        )

    async def upsert_graph_entity_type(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.graph_entity_types
                (tenant_id, code, name, description, category, property_schema,
                 enabled, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (tenant_id, code) DO UPDATE
              SET name = EXCLUDED.name,
                  description = EXCLUDED.description,
                  category = EXCLUDED.category,
                  property_schema = EXCLUDED.property_schema,
                  enabled = EXCLUDED.enabled,
                  updated_at = now()
            RETURNING id, tenant_id, code, name, description, category,
                      property_schema, enabled, created_by, created_at, updated_at
            """,
            tenant_id,
            data["code"],
            data["name"],
            data.get("description"),
            data.get("category"),
            data.get("property_schema", {}),
            data.get("enabled", True),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def list_graph_relationship_types(
        self, tenant_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            "SELECT id, tenant_id, code, name, description, source_types, "
            "target_types, directed, property_schema, enabled, created_by, "
            "created_at, updated_at FROM ai.graph_relationship_types "
            "WHERE tenant_id = $1 ORDER BY code",
            tenant_id,
        )

    async def upsert_graph_relationship_type(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.graph_relationship_types
                (tenant_id, code, name, description, source_types, target_types,
                 directed, property_schema, enabled, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (tenant_id, code) DO UPDATE
              SET name = EXCLUDED.name,
                  description = EXCLUDED.description,
                  source_types = EXCLUDED.source_types,
                  target_types = EXCLUDED.target_types,
                  directed = EXCLUDED.directed,
                  property_schema = EXCLUDED.property_schema,
                  enabled = EXCLUDED.enabled,
                  updated_at = now()
            RETURNING id, tenant_id, code, name, description, source_types,
                      target_types, directed, property_schema, enabled,
                      created_by, created_at, updated_at
            """,
            tenant_id,
            data["code"],
            data["name"],
            data.get("description"),
            data.get("source_types", []),
            data.get("target_types", []),
            data.get("directed", True),
            data.get("property_schema", {}),
            data.get("enabled", True),
            data.get("created_by"),
        )
        assert row is not None
        return row

    # --- Product & BOM intelligence (Stage 8) ---------------------------
    _ITEM_COLUMNS = (
        "id, tenant_id, item_type, item_key, name, description, unit_of_measure, "
        "lifecycle_status, configuration, variants, effectivity_from, "
        "effectivity_to, external_id, source_system, source_ref, classification, "
        "acl, graph_entity_id, version, created_by, updated_by, created_at, "
        "updated_at, deleted_at"
    )
    _REVISION_COLUMNS = (
        "id, tenant_id, item_id, revision, lifecycle_status, effectivity_from, "
        "effectivity_to, configuration, external_id, source_system, source_ref, "
        "classification, acl, graph_entity_id, version, created_by, updated_by, "
        "created_at, updated_at, deleted_at"
    )
    _BOM_HEADER_COLUMNS = (
        "id, tenant_id, bom_type, bom_key, name, description, root_item_id, "
        "root_revision_id, plant, configuration, lifecycle_status, external_id, "
        "source_system, source_ref, classification, acl, graph_entity_id, version, "
        "created_by, updated_by, created_at, updated_at, deleted_at"
    )
    _BOM_LINE_COLUMNS = (
        "id, tenant_id, bom_header_id, parent_revision_id, child_item_id, "
        "child_revision_id, line_key, quantity, unit_of_measure, find_number, "
        "sequence, reference_designators, usage, line_status, is_phantom, "
        "is_reference, alternate_of_line_id, substitute_for_item_id, plant, "
        "effectivity_from, effectivity_to, configuration, attributes, "
        "source_system, source_ref, external_id, version, created_by, updated_by, "
        "created_at, updated_at, deleted_at"
    )

    async def upsert_product_item(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.product_items
                (tenant_id, item_type, item_key, name, description,
                 unit_of_measure, lifecycle_status, configuration, variants,
                 effectivity_from, effectivity_to, external_id, source_system,
                 source_ref, classification, acl, graph_entity_id, created_by,
                 updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                    $15, $16, $17, $18, $18)
            ON CONFLICT (tenant_id, item_type, item_key) DO UPDATE
              SET name = COALESCE(EXCLUDED.name, ai.product_items.name),
                  description = COALESCE(EXCLUDED.description, ai.product_items.description),
                  unit_of_measure = EXCLUDED.unit_of_measure,
                  lifecycle_status = EXCLUDED.lifecycle_status,
                  configuration = EXCLUDED.configuration,
                  variants = EXCLUDED.variants,
                  effectivity_from = COALESCE(
                      EXCLUDED.effectivity_from,
                      ai.product_items.effectivity_from),
                  effectivity_to = COALESCE(
                      EXCLUDED.effectivity_to,
                      ai.product_items.effectivity_to),
                  external_id = COALESCE(EXCLUDED.external_id, ai.product_items.external_id),
                  source_system = COALESCE(EXCLUDED.source_system, ai.product_items.source_system),
                  source_ref = COALESCE(EXCLUDED.source_ref, ai.product_items.source_ref),
                  classification = EXCLUDED.classification,
                  acl = EXCLUDED.acl,
                  graph_entity_id = COALESCE(
                      EXCLUDED.graph_entity_id,
                      ai.product_items.graph_entity_id),
                  updated_by = EXCLUDED.updated_by,
                  version = ai.product_items.version + 1,
                  deleted_at = NULL,
                  updated_at = now()
            RETURNING {self._ITEM_COLUMNS}
            """,
            tenant_id,
            data["item_type"],
            data["item_key"],
            data.get("name"),
            data.get("description"),
            data.get("unit_of_measure", "EA"),
            data.get("lifecycle_status", "active"),
            data.get("configuration", {}),
            data.get("variants", []),
            data.get("effectivity_from"),
            data.get("effectivity_to"),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("updated_by") or data.get("created_by"),
        )
        assert row is not None
        return row

    async def get_product_item(
        self, tenant_id: int, item_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._ITEM_COLUMNS} FROM ai.product_items "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            item_id,
        )

    async def get_product_item_by_key(
        self, tenant_id: int, item_type: str, item_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._ITEM_COLUMNS} FROM ai.product_items "
            "WHERE tenant_id = $1 AND item_type = $2 AND item_key = $3 "
            "AND deleted_at IS NULL",
            tenant_id,
            item_type,
            item_key,
        )

    async def list_product_items(
        self,
        tenant_id: int,
        *,
        item_types: list[str] | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if item_types:
            args.append(list(item_types))
            clauses.append(f"item_type = ANY(${len(args)})")
        if lifecycle_status:
            args.append(lifecycle_status)
            clauses.append(f"lifecycle_status = ${len(args)}")
        if query:
            args.append(f"%{query.lower()}%")
            clauses.append(
                f"(lower(item_key) LIKE ${len(args)} OR lower(COALESCE(name, '')) "
                f"LIKE ${len(args)} OR lower(COALESCE(external_id, '')) LIKE ${len(args)})"
            )
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._ITEM_COLUMNS} FROM ai.product_items WHERE {where} "
            f"ORDER BY updated_at DESC, id DESC LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.product_items WHERE {where}", *args
        )
        return items, int(total or 0)

    async def update_product_item(
        self, tenant_id: int, item_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "name",
            "description",
            "unit_of_measure",
            "lifecycle_status",
            "configuration",
            "variants",
            "effectivity_from",
            "effectivity_to",
            "external_id",
            "source_system",
            "source_ref",
            "classification",
            "acl",
            "graph_entity_id",
            "updated_by",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        args: list[Any] = [tenant_id, item_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        sets.append("version = version + 1")
        sets.append("updated_at = now()")
        return await self._db.fetchrow(
            f"UPDATE ai.product_items SET {', '.join(sets)} "
            f"WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL "
            f"RETURNING {self._ITEM_COLUMNS}",
            *args,
        )

    async def count_product_items_by_type(
        self, tenant_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            "SELECT item_type, count(*) AS total FROM ai.product_items "
            "WHERE tenant_id = $1 AND deleted_at IS NULL "
            "GROUP BY item_type ORDER BY total DESC, item_type",
            tenant_id,
        )

    async def upsert_product_revision(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.product_revisions
                (tenant_id, item_id, revision, lifecycle_status, effectivity_from,
                 effectivity_to, configuration, external_id, source_system,
                 source_ref, classification, acl, graph_entity_id, created_by,
                 updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
            ON CONFLICT (tenant_id, item_id, revision) DO UPDATE
              SET lifecycle_status = EXCLUDED.lifecycle_status,
                  effectivity_from = COALESCE(
                      EXCLUDED.effectivity_from,
                      ai.product_revisions.effectivity_from),
                  effectivity_to = COALESCE(
                      EXCLUDED.effectivity_to,
                      ai.product_revisions.effectivity_to),
                  configuration = EXCLUDED.configuration,
                  external_id = COALESCE(EXCLUDED.external_id, ai.product_revisions.external_id),
                  source_system = COALESCE(
                      EXCLUDED.source_system,
                      ai.product_revisions.source_system),
                  source_ref = COALESCE(EXCLUDED.source_ref, ai.product_revisions.source_ref),
                  classification = EXCLUDED.classification,
                  acl = EXCLUDED.acl,
                  graph_entity_id = COALESCE(
                      EXCLUDED.graph_entity_id,
                      ai.product_revisions.graph_entity_id),
                  updated_by = EXCLUDED.updated_by,
                  version = ai.product_revisions.version + 1,
                  deleted_at = NULL,
                  updated_at = now()
            RETURNING {self._REVISION_COLUMNS}
            """,
            tenant_id,
            data["item_id"],
            data["revision"],
            data.get("lifecycle_status", "draft"),
            data.get("effectivity_from"),
            data.get("effectivity_to"),
            data.get("configuration", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("updated_by") or data.get("created_by"),
        )
        assert row is not None
        return row

    async def get_product_revision(
        self, tenant_id: int, revision_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._REVISION_COLUMNS} FROM ai.product_revisions "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            revision_id,
        )

    async def get_product_revision_by_key(
        self, tenant_id: int, item_id: int, revision: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._REVISION_COLUMNS} FROM ai.product_revisions "
            "WHERE tenant_id = $1 AND item_id = $2 AND revision = $3 "
            "AND deleted_at IS NULL",
            tenant_id,
            item_id,
            revision,
        )

    async def list_product_revisions(
        self,
        tenant_id: int,
        *,
        item_id: int | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if item_id is not None:
            args.append(item_id)
            clauses.append(f"item_id = ${len(args)}")
        if lifecycle_status:
            args.append(lifecycle_status)
            clauses.append(f"lifecycle_status = ${len(args)}")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._REVISION_COLUMNS} FROM ai.product_revisions WHERE {where} "
            f"ORDER BY created_at DESC, id DESC LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.product_revisions WHERE {where}", *args
        )
        return items, int(total or 0)

    async def update_product_revision(
        self, tenant_id: int, revision_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "lifecycle_status",
            "effectivity_from",
            "effectivity_to",
            "configuration",
            "source_ref",
            "classification",
            "acl",
            "graph_entity_id",
            "updated_by",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        args: list[Any] = [tenant_id, revision_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        sets.append("version = version + 1")
        sets.append("updated_at = now()")
        return await self._db.fetchrow(
            f"UPDATE ai.product_revisions SET {', '.join(sets)} "
            f"WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL "
            f"RETURNING {self._REVISION_COLUMNS}",
            *args,
        )

    async def upsert_bom_header(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.bom_headers
                (tenant_id, bom_type, bom_key, name, description, root_item_id,
                 root_revision_id, plant, configuration, lifecycle_status,
                 external_id, source_system, source_ref, classification, acl,
                 graph_entity_id, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                    $15, $16, $17, $17)
            ON CONFLICT (tenant_id, bom_type, bom_key) DO UPDATE
              SET name = COALESCE(EXCLUDED.name, ai.bom_headers.name),
                  description = COALESCE(EXCLUDED.description, ai.bom_headers.description),
                  root_item_id = COALESCE(EXCLUDED.root_item_id, ai.bom_headers.root_item_id),
                  root_revision_id = COALESCE(
                      EXCLUDED.root_revision_id,
                      ai.bom_headers.root_revision_id),
                  plant = COALESCE(EXCLUDED.plant, ai.bom_headers.plant),
                  configuration = EXCLUDED.configuration,
                  lifecycle_status = EXCLUDED.lifecycle_status,
                  external_id = COALESCE(EXCLUDED.external_id, ai.bom_headers.external_id),
                  source_system = COALESCE(EXCLUDED.source_system, ai.bom_headers.source_system),
                  source_ref = COALESCE(EXCLUDED.source_ref, ai.bom_headers.source_ref),
                  classification = EXCLUDED.classification,
                  acl = EXCLUDED.acl,
                  graph_entity_id = COALESCE(
                      EXCLUDED.graph_entity_id,
                      ai.bom_headers.graph_entity_id),
                  updated_by = EXCLUDED.updated_by,
                  version = ai.bom_headers.version + 1,
                  deleted_at = NULL,
                  updated_at = now()
            RETURNING {self._BOM_HEADER_COLUMNS}
            """,
            tenant_id,
            data["bom_type"],
            data["bom_key"],
            data.get("name"),
            data.get("description"),
            data.get("root_item_id"),
            data.get("root_revision_id"),
            data.get("plant"),
            data.get("configuration", {}),
            data.get("lifecycle_status", "draft"),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("updated_by") or data.get("created_by"),
        )
        assert row is not None
        return row

    async def get_bom_header(
        self, tenant_id: int, header_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._BOM_HEADER_COLUMNS} FROM ai.bom_headers "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            header_id,
        )

    async def get_bom_header_by_key(
        self, tenant_id: int, bom_type: str, bom_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._BOM_HEADER_COLUMNS} FROM ai.bom_headers "
            "WHERE tenant_id = $1 AND bom_type = $2 AND bom_key = $3 "
            "AND deleted_at IS NULL",
            tenant_id,
            bom_type,
            bom_key,
        )

    async def list_bom_headers(
        self,
        tenant_id: int,
        *,
        bom_type: str | None,
        root_item_id: int | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if bom_type:
            args.append(bom_type)
            clauses.append(f"bom_type = ${len(args)}")
        if root_item_id is not None:
            args.append(root_item_id)
            clauses.append(f"root_item_id = ${len(args)}")
        if lifecycle_status:
            args.append(lifecycle_status)
            clauses.append(f"lifecycle_status = ${len(args)}")
        if query:
            args.append(f"%{query.lower()}%")
            clauses.append(
                f"(lower(bom_key) LIKE ${len(args)} OR lower(COALESCE(name, '')) "
                f"LIKE ${len(args)})"
            )
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._BOM_HEADER_COLUMNS} FROM ai.bom_headers WHERE {where} "
            f"ORDER BY updated_at DESC, id DESC LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.bom_headers WHERE {where}", *args
        )
        return items, int(total or 0)

    async def update_bom_header(
        self, tenant_id: int, header_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "name",
            "description",
            "root_item_id",
            "root_revision_id",
            "plant",
            "configuration",
            "lifecycle_status",
            "source_ref",
            "classification",
            "acl",
            "graph_entity_id",
            "updated_by",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        args: list[Any] = [tenant_id, header_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        sets.append("version = version + 1")
        sets.append("updated_at = now()")
        return await self._db.fetchrow(
            f"UPDATE ai.bom_headers SET {', '.join(sets)} "
            f"WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL "
            f"RETURNING {self._BOM_HEADER_COLUMNS}",
            *args,
        )

    async def delete_bom_header(
        self, tenant_id: int, header_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.bom_headers
            SET lifecycle_status = 'archived', deleted_at = now(), updated_by = $3,
                version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING {self._BOM_HEADER_COLUMNS}
            """,
            tenant_id,
            header_id,
            updated_by,
        )

    async def create_bom_line(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            f"""
            INSERT INTO ai.bom_lines
                (tenant_id, bom_header_id, parent_revision_id, child_item_id,
                 child_revision_id, line_key, quantity, unit_of_measure,
                 find_number, sequence, reference_designators, usage, line_status,
                 is_phantom, is_reference, alternate_of_line_id,
                 substitute_for_item_id, plant, effectivity_from, effectivity_to,
                 configuration, attributes, source_system, source_ref, external_id,
                 created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                    $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
                    $26)
            ON CONFLICT (tenant_id, bom_header_id, line_key) WHERE deleted_at IS NULL
            DO UPDATE
              SET parent_revision_id = EXCLUDED.parent_revision_id,
                  child_item_id = EXCLUDED.child_item_id,
                  child_revision_id = EXCLUDED.child_revision_id,
                  quantity = EXCLUDED.quantity,
                  unit_of_measure = EXCLUDED.unit_of_measure,
                  find_number = EXCLUDED.find_number,
                  sequence = EXCLUDED.sequence,
                  reference_designators = EXCLUDED.reference_designators,
                  usage = EXCLUDED.usage,
                  line_status = EXCLUDED.line_status,
                  is_phantom = EXCLUDED.is_phantom,
                  is_reference = EXCLUDED.is_reference,
                  alternate_of_line_id = EXCLUDED.alternate_of_line_id,
                  substitute_for_item_id = EXCLUDED.substitute_for_item_id,
                  plant = EXCLUDED.plant,
                  effectivity_from = EXCLUDED.effectivity_from,
                  effectivity_to = EXCLUDED.effectivity_to,
                  configuration = EXCLUDED.configuration,
                  attributes = EXCLUDED.attributes,
                  source_system = EXCLUDED.source_system,
                  source_ref = EXCLUDED.source_ref,
                  external_id = EXCLUDED.external_id,
                  updated_by = EXCLUDED.updated_by,
                  version = ai.bom_lines.version + 1,
                  updated_at = now()
            RETURNING {self._BOM_LINE_COLUMNS}
            """,
            tenant_id,
            data["bom_header_id"],
            data["parent_revision_id"],
            data["child_item_id"],
            data.get("child_revision_id"),
            data["line_key"],
            data.get("quantity", 1),
            data.get("unit_of_measure", "EA"),
            data.get("find_number"),
            data.get("sequence", 0),
            data.get("reference_designators", []),
            data.get("usage", "DESIGN"),
            data.get("line_status", "active"),
            data.get("is_phantom", False),
            data.get("is_reference", False),
            data.get("alternate_of_line_id"),
            data.get("substitute_for_item_id"),
            data.get("plant"),
            data.get("effectivity_from"),
            data.get("effectivity_to"),
            data.get("configuration", {}),
            data.get("attributes", {}),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("external_id"),
            data.get("updated_by") or data.get("created_by"),
        )
        assert row is not None
        return row

    async def get_bom_line(
        self, tenant_id: int, line_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._BOM_LINE_COLUMNS} FROM ai.bom_lines "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            line_id,
        )

    async def list_bom_lines(
        self,
        tenant_id: int,
        *,
        header_id: int | None,
        parent_revision_id: int | None,
        child_item_id: int | None,
        active_only: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if header_id is not None:
            args.append(header_id)
            clauses.append(f"bom_header_id = ${len(args)}")
        if parent_revision_id is not None:
            args.append(parent_revision_id)
            clauses.append(f"parent_revision_id = ${len(args)}")
        if child_item_id is not None:
            args.append(child_item_id)
            clauses.append(f"child_item_id = ${len(args)}")
        if active_only:
            clauses.append("line_status = 'active'")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {self._BOM_LINE_COLUMNS} FROM ai.bom_lines WHERE {where} "
            f"ORDER BY sequence, line_key LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.bom_lines WHERE {where}", *args
        )
        return items, int(total or 0)

    async def list_bom_lines_by_parents(
        self, tenant_id: int, header_id: int, parent_revision_ids: list[int]
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"SELECT {self._BOM_LINE_COLUMNS} FROM ai.bom_lines "
            "WHERE tenant_id = $1 AND bom_header_id = $2 "
            "AND parent_revision_id = ANY($3) AND line_status = 'active' "
            "AND deleted_at IS NULL ORDER BY sequence, line_key",
            tenant_id,
            header_id,
            list(parent_revision_ids),
        )

    async def update_bom_line(
        self, tenant_id: int, line_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "child_revision_id",
            "quantity",
            "unit_of_measure",
            "find_number",
            "sequence",
            "reference_designators",
            "usage",
            "line_status",
            "is_phantom",
            "is_reference",
            "substitute_for_item_id",
            "plant",
            "effectivity_from",
            "effectivity_to",
            "configuration",
            "attributes",
            "source_ref",
            "external_id",
            "updated_by",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        args: list[Any] = [tenant_id, line_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        sets.append("version = version + 1")
        sets.append("updated_at = now()")
        return await self._db.fetchrow(
            f"UPDATE ai.bom_lines SET {', '.join(sets)} "
            f"WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL "
            f"RETURNING {self._BOM_LINE_COLUMNS}",
            *args,
        )

    async def delete_bom_line(
        self, tenant_id: int, line_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"""
            UPDATE ai.bom_lines
            SET line_status = 'obsolete', deleted_at = now(), updated_by = $3,
                version = version + 1, updated_at = now()
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING {self._BOM_LINE_COLUMNS}
            """,
            tenant_id,
            line_id,
            updated_by,
        )

    async def add_bom_transformation_run(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._write_transaction() as db:
            run = await db.fetchrow(
                """
                INSERT INTO ai.bom_transformation_runs
                    (tenant_id, source_header_id, target_header_id, mode, status,
                     summary, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id, tenant_id, source_header_id, target_header_id, mode,
                          status, summary, created_by, created_at, updated_at
                """,
                tenant_id,
                data["source_header_id"],
                data.get("target_header_id"),
                data.get("mode", "DRY_RUN"),
                data.get("status", "completed"),
                data.get("summary", {}),
                data.get("created_by"),
            )
            assert run is not None
            entries: list[dict[str, Any]] = []
            for entry in data.get("entries", []):
                row = await db.fetchrow(
                    """
                    INSERT INTO ai.bom_transformation_entries
                        (tenant_id, run_id, source_line_id, target_line_id,
                         mapping_type, quantity, unit_of_measure, notes)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING id, tenant_id, run_id, source_line_id,
                              target_line_id, mapping_type, quantity,
                              unit_of_measure, notes
                    """,
                    tenant_id,
                    run["id"],
                    entry.get("source_line_id"),
                    entry.get("target_line_id"),
                    entry.get("mapping_type", "UNMATCHED"),
                    entry.get("quantity"),
                    entry.get("unit_of_measure"),
                    entry.get("notes"),
                )
                if row is not None:
                    entries.append(row)
            out = dict(run)
            out["entries"] = entries
            return out

    async def get_bom_transformation_run(
        self, tenant_id: int, run_id: int
    ) -> dict[str, Any] | None:
        run = await self._db.fetchrow(
            "SELECT id, tenant_id, source_header_id, target_header_id, mode, status, "
            "summary, created_by, created_at, updated_at "
            "FROM ai.bom_transformation_runs "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            run_id,
        )
        if run is None:
            return None
        entries = await self._db.fetch(
            "SELECT id, source_line_id, target_line_id, mapping_type, quantity, "
            "unit_of_measure, notes FROM ai.bom_transformation_entries "
            "WHERE tenant_id = $1 AND run_id = $2 ORDER BY id",
            tenant_id,
            run_id,
        )
        out = dict(run)
        out["entries"] = entries
        return out

    async def list_bom_transformation_runs(
        self, tenant_id: int, *, source_header_id: int | None, limit: int
    ) -> list[dict[str, Any]]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if source_header_id is not None:
            args.append(source_header_id)
            clauses.append(f"source_header_id = ${len(args)}")
        args.append(limit)
        return await self._db.fetch(
            "SELECT id, source_header_id, target_header_id, mode, status, summary, "
            "created_by, created_at FROM ai.bom_transformation_runs "
            f"WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ${len(args)}",
            *args,
        )

    async def add_bom_reconciliation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.bom_reconciliations
                (tenant_id, source_header_id, target_header_id, run_id, status,
                 exceptions, summary, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, tenant_id, source_header_id, target_header_id, run_id,
                      status, exceptions, summary, created_by, created_at,
                      updated_at
            """,
            tenant_id,
            data["source_header_id"],
            data.get("target_header_id"),
            data.get("run_id"),
            data.get("status", "open"),
            data.get("exceptions", []),
            data.get("summary", {}),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def list_bom_reconciliations(
        self, tenant_id: int, *, source_header_id: int | None, limit: int
    ) -> list[dict[str, Any]]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if source_header_id is not None:
            args.append(source_header_id)
            clauses.append(f"source_header_id = ${len(args)}")
        args.append(limit)
        return await self._db.fetch(
            "SELECT id, source_header_id, target_header_id, run_id, status, "
            "exceptions, summary, created_at FROM ai.bom_reconciliations "
            f"WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ${len(args)}",
            *args,
        )

    # --- Manufacturing & quality intelligence (Stage 9) ----------------
    _PLANT_COLUMNS = (
        "id, tenant_id, plant_key, name, description, site_code, country, timezone, "
        "lifecycle_status, attributes, external_id, source_system, source_ref, "
        "classification, acl, graph_entity_id, version, created_by, updated_by, "
        "created_at, updated_at, deleted_at"
    )
    _LINE_COLUMNS = (
        "id, tenant_id, plant_id, line_key, name, description, lifecycle_status, "
        "capacity_per_hour, attributes, external_id, source_system, source_ref, "
        "classification, acl, graph_entity_id, version, created_by, updated_by, "
        "created_at, updated_at, deleted_at"
    )
    _WORK_CENTRE_COLUMNS = (
        "id, tenant_id, plant_id, line_id, work_centre_key, name, description, "
        "work_centre_type, lifecycle_status, capacity_per_hour, attributes, "
        "external_id, source_system, source_ref, classification, acl, "
        "graph_entity_id, version, created_by, updated_by, created_at, updated_at, "
        "deleted_at"
    )
    _PROCESS_COLUMNS = (
        "id, tenant_id, process_type, process_key, name, description, root_item_id, "
        "root_revision_id, mbom_header_id, plant_id, line_id, revision, "
        "lifecycle_status, effectivity_from, effectivity_to, configuration, "
        "external_id, source_system, source_ref, classification, acl, "
        "graph_entity_id, version, created_by, updated_by, created_at, updated_at, "
        "deleted_at"
    )
    _PROCESS_REVISION_COLUMNS = (
        "id, tenant_id, process_id, revision, lifecycle_status, effectivity_from, "
        "effectivity_to, change_reason, configuration, external_id, source_system, "
        "source_ref, classification, acl, graph_entity_id, version, created_by, "
        "updated_by, created_at, updated_at, deleted_at"
    )
    _OPERATION_COLUMNS = (
        "id, tenant_id, process_id, process_revision_id, operation_key, name, "
        "description, operation_type, sequence, work_centre_id, plant_id, "
        "setup_minutes, cycle_minutes, lifecycle_status, attributes, external_id, "
        "source_system, source_ref, classification, acl, graph_entity_id, version, "
        "created_by, updated_by, created_at, updated_at, deleted_at"
    )
    _INSTRUCTION_COLUMNS = (
        "id, tenant_id, process_id, operation_id, instruction_key, title, "
        "description, instruction_type, revision, lifecycle_status, document_ref, "
        "steps, external_id, source_system, source_ref, classification, acl, "
        "graph_entity_id, version, created_by, updated_by, created_at, updated_at, "
        "deleted_at"
    )
    _RESOURCE_COLUMNS = (
        "id, tenant_id, resource_key, name, description, resource_kind, plant_id, "
        "work_centre_id, lifecycle_status, calibration_due, attributes, external_id, "
        "source_system, source_ref, classification, acl, graph_entity_id, version, "
        "created_by, updated_by, created_at, updated_at, deleted_at"
    )
    _PRODUCTION_VERSION_COLUMNS = (
        "id, tenant_id, item_id, process_id, mbom_header_id, version_key, name, "
        "lifecycle_status, effectivity_from, effectivity_to, plant_id, "
        "configuration, external_id, source_system, source_ref, classification, acl, "
        "graph_entity_id, version, created_by, updated_by, created_at, updated_at, "
        "deleted_at"
    )
    _ISSUE_COLUMNS = (
        "id, tenant_id, issue_key, title, description, issue_type, severity, status, "
        "disposition, product_item_id, component_item_id, process_id, operation_id, "
        "plant_id, work_centre_id, supplier_ref, failure_code, detected_at, "
        "detected_by, root_cause_status, attributes, external_id, source_system, "
        "source_ref, classification, acl, graph_entity_id, version, created_by, "
        "updated_by, created_at, updated_at, deleted_at"
    )
    _INSPECTION_COLUMNS = (
        "id, tenant_id, inspection_key, title, description, inspection_type, status, "
        "product_item_id, component_item_id, operation_id, plant_id, work_centre_id, "
        "quality_issue_id, characteristic, sample_size, passed_count, failed_count, "
        "performed_by, performed_at, result, attributes, external_id, source_system, "
        "source_ref, classification, acl, graph_entity_id, version, created_by, "
        "updated_by, created_at, updated_at, deleted_at"
    )
    _QUALITY_ACTION_COLUMNS = (
        "id, tenant_id, action_key, quality_issue_id, title, description, action_type, "
        "status, root_cause_id, owner_user, due_at, implemented_at, verified_at, "
        "verified_by, effectiveness, evidence, external_id, source_system, "
        "source_ref, classification, acl, graph_entity_id, version, created_by, "
        "updated_by, created_at, updated_at, deleted_at"
    )

    async def _mq_insert_upsert(
        self,
        table: str,
        columns: list[str],
        conflict: tuple[str, ...],
        update_columns: list[str],
        returning: str,
        *args: Any,
        has_version: bool = True,
    ) -> dict[str, Any]:
        placeholders = ", ".join(f"${index}" for index in range(1, len(columns) + 1))
        if update_columns:
            assignments = ", ".join(
                f"{column} = EXCLUDED.{column}" for column in update_columns
            )
            if has_version:
                assignments += (
                    ", version = ai."
                    + table
                    + ".version + 1, deleted_at = NULL, updated_at = now()"
                )
            else:
                assignments += ", deleted_at = NULL, updated_at = now()"
            conflict_clause = (
                f"ON CONFLICT ({', '.join(conflict)}) DO UPDATE SET {assignments}"
            )
        else:
            conflict_clause = f"ON CONFLICT ({', '.join(conflict)}) DO NOTHING"
        row = await self._db.fetchrow(
            f"INSERT INTO ai.{table} ({', '.join(columns)}) VALUES ({placeholders}) "
            f"{conflict_clause} RETURNING {returning}",
            *args,
        )
        if row is None:
            row = await self._db.fetchrow(
                f"SELECT {returning} FROM ai.{table} WHERE "
                + " AND ".join(
                    f"{column} = ${index + 1}" for index, column in enumerate(conflict)
                )
                + " AND deleted_at IS NULL",
                *args[: len(conflict)],
            )
        assert row is not None
        return row

    async def _mq_update(
        self,
        table: str,
        columns: str,
        record_id: int,
        tenant_id: int,
        fields: dict[str, Any],
        allowed: set[str],
        *,
        increment_version: bool = True,
    ) -> dict[str, Any] | None:
        updates = {key: value for key, value in fields.items() if key in allowed}
        args: list[Any] = [tenant_id, record_id]
        sets: list[str] = []
        for key, value in updates.items():
            args.append(value)
            sets.append(f"{key} = ${len(args)}")
        if increment_version:
            sets.append("version = version + 1")
        sets.append("updated_at = now()")
        return await self._db.fetchrow(
            f"UPDATE ai.{table} SET {', '.join(sets)} "
            f"WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL "
            f"RETURNING {columns}",
            *args,
        )

    async def _mq_list(
        self,
        table: str,
        columns: str,
        tenant_id: int,
        *,
        filters: list[tuple[str, Any]],
        query: str | None,
        query_columns: tuple[str, ...],
        limit: int,
        offset: int,
        order_by: str = "updated_at DESC, id DESC",
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        for column, value in filters:
            if value is not None:
                args.append(value)
                clauses.append(f"{column} = ${len(args)}")
        if query:
            args.append(f"%{query.lower()}%")
            index = len(args)
            ors = " OR ".join(
                f"lower(COALESCE({column}::text, '')) LIKE ${index}"
                for column in query_columns
            )
            clauses.append(f"({ors})")
        where = " AND ".join(clauses)
        items = await self._db.fetch(
            f"SELECT {columns} FROM ai.{table} WHERE {where} "
            f"ORDER BY {order_by} LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
            *args,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.{table} WHERE {where}", *args
        )
        return items, int(total or 0)

    async def upsert_mfg_plant(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "mfg_plants",
            ["tenant_id", "plant_key", "name", "description", "site_code", "country",
             "timezone", "lifecycle_status", "attributes", "external_id",
             "source_system", "source_ref", "classification", "acl", "graph_entity_id",
             "created_by", "updated_by"],
            ("tenant_id", "plant_key"),
            ["name", "description", "site_code", "country", "timezone",
             "lifecycle_status", "attributes", "external_id", "source_system",
             "source_ref", "classification", "acl", "graph_entity_id", "updated_by"],
            self._PLANT_COLUMNS,
            tenant_id,
            data["plant_key"],
            data.get("name"),
            data.get("description"),
            data.get("site_code"),
            data.get("country"),
            data.get("timezone"),
            data.get("lifecycle_status", "active"),
            data.get("attributes", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_mfg_plant(self, tenant_id: int, plant_id: int) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PLANT_COLUMNS} FROM ai.mfg_plants "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            plant_id,
        )

    async def get_mfg_plant_by_key(
        self, tenant_id: int, plant_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PLANT_COLUMNS} FROM ai.mfg_plants "
            "WHERE tenant_id = $1 AND plant_key = $2 AND deleted_at IS NULL",
            tenant_id,
            plant_key,
        )

    async def list_mfg_plants(
        self, tenant_id: int, *, query: str | None, lifecycle_status: str | None,
        limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "mfg_plants", self._PLANT_COLUMNS, tenant_id,
            filters=[("lifecycle_status", lifecycle_status)], query=query,
            query_columns=("plant_key", "name", "site_code"), limit=limit, offset=offset,
        )

    async def update_mfg_plant(
        self, tenant_id: int, plant_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "mfg_plants", self._PLANT_COLUMNS, plant_id, tenant_id, fields,
            {"name", "description", "site_code", "country", "timezone",
             "lifecycle_status", "attributes", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"},
        )

    async def upsert_mfg_line(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "mfg_production_lines",
            ["tenant_id", "plant_id", "line_key", "name", "description",
             "lifecycle_status", "capacity_per_hour", "attributes", "external_id",
             "source_system", "source_ref", "classification", "acl", "graph_entity_id",
             "created_by", "updated_by"],
            ("tenant_id", "plant_id", "line_key"),
            ["name", "description", "lifecycle_status", "capacity_per_hour",
             "attributes", "external_id", "source_system", "source_ref",
             "classification", "acl", "graph_entity_id", "updated_by"],
            self._LINE_COLUMNS,
            tenant_id,
            data["plant_id"],
            data["line_key"],
            data.get("name"),
            data.get("description"),
            data.get("lifecycle_status", "active"),
            data.get("capacity_per_hour"),
            data.get("attributes", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_mfg_line(self, tenant_id: int, line_id: int) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._LINE_COLUMNS} FROM ai.mfg_production_lines "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            line_id,
        )

    async def get_mfg_line_by_key(
        self, tenant_id: int, plant_id: int, line_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._LINE_COLUMNS} FROM ai.mfg_production_lines "
            "WHERE tenant_id = $1 AND plant_id = $2 AND line_key = $3 "
            "AND deleted_at IS NULL",
            tenant_id,
            plant_id,
            line_key,
        )

    async def list_mfg_lines(
        self, tenant_id: int, *, plant_id: int | None, query: str | None,
        lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "mfg_production_lines", self._LINE_COLUMNS, tenant_id,
            filters=[("plant_id", plant_id), ("lifecycle_status", lifecycle_status)],
            query=query, query_columns=("line_key", "name"),
            limit=limit, offset=offset,
        )

    async def update_mfg_line(
        self, tenant_id: int, line_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "mfg_production_lines", self._LINE_COLUMNS, line_id, tenant_id, fields,
            {"name", "description", "lifecycle_status", "capacity_per_hour",
             "attributes", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"},
        )

    async def upsert_mfg_work_centre(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "mfg_work_centres",
            ["tenant_id", "plant_id", "line_id", "work_centre_key", "name",
             "description", "work_centre_type", "lifecycle_status",
             "capacity_per_hour", "attributes", "external_id", "source_system",
             "source_ref", "classification", "acl", "graph_entity_id", "created_by",
             "updated_by"],
            ("tenant_id", "plant_id", "work_centre_key"),
            ["line_id", "name", "description", "work_centre_type", "lifecycle_status",
             "capacity_per_hour", "attributes", "external_id", "source_system",
             "source_ref", "classification", "acl", "graph_entity_id", "updated_by"],
            self._WORK_CENTRE_COLUMNS,
            tenant_id,
            data["plant_id"],
            data.get("line_id"),
            data["work_centre_key"],
            data.get("name"),
            data.get("description"),
            data.get("work_centre_type", "other"),
            data.get("lifecycle_status", "active"),
            data.get("capacity_per_hour"),
            data.get("attributes", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_mfg_work_centre(
        self, tenant_id: int, work_centre_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._WORK_CENTRE_COLUMNS} FROM ai.mfg_work_centres "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            work_centre_id,
        )

    async def get_mfg_work_centre_by_key(
        self, tenant_id: int, plant_id: int, work_centre_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._WORK_CENTRE_COLUMNS} FROM ai.mfg_work_centres "
            "WHERE tenant_id = $1 AND plant_id = $2 AND work_centre_key = $3 "
            "AND deleted_at IS NULL",
            tenant_id,
            plant_id,
            work_centre_key,
        )

    async def list_mfg_work_centres(
        self, tenant_id: int, *, plant_id: int | None, line_id: int | None,
        query: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "mfg_work_centres", self._WORK_CENTRE_COLUMNS, tenant_id,
            filters=[("plant_id", plant_id), ("line_id", line_id)], query=query,
            query_columns=("work_centre_key", "name"), limit=limit, offset=offset,
        )

    async def update_mfg_work_centre(
        self, tenant_id: int, work_centre_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "mfg_work_centres", self._WORK_CENTRE_COLUMNS, work_centre_id, tenant_id,
            fields,
            {"line_id", "name", "description", "work_centre_type", "lifecycle_status",
             "capacity_per_hour", "attributes", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"},
        )

    async def upsert_mfg_process(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "mfg_processes",
            ["tenant_id", "process_type", "process_key", "name", "description",
             "root_item_id", "root_revision_id", "mbom_header_id", "plant_id",
             "line_id", "revision", "lifecycle_status", "effectivity_from",
             "effectivity_to", "configuration", "external_id", "source_system",
             "source_ref", "classification", "acl", "graph_entity_id", "created_by",
             "updated_by"],
            ("tenant_id", "process_type", "process_key"),
            ["name", "description", "root_item_id", "root_revision_id",
             "mbom_header_id", "plant_id", "line_id", "revision", "lifecycle_status",
             "effectivity_from", "effectivity_to", "configuration", "external_id",
             "source_system", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"],
            self._PROCESS_COLUMNS,
            tenant_id,
            data["process_type"],
            data["process_key"],
            data.get("name"),
            data.get("description"),
            data.get("root_item_id"),
            data.get("root_revision_id"),
            data.get("mbom_header_id"),
            data.get("plant_id"),
            data.get("line_id"),
            data.get("revision", "A"),
            data.get("lifecycle_status", "draft"),
            data.get("effectivity_from"),
            data.get("effectivity_to"),
            data.get("configuration", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_mfg_process(
        self, tenant_id: int, process_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PROCESS_COLUMNS} FROM ai.mfg_processes "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            process_id,
        )

    async def get_mfg_process_by_key(
        self, tenant_id: int, process_type: str, process_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PROCESS_COLUMNS} FROM ai.mfg_processes "
            "WHERE tenant_id = $1 AND process_type = $2 AND process_key = $3 "
            "AND deleted_at IS NULL",
            tenant_id,
            process_type,
            process_key,
        )

    async def list_mfg_processes(
        self, tenant_id: int, *, process_type: str | None, root_item_id: int | None,
        mbom_header_id: int | None, query: str | None, lifecycle_status: str | None,
        limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "mfg_processes", self._PROCESS_COLUMNS, tenant_id,
            filters=[
                ("process_type", process_type),
                ("root_item_id", root_item_id),
                ("mbom_header_id", mbom_header_id),
                ("lifecycle_status", lifecycle_status),
            ],
            query=query, query_columns=("process_key", "name"),
            limit=limit, offset=offset,
        )

    async def update_mfg_process(
        self, tenant_id: int, process_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "mfg_processes", self._PROCESS_COLUMNS, process_id, tenant_id, fields,
            {"name", "description", "root_item_id", "root_revision_id",
             "mbom_header_id", "plant_id", "line_id", "lifecycle_status",
             "effectivity_from", "effectivity_to", "configuration", "source_ref",
             "classification", "acl", "graph_entity_id", "updated_by"},
        )

    async def upsert_mfg_process_revision(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "mfg_process_revisions",
            ["tenant_id", "process_id", "revision", "lifecycle_status",
             "effectivity_from", "effectivity_to", "change_reason", "configuration",
             "external_id", "source_system", "source_ref", "classification", "acl",
             "graph_entity_id", "created_by", "updated_by"],
            ("tenant_id", "process_id", "revision"),
            ["lifecycle_status", "effectivity_from", "effectivity_to",
             "change_reason", "configuration", "external_id", "source_system",
             "source_ref", "classification", "acl", "graph_entity_id", "updated_by"],
            self._PROCESS_REVISION_COLUMNS,
            tenant_id,
            data["process_id"],
            data["revision"],
            data.get("lifecycle_status", "draft"),
            data.get("effectivity_from"),
            data.get("effectivity_to"),
            data.get("change_reason", ""),
            data.get("configuration", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_mfg_process_revision(
        self, tenant_id: int, revision_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PROCESS_REVISION_COLUMNS} FROM ai.mfg_process_revisions "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            revision_id,
        )

    async def get_mfg_process_revision_by_key(
        self, tenant_id: int, process_id: int, revision: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PROCESS_REVISION_COLUMNS} FROM ai.mfg_process_revisions "
            "WHERE tenant_id = $1 AND process_id = $2 AND revision = $3 "
            "AND deleted_at IS NULL",
            tenant_id,
            process_id,
            revision,
        )

    async def list_mfg_process_revisions(
        self, tenant_id: int, *, process_id: int | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "mfg_process_revisions", self._PROCESS_REVISION_COLUMNS, tenant_id,
            filters=[("process_id", process_id)], query=None, query_columns=(),
            limit=limit, offset=offset,
        )

    async def update_mfg_process_revision(
        self, tenant_id: int, revision_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "mfg_process_revisions", self._PROCESS_REVISION_COLUMNS, revision_id,
            tenant_id, fields,
            {"lifecycle_status", "effectivity_from", "effectivity_to",
             "configuration", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"},
        )

    async def upsert_mfg_operation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "mfg_operations",
            ["tenant_id", "process_id", "process_revision_id", "operation_key",
             "name", "description", "operation_type", "sequence", "work_centre_id",
             "plant_id", "setup_minutes", "cycle_minutes", "lifecycle_status",
             "attributes", "external_id", "source_system", "source_ref",
             "classification", "acl", "graph_entity_id", "created_by", "updated_by"],
            ("tenant_id", "process_id", "operation_key"),
            ["process_revision_id", "name", "description", "operation_type",
             "sequence", "work_centre_id", "plant_id", "setup_minutes",
             "cycle_minutes", "lifecycle_status", "attributes", "external_id",
             "source_system", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"],
            self._OPERATION_COLUMNS,
            tenant_id,
            data["process_id"],
            data.get("process_revision_id"),
            data["operation_key"],
            data.get("name"),
            data.get("description"),
            data.get("operation_type", "value_add"),
            int(data.get("sequence", 0)),
            data.get("work_centre_id"),
            data.get("plant_id"),
            data.get("setup_minutes"),
            data.get("cycle_minutes"),
            data.get("lifecycle_status", "draft"),
            data.get("attributes", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_mfg_operation(
        self, tenant_id: int, operation_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._OPERATION_COLUMNS} FROM ai.mfg_operations "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            operation_id,
        )

    async def get_mfg_operation_by_key(
        self, tenant_id: int, process_id: int, operation_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._OPERATION_COLUMNS} FROM ai.mfg_operations "
            "WHERE tenant_id = $1 AND process_id = $2 AND operation_key = $3 "
            "AND deleted_at IS NULL",
            tenant_id,
            process_id,
            operation_key,
        )

    async def list_mfg_operations(
        self, tenant_id: int, *, process_id: int | None, work_centre_id: int | None,
        lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "mfg_operations", self._OPERATION_COLUMNS, tenant_id,
            filters=[
                ("process_id", process_id),
                ("work_centre_id", work_centre_id),
                ("lifecycle_status", lifecycle_status),
            ],
            query=None, query_columns=(), limit=limit, offset=offset,
            order_by="sequence ASC, id ASC",
        )

    async def list_mfg_operations_by_process(
        self, tenant_id: int, process_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"SELECT {self._OPERATION_COLUMNS} FROM ai.mfg_operations "
            "WHERE tenant_id = $1 AND process_id = $2 AND deleted_at IS NULL "
            "ORDER BY sequence ASC, id ASC",
            tenant_id,
            process_id,
        )

    async def update_mfg_operation(
        self, tenant_id: int, operation_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "mfg_operations", self._OPERATION_COLUMNS, operation_id, tenant_id, fields,
            {"process_revision_id", "name", "description", "operation_type",
             "sequence", "work_centre_id", "plant_id", "setup_minutes",
             "cycle_minutes", "lifecycle_status", "attributes", "source_ref",
             "classification", "acl", "graph_entity_id", "updated_by"},
        )

    async def add_mfg_operation_dependency(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.mfg_operation_dependencies
                (tenant_id, process_id, operation_id, depends_on_operation_id,
                 dependency_type, lag_minutes)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (tenant_id, operation_id, depends_on_operation_id)
              DO UPDATE SET dependency_type = EXCLUDED.dependency_type,
                            lag_minutes = EXCLUDED.lag_minutes
            RETURNING id, tenant_id, process_id, operation_id,
                      depends_on_operation_id, dependency_type, lag_minutes,
                      created_at
            """,
            tenant_id,
            data["process_id"],
            data["operation_id"],
            data["depends_on_operation_id"],
            data.get("dependency_type", "finish_to_start"),
            data.get("lag_minutes"),
        )
        assert row is not None
        return row

    async def list_mfg_operation_dependencies(
        self, tenant_id: int, *, process_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            "SELECT id, tenant_id, process_id, operation_id, "
            "depends_on_operation_id, dependency_type, lag_minutes, created_at "
            "FROM ai.mfg_operation_dependencies "
            "WHERE tenant_id = $1 AND process_id = $2 ORDER BY id",
            tenant_id,
            process_id,
        )

    async def list_mfg_dependencies_for_operators(
        self, tenant_id: int, operation_ids: list[int]
    ) -> list[dict[str, Any]]:
        if not operation_ids:
            return []
        return await self._db.fetch(
            "SELECT id, tenant_id, process_id, operation_id, "
            "depends_on_operation_id, dependency_type, lag_minutes, created_at "
            "FROM ai.mfg_operation_dependencies "
            "WHERE tenant_id = $1 AND operation_id = ANY($2) ORDER BY id",
            tenant_id,
            operation_ids,
        )

    async def delete_mfg_operation_dependency(
        self, tenant_id: int, dependency_id: int
    ) -> bool:
        row = await self._db.fetchval(
            "DELETE FROM ai.mfg_operation_dependencies "
            "WHERE tenant_id = $1 AND id = $2 RETURNING id",
            tenant_id,
            dependency_id,
        )
        return row is not None

    async def add_mfg_operation_consumption(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.mfg_operation_consumptions
                (tenant_id, operation_id, child_item_id, bom_line_id, quantity,
                 unit_of_measure, consumption_type, notes, external_id,
                 source_system, source_ref, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id, tenant_id, operation_id, child_item_id, bom_line_id,
                      quantity, unit_of_measure, consumption_type, notes,
                      external_id, source_system, source_ref, created_at, updated_at
            """,
            tenant_id,
            data["operation_id"],
            data["child_item_id"],
            data.get("bom_line_id"),
            data.get("quantity", 1.0),
            data.get("unit_of_measure", "EA"),
            data.get("consumption_type", "component"),
            data.get("notes"),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def list_mfg_operation_consumptions(
        self, tenant_id: int, *, operation_id: int | None, child_item_id: int | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if operation_id is not None:
            args.append(operation_id)
            clauses.append(f"operation_id = ${len(args)}")
        if child_item_id is not None:
            args.append(child_item_id)
            clauses.append(f"child_item_id = ${len(args)}")
        args.append(limit)
        return await self._db.fetch(
            "SELECT id, tenant_id, operation_id, child_item_id, bom_line_id, "
            "quantity, unit_of_measure, consumption_type, notes, external_id, "
            "source_system, source_ref, created_at, updated_at "
            f"FROM ai.mfg_operation_consumptions WHERE {' AND '.join(clauses)} "
            f"ORDER BY id LIMIT ${len(args)}",
            *args,
        )

    async def delete_mfg_operation_consumption(
        self, tenant_id: int, consumption_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            "UPDATE ai.mfg_operation_consumptions SET deleted_at = now(), "
            "updated_at = now() WHERE tenant_id = $1 AND id = $2 "
            "AND deleted_at IS NULL "
            "RETURNING id, tenant_id, operation_id, child_item_id, bom_line_id, "
            "quantity, unit_of_measure, consumption_type, notes, created_at, updated_at",
            tenant_id,
            consumption_id,
        )

    async def upsert_mfg_work_instruction(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "mfg_work_instructions",
            ["tenant_id", "process_id", "operation_id", "instruction_key", "title",
             "description", "instruction_type", "revision", "lifecycle_status",
             "document_ref", "steps", "external_id", "source_system", "source_ref",
             "classification", "acl", "graph_entity_id", "created_by", "updated_by"],
            ("tenant_id", "instruction_key"),
            ["process_id", "operation_id", "title", "description",
             "instruction_type", "revision", "lifecycle_status", "document_ref",
             "steps", "external_id", "source_system", "source_ref", "classification",
             "acl", "graph_entity_id", "updated_by"],
            self._INSTRUCTION_COLUMNS,
            tenant_id,
            data["process_id"],
            data.get("operation_id"),
            data["instruction_key"],
            data.get("title"),
            data.get("description"),
            data.get("instruction_type", "text"),
            data.get("revision", "A"),
            data.get("lifecycle_status", "draft"),
            data.get("document_ref"),
            data.get("steps", []),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_mfg_work_instruction(
        self, tenant_id: int, instruction_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._INSTRUCTION_COLUMNS} FROM ai.mfg_work_instructions "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            instruction_id,
        )

    async def get_mfg_work_instruction_by_key(
        self, tenant_id: int, instruction_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._INSTRUCTION_COLUMNS} FROM ai.mfg_work_instructions "
            "WHERE tenant_id = $1 AND instruction_key = $2 AND deleted_at IS NULL",
            tenant_id,
            instruction_key,
        )

    async def list_mfg_work_instructions(
        self, tenant_id: int, *, process_id: int | None, operation_id: int | None,
        query: str | None, lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "mfg_work_instructions", self._INSTRUCTION_COLUMNS, tenant_id,
            filters=[
                ("process_id", process_id),
                ("operation_id", operation_id),
                ("lifecycle_status", lifecycle_status),
            ],
            query=query, query_columns=("instruction_key", "title"),
            limit=limit, offset=offset,
        )

    async def update_mfg_work_instruction(
        self, tenant_id: int, instruction_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "mfg_work_instructions", self._INSTRUCTION_COLUMNS, instruction_id,
            tenant_id, fields,
            {"operation_id", "title", "description", "instruction_type",
             "lifecycle_status", "document_ref", "steps", "source_ref",
             "classification", "acl", "graph_entity_id", "updated_by"},
        )

    async def upsert_mfg_resource(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "mfg_resources",
            ["tenant_id", "resource_key", "name", "description", "resource_kind",
             "plant_id", "work_centre_id", "lifecycle_status", "calibration_due",
             "attributes", "external_id", "source_system", "source_ref",
             "classification", "acl", "graph_entity_id", "created_by", "updated_by"],
            ("tenant_id", "resource_key"),
            ["name", "description", "resource_kind", "plant_id", "work_centre_id",
             "lifecycle_status", "calibration_due", "attributes", "external_id",
             "source_system", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"],
            self._RESOURCE_COLUMNS,
            tenant_id,
            data["resource_key"],
            data.get("name"),
            data.get("description"),
            data.get("resource_kind", "tooling"),
            data.get("plant_id"),
            data.get("work_centre_id"),
            data.get("lifecycle_status", "active"),
            data.get("calibration_due"),
            data.get("attributes", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_mfg_resource(
        self, tenant_id: int, resource_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._RESOURCE_COLUMNS} FROM ai.mfg_resources "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            resource_id,
        )

    async def get_mfg_resource_by_key(
        self, tenant_id: int, resource_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._RESOURCE_COLUMNS} FROM ai.mfg_resources "
            "WHERE tenant_id = $1 AND resource_key = $2 AND deleted_at IS NULL",
            tenant_id,
            resource_key,
        )

    async def list_mfg_resources(
        self, tenant_id: int, *, resource_kind: str | None, plant_id: int | None,
        query: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "mfg_resources", self._RESOURCE_COLUMNS, tenant_id,
            filters=[("resource_kind", resource_kind), ("plant_id", plant_id)],
            query=query, query_columns=("resource_key", "name"),
            limit=limit, offset=offset,
        )

    async def update_mfg_resource(
        self, tenant_id: int, resource_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "mfg_resources", self._RESOURCE_COLUMNS, resource_id, tenant_id, fields,
            {"name", "description", "resource_kind", "plant_id", "work_centre_id",
             "lifecycle_status", "calibration_due", "attributes", "source_ref",
             "classification", "acl", "graph_entity_id", "updated_by"},
        )

    async def upsert_mfg_production_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "mfg_production_versions",
            ["tenant_id", "item_id", "process_id", "mbom_header_id", "version_key",
             "name", "lifecycle_status", "effectivity_from", "effectivity_to",
             "plant_id", "configuration", "external_id", "source_system",
             "source_ref", "classification", "acl", "graph_entity_id", "created_by",
             "updated_by"],
            ("tenant_id", "item_id", "version_key"),
            ["process_id", "mbom_header_id", "name", "lifecycle_status",
             "effectivity_from", "effectivity_to", "plant_id", "configuration",
             "external_id", "source_system", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"],
            self._PRODUCTION_VERSION_COLUMNS,
            tenant_id,
            data["item_id"],
            data.get("process_id"),
            data.get("mbom_header_id"),
            data["version_key"],
            data.get("name"),
            data.get("lifecycle_status", "draft"),
            data.get("effectivity_from"),
            data.get("effectivity_to"),
            data.get("plant_id"),
            data.get("configuration", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_mfg_production_version(
        self, tenant_id: int, production_version_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PRODUCTION_VERSION_COLUMNS} "
            "FROM ai.mfg_production_versions "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            production_version_id,
        )

    async def get_mfg_production_version_by_key(
        self, tenant_id: int, item_id: int, version_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PRODUCTION_VERSION_COLUMNS} "
            "FROM ai.mfg_production_versions "
            "WHERE tenant_id = $1 AND item_id = $2 AND version_key = $3 "
            "AND deleted_at IS NULL",
            tenant_id,
            item_id,
            version_key,
        )

    async def list_mfg_production_versions(
        self, tenant_id: int, *, item_id: int | None, process_id: int | None,
        lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "mfg_production_versions", self._PRODUCTION_VERSION_COLUMNS, tenant_id,
            filters=[
                ("item_id", item_id),
                ("process_id", process_id),
                ("lifecycle_status", lifecycle_status),
            ],
            query=None, query_columns=(), limit=limit, offset=offset,
        )

    async def update_mfg_production_version(
        self, tenant_id: int, production_version_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "mfg_production_versions", self._PRODUCTION_VERSION_COLUMNS,
            production_version_id, tenant_id, fields,
            {"process_id", "mbom_header_id", "name", "lifecycle_status",
             "effectivity_from", "effectivity_to", "plant_id", "configuration",
             "source_ref", "classification", "acl", "graph_entity_id", "updated_by"},
        )

    async def upsert_quality_issue(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "quality_issues",
            ["tenant_id", "issue_key", "title", "description", "issue_type",
             "severity", "status", "disposition", "product_item_id",
             "component_item_id", "process_id", "operation_id", "plant_id",
             "work_centre_id", "supplier_ref", "failure_code", "detected_at",
             "detected_by", "root_cause_status", "attributes", "external_id",
             "source_system", "source_ref", "classification", "acl",
             "graph_entity_id", "created_by", "updated_by"],
            ("tenant_id", "issue_key"),
            ["title", "description", "issue_type", "severity", "status",
             "disposition", "product_item_id", "component_item_id", "process_id",
             "operation_id", "plant_id", "work_centre_id", "supplier_ref",
             "failure_code", "detected_at", "detected_by", "root_cause_status",
             "attributes", "external_id", "source_system", "source_ref",
             "classification", "acl", "graph_entity_id", "updated_by"],
            self._ISSUE_COLUMNS,
            tenant_id,
            data["issue_key"],
            data.get("title"),
            data.get("description"),
            data.get("issue_type", "nonconformance"),
            data.get("severity", "medium"),
            data.get("status", "open"),
            data.get("disposition", "none"),
            data.get("product_item_id"),
            data.get("component_item_id"),
            data.get("process_id"),
            data.get("operation_id"),
            data.get("plant_id"),
            data.get("work_centre_id"),
            data.get("supplier_ref"),
            data.get("failure_code"),
            data.get("detected_at"),
            data.get("detected_by"),
            data.get("root_cause_status", "not_investigated"),
            data.get("attributes", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_quality_issue(
        self, tenant_id: int, issue_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._ISSUE_COLUMNS} FROM ai.quality_issues "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            issue_id,
        )

    async def get_quality_issue_by_key(
        self, tenant_id: int, issue_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._ISSUE_COLUMNS} FROM ai.quality_issues "
            "WHERE tenant_id = $1 AND issue_key = $2 AND deleted_at IS NULL",
            tenant_id,
            issue_key,
        )

    async def list_quality_issues(
        self, tenant_id: int, *, status: str | None, severity: str | None,
        issue_type: str | None, component_item_id: int | None,
        product_item_id: int | None, supplier_ref: str | None, plant_id: int | None,
        operation_id: int | None, query: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "quality_issues", self._ISSUE_COLUMNS, tenant_id,
            filters=[
                ("status", status),
                ("severity", severity),
                ("issue_type", issue_type),
                ("component_item_id", component_item_id),
                ("product_item_id", product_item_id),
                ("supplier_ref", supplier_ref),
                ("plant_id", plant_id),
                ("operation_id", operation_id),
            ],
            query=query, query_columns=("issue_key", "title", "failure_code"),
            limit=limit, offset=offset,
        )

    async def update_quality_issue(
        self, tenant_id: int, issue_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "quality_issues", self._ISSUE_COLUMNS, issue_id, tenant_id, fields,
            {"title", "description", "issue_type", "severity", "status",
             "disposition", "product_item_id", "component_item_id", "process_id",
             "operation_id", "plant_id", "work_centre_id", "supplier_ref",
             "failure_code", "detected_at", "detected_by", "root_cause_status",
             "attributes", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"},
        )

    async def upsert_quality_inspection(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "quality_inspections",
            ["tenant_id", "inspection_key", "title", "description",
             "inspection_type", "status", "product_item_id", "component_item_id",
             "operation_id", "plant_id", "work_centre_id", "quality_issue_id",
             "characteristic", "sample_size", "passed_count", "failed_count",
             "performed_by", "performed_at", "result", "attributes", "external_id",
             "source_system", "source_ref", "classification", "acl",
             "graph_entity_id", "created_by", "updated_by"],
            ("tenant_id", "inspection_key"),
            ["title", "description", "inspection_type", "status", "product_item_id",
             "component_item_id", "operation_id", "plant_id", "work_centre_id",
             "quality_issue_id", "characteristic", "sample_size", "passed_count",
             "failed_count", "performed_by", "performed_at", "result", "attributes",
             "external_id", "source_system", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"],
            self._INSPECTION_COLUMNS,
            tenant_id,
            data["inspection_key"],
            data.get("title"),
            data.get("description"),
            data.get("inspection_type", "incoming"),
            data.get("status", "planned"),
            data.get("product_item_id"),
            data.get("component_item_id"),
            data.get("operation_id"),
            data.get("plant_id"),
            data.get("work_centre_id"),
            data.get("quality_issue_id"),
            data.get("characteristic"),
            data.get("sample_size"),
            data.get("passed_count"),
            data.get("failed_count"),
            data.get("performed_by"),
            data.get("performed_at"),
            data.get("result", {}),
            data.get("attributes", {}),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_quality_inspection(
        self, tenant_id: int, inspection_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._INSPECTION_COLUMNS} FROM ai.quality_inspections "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            inspection_id,
        )

    async def get_quality_inspection_by_key(
        self, tenant_id: int, inspection_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._INSPECTION_COLUMNS} FROM ai.quality_inspections "
            "WHERE tenant_id = $1 AND inspection_key = $2 AND deleted_at IS NULL",
            tenant_id,
            inspection_key,
        )

    async def list_quality_inspections(
        self, tenant_id: int, *, status: str | None, inspection_type: str | None,
        quality_issue_id: int | None, operation_id: int | None, query: str | None,
        limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "quality_inspections", self._INSPECTION_COLUMNS, tenant_id,
            filters=[
                ("status", status),
                ("inspection_type", inspection_type),
                ("quality_issue_id", quality_issue_id),
                ("operation_id", operation_id),
            ],
            query=query, query_columns=("inspection_key", "title"),
            limit=limit, offset=offset,
        )

    async def update_quality_inspection(
        self, tenant_id: int, inspection_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "quality_inspections", self._INSPECTION_COLUMNS, inspection_id, tenant_id,
            fields,
            {"title", "description", "status", "operation_id", "plant_id",
             "work_centre_id", "quality_issue_id", "characteristic", "sample_size",
             "passed_count", "failed_count", "performed_by", "performed_at",
             "result", "attributes", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"},
        )

    async def add_quality_inspection_result(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.quality_inspection_results
                (tenant_id, inspection_id, characteristic, measured_value, result,
                 defect_code, defect_category, notes, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, tenant_id, inspection_id, characteristic, measured_value,
                      result, defect_code, defect_category, notes, created_by,
                      created_at
            """,
            tenant_id,
            data["inspection_id"],
            data["characteristic"],
            data.get("measured_value"),
            data.get("result", "unknown"),
            data.get("defect_code"),
            data.get("defect_category"),
            data.get("notes"),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def list_quality_inspection_results(
        self, tenant_id: int, *, inspection_id: int, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            "SELECT id, tenant_id, inspection_id, characteristic, measured_value, "
            "result, defect_code, defect_category, notes, created_by, created_at "
            "FROM ai.quality_inspection_results "
            "WHERE tenant_id = $1 AND inspection_id = $2 ORDER BY id LIMIT $3",
            tenant_id,
            inspection_id,
            limit,
        )

    async def add_quality_root_cause(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.quality_root_causes
                (tenant_id, quality_issue_id, classification, description,
                 is_hypothesis, confirmed, confidence, evidence, created_by,
                 updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
            RETURNING id, tenant_id, quality_issue_id, classification, description,
                      is_hypothesis, confirmed, confidence, evidence, created_by,
                      updated_by, created_at, updated_at
            """,
            tenant_id,
            data["quality_issue_id"],
            data.get("classification", "other"),
            data.get("description", ""),
            data.get("is_hypothesis", True),
            data.get("confirmed", False),
            data.get("confidence"),
            data.get("evidence", []),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def get_quality_root_cause(
        self, tenant_id: int, root_cause_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            "SELECT id, tenant_id, quality_issue_id, classification, description, "
            "is_hypothesis, confirmed, confidence, evidence, created_by, updated_by, "
            "created_at, updated_at FROM ai.quality_root_causes "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            root_cause_id,
        )

    async def list_quality_root_causes(
        self, tenant_id: int, *, quality_issue_id: int, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            "SELECT id, tenant_id, quality_issue_id, classification, description, "
            "is_hypothesis, confirmed, confidence, evidence, created_by, updated_by, "
            "created_at, updated_at FROM ai.quality_root_causes "
            "WHERE tenant_id = $1 AND quality_issue_id = $2 AND deleted_at IS NULL "
            "ORDER BY id LIMIT $3",
            tenant_id,
            quality_issue_id,
            limit,
        )

    async def update_quality_root_cause(
        self, tenant_id: int, root_cause_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "quality_root_causes",
            "id, tenant_id, quality_issue_id, classification, description, "
            "is_hypothesis, confirmed, confidence, evidence, created_by, updated_by, "
            "created_at, updated_at",
            root_cause_id,
            tenant_id,
            fields,
            {"classification", "description", "is_hypothesis", "confirmed",
             "confidence", "evidence", "updated_by"},
            increment_version=False,
        )

    async def upsert_quality_action(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "quality_actions",
            ["tenant_id", "action_key", "quality_issue_id", "title", "description",
             "action_type", "status", "root_cause_id", "owner_user", "due_at",
             "implemented_at", "verified_at", "verified_by", "effectiveness",
             "evidence", "external_id", "source_system", "source_ref",
             "classification", "acl", "graph_entity_id", "created_by", "updated_by"],
            ("tenant_id", "action_key"),
            ["quality_issue_id", "title", "description", "action_type", "status",
             "root_cause_id", "owner_user", "due_at", "implemented_at",
             "verified_at", "verified_by", "effectiveness", "evidence",
             "external_id", "source_system", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"],
            self._QUALITY_ACTION_COLUMNS,
            tenant_id,
            data["action_key"],
            data["quality_issue_id"],
            data.get("title"),
            data.get("description"),
            data.get("action_type", "corrective"),
            data.get("status", "open"),
            data.get("root_cause_id"),
            data.get("owner_user"),
            data.get("due_at"),
            data.get("implemented_at"),
            data.get("verified_at"),
            data.get("verified_by"),
            data.get("effectiveness", "pending"),
            data.get("evidence", []),
            data.get("external_id"),
            data.get("source_system"),
            data.get("source_ref"),
            data.get("classification", "internal"),
            data.get("acl", {}),
            data.get("graph_entity_id"),
            data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_quality_action(
        self, tenant_id: int, action_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._QUALITY_ACTION_COLUMNS} FROM ai.quality_actions "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id,
            action_id,
        )

    async def get_quality_action_by_key(
        self, tenant_id: int, action_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._QUALITY_ACTION_COLUMNS} FROM ai.quality_actions "
            "WHERE tenant_id = $1 AND action_key = $2 AND deleted_at IS NULL",
            tenant_id,
            action_key,
        )

    async def list_quality_actions(
        self, tenant_id: int, *, quality_issue_id: int | None, status: str | None,
        action_type: str | None, owner_user: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "quality_actions", self._QUALITY_ACTION_COLUMNS, tenant_id,
            filters=[
                ("quality_issue_id", quality_issue_id),
                ("status", status),
                ("action_type", action_type),
                ("owner_user", owner_user),
            ],
            query=None, query_columns=(), limit=limit, offset=offset,
        )

    async def update_quality_action(
        self, tenant_id: int, action_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "quality_actions", self._QUALITY_ACTION_COLUMNS, action_id, tenant_id, fields,
            {"title", "description", "action_type", "status", "root_cause_id",
             "owner_user", "due_at", "implemented_at", "verified_at", "verified_by",
             "effectiveness", "evidence", "source_ref", "classification", "acl",
             "graph_entity_id", "updated_by"},
        )

    async def add_quality_supplier_issue(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.quality_supplier_issues
                (tenant_id, quality_issue_id, supplier_ref, supplier_name,
                 component_item_id, defect_category, quantity_affected,
                 containment_ref, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, tenant_id, quality_issue_id, supplier_ref, supplier_name,
                      component_item_id, defect_category, quantity_affected,
                      containment_ref, created_by, created_at, updated_at
            """,
            tenant_id,
            data["quality_issue_id"],
            data["supplier_ref"],
            data.get("supplier_name"),
            data.get("component_item_id"),
            data.get("defect_category"),
            data.get("quantity_affected"),
            data.get("containment_ref"),
            data.get("created_by"),
        )
        assert row is not None
        return row

    async def list_quality_supplier_issues(
        self, tenant_id: int, *, supplier_ref: str | None, limit: int
    ) -> list[dict[str, Any]]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if supplier_ref is not None:
            args.append(supplier_ref)
            clauses.append(f"supplier_ref = ${len(args)}")
        args.append(limit)
        return await self._db.fetch(
            "SELECT id, tenant_id, quality_issue_id, supplier_ref, supplier_name, "
            "component_item_id, defect_category, quantity_affected, containment_ref, "
            "created_by, created_at, updated_at FROM ai.quality_supplier_issues "
            f"WHERE {' AND '.join(clauses)} ORDER BY id DESC LIMIT ${len(args)}",
            *args,
        )

    # --- Predictive intelligence (Stage 10) ---------------------------
    _FEATURE_DEFINITION_COLUMNS = (
        "id, tenant_id, feature_key, name, description, entity_type, data_type, "
        "source_system, extraction_spec, freshness_ttl_hours, lifecycle_status, "
        "attributes, classification, acl, version, created_by, updated_by, "
        "created_at, updated_at, deleted_at"
    )
    _FEATURE_VALUE_COLUMNS = (
        "id, tenant_id, feature_key, entity_type, entity_id, entity_key, value, "
        "observed_at, source_system, source_ref, lineage, freshness_expires_at, "
        "created_at, updated_at, deleted_at"
    )
    _DATASET_COLUMNS = (
        "id, tenant_id, dataset_key, name, description, prediction_type, "
        "feature_keys, source_window, lifecycle_status, attributes, classification, "
        "acl, version, created_by, updated_by, created_at, updated_at, deleted_at"
    )
    _DATASET_VERSION_COLUMNS = (
        "id, tenant_id, dataset_id, version, split, row_count, class_balance, "
        "filters, lifecycle_status, checksum, created_by, created_at, updated_at, "
        "deleted_at"
    )
    _PREDICTIVE_MODEL_COLUMNS = (
        "id, tenant_id, model_key, name, description, prediction_type, method, "
        "lifecycle_status, attributes, classification, acl, version, created_by, "
        "updated_by, created_at, updated_at, deleted_at"
    )
    _PREDICTIVE_MODEL_VERSION_COLUMNS = (
        "id, tenant_id, model_id, version, method, ruleset_version, config, metrics, "
        "dataset_version_id, lifecycle_status, trained_at, created_by, created_at, "
        "updated_at, deleted_at"
    )
    _PREDICTION_COLUMNS = (
        "id, tenant_id, prediction_key, prediction_type, subject_type, subject_id, "
        "subject_key, risk_category, score, severity, method, model_version, "
        "ruleset_version, confidence, uncertainty, contributing_factors, evidence, "
        "explanation, data_freshness, limitations, observation_window, status, "
        "freshness_expires_at, idempotency_key, generated_at, classification, acl, "
        "graph_entity_id, version, created_by, updated_by, created_at, updated_at, "
        "deleted_at"
    )
    _RECOMMENDATION_COLUMNS = (
        "id, tenant_id, recommendation_key, prediction_id, title, description, "
        "rationale, category, severity, priority, status, suggested_action, "
        "owner_role, affected_entity_type, affected_entity_id, affected_entity_key, "
        "evidence, due_at, reviewed_by, reviewed_at, outcome, risk_before, "
        "risk_after, risk_reduced, idempotency_key, classification, acl, "
        "graph_entity_id, version, created_by, updated_by, created_at, updated_at, "
        "deleted_at"
    )
    _RECOMMENDATION_FEEDBACK_COLUMNS = (
        "id, tenant_id, recommendation_id, reviewer, decision, comment, outcome, "
        "risk_before, risk_after, created_at"
    )
    _PREDICTIVE_SCHEDULE_COLUMNS = (
        "id, tenant_id, schedule_key, prediction_type, subject_type, subject_scope, "
        "interval_seconds, enabled, next_run_at, last_run_at, last_prediction_id, "
        "created_by, updated_by, created_at, updated_at, deleted_at"
    )

    async def upsert_predictive_feature_definition(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "predictive_feature_definitions",
            ["tenant_id", "feature_key", "name", "description", "entity_type",
             "data_type", "source_system", "extraction_spec", "freshness_ttl_hours",
             "lifecycle_status", "attributes", "classification", "acl",
             "created_by", "updated_by"],
            ("tenant_id", "feature_key"),
            ["name", "description", "entity_type", "data_type", "source_system",
             "extraction_spec", "freshness_ttl_hours", "lifecycle_status",
             "attributes", "classification", "acl", "updated_by"],
            self._FEATURE_DEFINITION_COLUMNS,
            tenant_id, data["feature_key"], data.get("name"), data.get("description"),
            data.get("entity_type", "any"), data.get("data_type", "number"),
            data.get("source_system"), data.get("extraction_spec", {}),
            data.get("freshness_ttl_hours", 168),
            data.get("lifecycle_status", "active"), data.get("attributes", {}),
            data.get("classification", "internal"), data.get("acl", {}),
            data.get("created_by"), data.get("updated_by") or data.get("created_by"),
        )

    async def get_predictive_feature_definition(
        self, tenant_id: int, feature_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._FEATURE_DEFINITION_COLUMNS} FROM "
            "ai.predictive_feature_definitions WHERE tenant_id = $1 AND id = $2 "
            "AND deleted_at IS NULL",
            tenant_id, feature_id,
        )

    async def get_predictive_feature_definition_by_key(
        self, tenant_id: int, feature_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._FEATURE_DEFINITION_COLUMNS} FROM "
            "ai.predictive_feature_definitions WHERE tenant_id = $1 AND "
            "feature_key = $2 AND deleted_at IS NULL",
            tenant_id, feature_key,
        )

    async def list_predictive_feature_definitions(
        self, tenant_id: int, *, entity_type: str | None,
        lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "predictive_feature_definitions", self._FEATURE_DEFINITION_COLUMNS,
            tenant_id,
            filters=[("entity_type", entity_type),
                     ("lifecycle_status", lifecycle_status)],
            query="", query_columns=("feature_key", "name"),
            limit=limit, offset=offset,
        )

    async def update_predictive_feature_definition(
        self, tenant_id: int, feature_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "predictive_feature_definitions", self._FEATURE_DEFINITION_COLUMNS,
            feature_id, tenant_id, fields,
            {"name", "description", "entity_type", "data_type", "source_system",
             "extraction_spec", "freshness_ttl_hours", "lifecycle_status",
             "attributes", "classification", "acl", "updated_by"},
        )

    async def upsert_predictive_feature_value(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "predictive_feature_values",
            ["tenant_id", "feature_key", "entity_type", "entity_id", "entity_key",
             "value", "observed_at", "source_system", "source_ref", "lineage",
             "freshness_expires_at"],
            ("tenant_id", "feature_key", "entity_type", "entity_id"),
            ["entity_key", "value", "observed_at", "source_system", "source_ref",
             "lineage", "freshness_expires_at"],
            self._FEATURE_VALUE_COLUMNS,
            tenant_id, data["feature_key"], data["entity_type"], data["entity_id"],
            data.get("entity_key"), data.get("value"), data.get("observed_at"),
            data.get("source_system"), data.get("source_ref"),
            data.get("lineage", []), data.get("freshness_expires_at"),
            has_version=False,
        )

    async def list_predictive_feature_values(
        self, tenant_id: int, *, feature_key: str | None, entity_type: str | None,
        entity_id: int | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "predictive_feature_values", self._FEATURE_VALUE_COLUMNS, tenant_id,
            filters=[
                ("feature_key", feature_key),
                ("entity_type", entity_type),
                ("entity_id", entity_id),
            ],
            query="", query_columns=("feature_key", "entity_key"),
            limit=limit, offset=offset, order_by="observed_at DESC, id DESC",
        )

    async def upsert_predictive_dataset(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "predictive_datasets",
            ["tenant_id", "dataset_key", "name", "description", "prediction_type",
             "feature_keys", "source_window", "lifecycle_status", "attributes",
             "classification", "acl", "created_by", "updated_by"],
            ("tenant_id", "dataset_key"),
            ["name", "description", "prediction_type", "feature_keys",
             "source_window", "lifecycle_status", "attributes", "classification",
             "acl", "updated_by"],
            self._DATASET_COLUMNS,
            tenant_id, data["dataset_key"], data.get("name"), data.get("description"),
            data.get("prediction_type"), data.get("feature_keys", []),
            data.get("source_window", {}), data.get("lifecycle_status", "draft"),
            data.get("attributes", {}), data.get("classification", "internal"),
            data.get("acl", {}), data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_predictive_dataset(
        self, tenant_id: int, dataset_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._DATASET_COLUMNS} FROM ai.predictive_datasets "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id, dataset_id,
        )

    async def get_predictive_dataset_by_key(
        self, tenant_id: int, dataset_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._DATASET_COLUMNS} FROM ai.predictive_datasets "
            "WHERE tenant_id = $1 AND dataset_key = $2 AND deleted_at IS NULL",
            tenant_id, dataset_key,
        )

    async def list_predictive_datasets(
        self, tenant_id: int, *, lifecycle_status: str | None,
        limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "predictive_datasets", self._DATASET_COLUMNS, tenant_id,
            filters=[("lifecycle_status", lifecycle_status)],
            query="", query_columns=("dataset_key", "name"),
            limit=limit, offset=offset,
        )

    async def update_predictive_dataset(
        self, tenant_id: int, dataset_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "predictive_datasets", self._DATASET_COLUMNS, dataset_id, tenant_id,
            fields,
            {"name", "description", "prediction_type", "feature_keys",
             "source_window", "lifecycle_status", "attributes", "classification",
             "acl", "updated_by"},
        )

    async def upsert_predictive_dataset_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "predictive_dataset_versions",
            ["tenant_id", "dataset_id", "version", "split", "row_count",
             "class_balance", "filters", "lifecycle_status", "checksum", "created_by"],
            ("tenant_id", "dataset_id", "version", "split"),
            ["row_count", "class_balance", "filters", "lifecycle_status", "checksum"],
            self._DATASET_VERSION_COLUMNS,
            tenant_id, data["dataset_id"], data.get("version", 1),
            data.get("split", "train"), data.get("row_count", 0),
            data.get("class_balance", {}), data.get("filters", {}),
            data.get("lifecycle_status", "draft"), data.get("checksum"),
            data.get("created_by"),
            has_version=False,
        )

    async def list_predictive_dataset_versions(
        self, tenant_id: int, *, dataset_id: int, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"SELECT {self._DATASET_VERSION_COLUMNS} FROM "
            "ai.predictive_dataset_versions WHERE tenant_id = $1 AND dataset_id = $2 "
            "AND deleted_at IS NULL ORDER BY version DESC, id DESC LIMIT $3",
            tenant_id, dataset_id, limit,
        )

    async def upsert_predictive_model(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "predictive_models",
            ["tenant_id", "model_key", "name", "description", "prediction_type",
             "method", "lifecycle_status", "attributes", "classification", "acl",
             "created_by", "updated_by"],
            ("tenant_id", "model_key"),
            ["name", "description", "prediction_type", "method", "lifecycle_status",
             "attributes", "classification", "acl", "updated_by"],
            self._PREDICTIVE_MODEL_COLUMNS,
            tenant_id, data["model_key"], data.get("name"), data.get("description"),
            data["prediction_type"], data.get("method", "rule_based"),
            data.get("lifecycle_status", "draft"), data.get("attributes", {}),
            data.get("classification", "internal"), data.get("acl", {}),
            data.get("created_by"), data.get("updated_by") or data.get("created_by"),
        )

    async def get_predictive_model(
        self, tenant_id: int, model_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PREDICTIVE_MODEL_COLUMNS} FROM ai.predictive_models "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id, model_id,
        )

    async def get_predictive_model_by_key(
        self, tenant_id: int, model_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PREDICTIVE_MODEL_COLUMNS} FROM ai.predictive_models "
            "WHERE tenant_id = $1 AND model_key = $2 AND deleted_at IS NULL",
            tenant_id, model_key,
        )

    async def list_predictive_models(
        self, tenant_id: int, *, prediction_type: str | None,
        lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "predictive_models", self._PREDICTIVE_MODEL_COLUMNS, tenant_id,
            filters=[("prediction_type", prediction_type),
                     ("lifecycle_status", lifecycle_status)],
            query="", query_columns=("model_key", "name"),
            limit=limit, offset=offset,
        )

    async def update_predictive_model(
        self, tenant_id: int, model_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "predictive_models", self._PREDICTIVE_MODEL_COLUMNS, model_id, tenant_id,
            fields,
            {"name", "description", "prediction_type", "method", "lifecycle_status",
             "attributes", "classification", "acl", "updated_by"},
        )

    async def upsert_predictive_model_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "predictive_model_versions",
            ["tenant_id", "model_id", "version", "method", "ruleset_version",
             "config", "metrics", "dataset_version_id", "lifecycle_status",
             "trained_at", "created_by"],
            ("tenant_id", "model_id", "version"),
            ["method", "ruleset_version", "config", "metrics", "dataset_version_id",
             "lifecycle_status", "trained_at"],
            self._PREDICTIVE_MODEL_VERSION_COLUMNS,
            tenant_id, data["model_id"], data["version"],
            data.get("method", "rule_based"), data.get("ruleset_version", ""),
            data.get("config", {}), data.get("metrics", {}),
            data.get("dataset_version_id"), data.get("lifecycle_status", "draft"),
            data.get("trained_at"), data.get("created_by"),
            has_version=False,
        )

    async def list_predictive_model_versions(
        self, tenant_id: int, *, model_id: int, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"SELECT {self._PREDICTIVE_MODEL_VERSION_COLUMNS} FROM "
            "ai.predictive_model_versions WHERE tenant_id = $1 AND model_id = $2 "
            "AND deleted_at IS NULL ORDER BY id DESC LIMIT $3",
            tenant_id, model_id, limit,
        )

    async def upsert_predictive_prediction(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "predictive_predictions",
            ["tenant_id", "prediction_key", "prediction_type", "subject_type",
             "subject_id", "subject_key", "risk_category", "score", "severity",
             "method", "model_version", "ruleset_version", "confidence",
             "uncertainty", "contributing_factors", "evidence", "explanation",
             "data_freshness", "limitations", "observation_window", "status",
             "freshness_expires_at", "idempotency_key", "classification", "acl",
             "graph_entity_id", "created_by", "updated_by"],
            ("tenant_id", "prediction_key"),
            ["prediction_type", "subject_type", "subject_id", "subject_key",
             "risk_category", "score", "severity", "method", "model_version",
             "ruleset_version", "confidence", "uncertainty", "contributing_factors",
             "evidence", "explanation", "data_freshness", "limitations",
             "observation_window", "status", "freshness_expires_at",
             "idempotency_key", "classification", "acl", "graph_entity_id",
             "updated_by"],
            self._PREDICTION_COLUMNS,
            tenant_id, data["prediction_key"], data["prediction_type"],
            data["subject_type"], data.get("subject_id"), data.get("subject_key"),
            data.get("risk_category", "unknown"), data.get("score"),
            data.get("severity", "unknown"), data.get("method", "rule_based"),
            data.get("model_version", ""), data.get("ruleset_version", ""),
            data.get("confidence"), data.get("uncertainty", {}),
            data.get("contributing_factors", []), data.get("evidence", []),
            data.get("explanation", ""), data.get("data_freshness", {}),
            data.get("limitations", []), data.get("observation_window", {}),
            data.get("status", "active"), data.get("freshness_expires_at"),
            data.get("idempotency_key"), data.get("classification", "internal"),
            data.get("acl", {}), data.get("graph_entity_id"),
            data.get("created_by"), data.get("updated_by") or data.get("created_by"),
        )

    async def get_predictive_prediction(
        self, tenant_id: int, prediction_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PREDICTION_COLUMNS} FROM ai.predictive_predictions "
            "WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
            tenant_id, prediction_id,
        )

    async def get_predictive_prediction_by_key(
        self, tenant_id: int, prediction_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PREDICTION_COLUMNS} FROM ai.predictive_predictions "
            "WHERE tenant_id = $1 AND prediction_key = $2 AND deleted_at IS NULL",
            tenant_id, prediction_key,
        )

    async def find_predictive_prediction_by_idempotency(
        self, tenant_id: int, idempotency_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PREDICTION_COLUMNS} FROM ai.predictive_predictions "
            "WHERE tenant_id = $1 AND idempotency_key = $2 AND deleted_at IS NULL",
            tenant_id, idempotency_key,
        )

    async def list_predictive_predictions(
        self, tenant_id: int, *, prediction_type: str | None,
        subject_type: str | None, subject_id: int | None,
        risk_category: str | None, status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return await self._mq_list(
            "predictive_predictions", self._PREDICTION_COLUMNS, tenant_id,
            filters=[
                ("prediction_type", prediction_type),
                ("subject_type", subject_type),
                ("subject_id", subject_id),
                ("risk_category", risk_category),
                ("status", status),
            ],
            query="", query_columns=("prediction_key", "subject_key"),
            limit=limit, offset=offset, order_by="generated_at DESC, id DESC",
        )

    async def update_predictive_prediction(
        self, tenant_id: int, prediction_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "predictive_predictions", self._PREDICTION_COLUMNS, prediction_id,
            tenant_id, fields,
            {"status", "risk_category", "score", "severity", "explanation",
             "freshness_expires_at", "graph_entity_id", "updated_by"},
        )

    async def upsert_predictive_recommendation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "predictive_recommendations",
            ["tenant_id", "recommendation_key", "prediction_id", "title",
             "description", "rationale", "category", "severity", "priority",
             "status", "suggested_action", "owner_role", "affected_entity_type",
             "affected_entity_id", "affected_entity_key", "evidence", "due_at",
             "risk_before", "risk_after", "risk_reduced", "idempotency_key",
             "classification", "acl", "graph_entity_id", "created_by", "updated_by"],
            ("tenant_id", "recommendation_key"),
            ["prediction_id", "title", "description", "rationale", "category",
             "severity", "priority", "status", "suggested_action", "owner_role",
             "affected_entity_type", "affected_entity_id", "affected_entity_key",
             "evidence", "due_at", "risk_before", "risk_after", "risk_reduced",
             "idempotency_key", "classification", "acl", "graph_entity_id",
             "updated_by"],
            self._RECOMMENDATION_COLUMNS,
            tenant_id, data["recommendation_key"], data.get("prediction_id"),
            data["title"], data.get("description"), data.get("rationale", ""),
            data.get("category"), data.get("severity", "medium"),
            data.get("priority", "medium"), data.get("status", "new"),
            data.get("suggested_action"), data.get("owner_role"),
            data.get("affected_entity_type"), data.get("affected_entity_id"),
            data.get("affected_entity_key"), data.get("evidence", []),
            data.get("due_at"), data.get("risk_before"), data.get("risk_after"),
            data.get("risk_reduced"), data.get("idempotency_key"),
            data.get("classification", "internal"), data.get("acl", {}),
            data.get("graph_entity_id"), data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
        )

    async def get_predictive_recommendation(
        self, tenant_id: int, recommendation_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._RECOMMENDATION_COLUMNS} FROM "
            "ai.predictive_recommendations WHERE tenant_id = $1 AND id = $2 "
            "AND deleted_at IS NULL",
            tenant_id, recommendation_id,
        )

    async def get_predictive_recommendation_by_key(
        self, tenant_id: int, recommendation_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._RECOMMENDATION_COLUMNS} FROM "
            "ai.predictive_recommendations WHERE tenant_id = $1 AND "
            "recommendation_key = $2 AND deleted_at IS NULL",
            tenant_id, recommendation_key,
        )

    async def find_predictive_recommendation_by_idempotency(
        self, tenant_id: int, idempotency_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._RECOMMENDATION_COLUMNS} FROM "
            "ai.predictive_recommendations WHERE tenant_id = $1 AND "
            "idempotency_key = $2 AND deleted_at IS NULL",
            tenant_id, idempotency_key,
        )

    async def list_predictive_recommendations(
        self, tenant_id: int, *, status: str | None, severity: str | None,
        priority: str | None, prediction_id: int | None,
        owner_role: str | None, overdue_only: bool, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        for column, value in (
            ("status", status), ("severity", severity), ("priority", priority),
            ("prediction_id", prediction_id), ("owner_role", owner_role),
        ):
            if value is not None:
                args.append(value)
                clauses.append(f"{column} = ${len(args)}")
        if overdue_only:
            clauses.append("due_at IS NOT NULL AND due_at < now()")
            clauses.append("status IN ('new','under_review','accepted','deferred')")
        where = " AND ".join(clauses)
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.predictive_recommendations WHERE {where}", *args
        )
        args.append(limit)
        args.append(offset)
        rows = await self._db.fetch(
            f"SELECT {self._RECOMMENDATION_COLUMNS} FROM "
            f"ai.predictive_recommendations WHERE {where} "
            f"ORDER BY created_at DESC, id DESC LIMIT ${len(args) - 1} "
            f"OFFSET ${len(args)}",
            *args,
        )
        return rows, int(total or 0)

    async def update_predictive_recommendation(
        self, tenant_id: int, recommendation_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "predictive_recommendations", self._RECOMMENDATION_COLUMNS,
            recommendation_id, tenant_id, fields,
            {"status", "title", "description", "rationale", "severity", "priority",
             "suggested_action", "owner_role", "due_at", "reviewed_by", "reviewed_at",
             "outcome", "risk_before", "risk_after", "risk_reduced",
             "graph_entity_id", "updated_by"},
        )

    async def add_predictive_recommendation_feedback(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.predictive_recommendation_feedback
                (tenant_id, recommendation_id, reviewer, decision, comment, outcome,
                 risk_before, risk_after)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, tenant_id, recommendation_id, reviewer, decision, comment,
                      outcome, risk_before, risk_after, created_at
            """,
            tenant_id, data["recommendation_id"], data.get("reviewer"),
            data.get("decision", "comment"), data.get("comment", ""),
            data.get("outcome"), data.get("risk_before"), data.get("risk_after"),
        )
        assert row is not None
        return row

    async def list_predictive_recommendation_feedback(
        self, tenant_id: int, *, recommendation_id: int, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"SELECT {self._RECOMMENDATION_FEEDBACK_COLUMNS} FROM "
            "ai.predictive_recommendation_feedback WHERE tenant_id = $1 AND "
            "recommendation_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3",
            tenant_id, recommendation_id, limit,
        )

    async def upsert_predictive_schedule(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._mq_insert_upsert(
            "predictive_schedules",
            ["tenant_id", "schedule_key", "prediction_type", "subject_type",
             "subject_scope", "interval_seconds", "enabled", "next_run_at",
             "last_run_at", "last_prediction_id", "created_by", "updated_by"],
            ("tenant_id", "schedule_key"),
            ["prediction_type", "subject_type", "subject_scope", "interval_seconds",
             "enabled", "next_run_at", "last_run_at", "last_prediction_id",
             "updated_by"],
            self._PREDICTIVE_SCHEDULE_COLUMNS,
            tenant_id, data["schedule_key"], data["prediction_type"],
            data["subject_type"], data.get("subject_scope", {}),
            data.get("interval_seconds", 86400), data.get("enabled", True),
            data.get("next_run_at"), data.get("last_run_at"),
            data.get("last_prediction_id"), data.get("created_by"),
            data.get("updated_by") or data.get("created_by"),
            has_version=False,
        )

    async def get_predictive_schedule(
        self, tenant_id: int, schedule_id: int
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PREDICTIVE_SCHEDULE_COLUMNS} FROM "
            "ai.predictive_schedules WHERE tenant_id = $1 AND id = $2 "
            "AND deleted_at IS NULL",
            tenant_id, schedule_id,
        )

    async def get_predictive_schedule_by_key(
        self, tenant_id: int, schedule_key: str
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            f"SELECT {self._PREDICTIVE_SCHEDULE_COLUMNS} FROM "
            "ai.predictive_schedules WHERE tenant_id = $1 AND schedule_key = $2 "
            "AND deleted_at IS NULL",
            tenant_id, schedule_key,
        )

    async def list_predictive_schedules(
        self, tenant_id: int, *, enabled: bool | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        clauses = ["tenant_id = $1", "deleted_at IS NULL"]
        args: list[Any] = [tenant_id]
        if enabled is not None:
            args.append(enabled)
            clauses.append(f"enabled = ${len(args)}")
        where = " AND ".join(clauses)
        total = await self._db.fetchval(
            f"SELECT count(*) FROM ai.predictive_schedules WHERE {where}", *args
        )
        args.append(limit)
        args.append(offset)
        rows = await self._db.fetch(
            f"SELECT {self._PREDICTIVE_SCHEDULE_COLUMNS} FROM "
            f"ai.predictive_schedules WHERE {where} "
            f"ORDER BY created_at DESC, id DESC LIMIT ${len(args) - 1} "
            f"OFFSET ${len(args)}",
            *args,
        )
        return rows, int(total or 0)

    async def update_predictive_schedule(
        self, tenant_id: int, schedule_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._mq_update(
            "predictive_schedules", self._PREDICTIVE_SCHEDULE_COLUMNS, schedule_id,
            tenant_id, fields,
            {"prediction_type", "subject_type", "subject_scope",
             "interval_seconds", "enabled", "next_run_at", "last_run_at",
             "last_prediction_id", "updated_by"},
            increment_version=False,
        )

    async def list_due_predictive_schedules(
        self, *, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            f"SELECT {self._PREDICTIVE_SCHEDULE_COLUMNS} FROM "
            "ai.predictive_schedules WHERE enabled AND deleted_at IS NULL "
            "AND next_run_at IS NOT NULL AND next_run_at <= now() "
            "ORDER BY next_run_at ASC LIMIT $1",
            limit,
        )
