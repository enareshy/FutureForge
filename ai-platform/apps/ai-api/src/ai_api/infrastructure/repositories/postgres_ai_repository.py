"""PostgreSQL-backed implementation of the AiRepository port."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ai_api.infrastructure.db.database import PostgresDatabase


def _vector_literal(values: list[float] | tuple[float, ...]) -> str:
    return "[" + ",".join(f"{float(v):.8g}" for v in values) + "]"


class PostgresAiRepository:
    def __init__(self, db: PostgresDatabase) -> None:
        self._db = db

    async def list_knowledge_sources(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = await self._db.fetch(
            """
            SELECT id, code, name, kind, uri, classification, acl, status,
                   created_at, updated_at
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
                      created_at, updated_at
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
                   created_at, updated_at
            FROM ai.knowledge_sources
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            source_id,
        )

    async def create_job(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        job = await self._db.fetchrow(
            """
            INSERT INTO ai.jobs (tenant_id, type, source_id, idempotency_key, payload)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
            RETURNING id, type, status, source_id, progress, attempts,
                      created_at, started_at, finished_at
            """,
            tenant_id,
            data["type"],
            data.get("source_id"),
            data.get("idempotency_key"),
            data.get("payload", {}),
        )
        if job is None and data.get("idempotency_key"):
            job = await self._db.fetchrow(
                """
                SELECT id, type, status, source_id, progress, attempts,
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
            SELECT id, type, status, source_id, progress, attempts, payload,
                   created_at, started_at, finished_at
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
                   request_id, detail, created_at
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
            """
            SELECT id, code, name, description, kind, enabled, created_at, updated_at
            FROM ai.agents
            WHERE tenant_id = $1 AND id = $2
            """,
            tenant_id,
            agent_id,
        )

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
        async with self._db.transaction() as tx:
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
                     checksum, size_bytes, classification, acl, metadata, status, indexed_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'indexed', now())
                RETURNING id, source_id, external_id, title, mime_type, checksum,
                          size_bytes, classification, acl, metadata, status, created_at
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
            )
        assert document is not None
        return document

    async def add_chunks(
        self, tenant_id: int, document_id: int, chunks: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for chunk in chunks:
            row = await self._db.fetchrow(
                """
                INSERT INTO ai.document_chunks
                    (tenant_id, document_id, chunk_index, content, token_count, checksum,
                     classification, acl, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id, document_id, chunk_index, content, token_count, checksum,
                          classification, acl, metadata
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
                   c.classification, c.acl, d.source_id, s.code AS source_code,
                   s.name AS source_name,
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
                   c.classification, c.acl, d.source_id, s.code AS source_code,
                   s.name AS source_name,
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
        self, tenant_id: int, source_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = await self._db.fetch(
            """
            SELECT id, source_id, external_id, title, mime_type, classification,
                   status, size_bytes, indexed_at, created_at
            FROM ai.documents
            WHERE tenant_id = $1 AND source_id = $2
            ORDER BY created_at DESC
            LIMIT $3 OFFSET $4
            """,
            tenant_id,
            source_id,
            limit,
            offset,
        )
        total = await self._db.fetchval(
            "SELECT count(*) FROM ai.documents WHERE tenant_id = $1 AND source_id = $2",
            tenant_id,
            source_id,
        )
        return items, int(total or 0)

    async def set_source_status(self, tenant_id: int, source_id: int, status: str) -> None:
        await self._db.execute(
            "UPDATE ai.knowledge_sources SET status = $3 WHERE tenant_id = $1 AND id = $2",
            tenant_id,
            source_id,
            status,
        )

    async def update_job(
        self, tenant_id: int, job_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            UPDATE ai.jobs
            SET status = COALESCE($3, status),
                progress = COALESCE($4, progress),
                attempts = COALESCE($5, attempts),
                result = COALESCE($6, result),
                error = COALESCE($7, error),
                started_at = COALESCE($8, started_at),
                finished_at = COALESCE($9, finished_at)
            WHERE tenant_id = $1 AND id = $2
            RETURNING id, type, status, source_id, progress, attempts,
                      created_at, started_at, finished_at, result, error
            """,
            tenant_id,
            job_id,
            fields.get("status"),
            fields.get("progress"),
            fields.get("attempts"),
            fields.get("result"),
            fields.get("error"),
            fields.get("started_at"),
            fields.get("finished_at"),
        )

    async def delete_source(self, tenant_id: int, source_id: int) -> bool:
        result = await self._db.execute(
            "DELETE FROM ai.knowledge_sources WHERE tenant_id = $1 AND id = $2",
            tenant_id,
            source_id,
        )
        return result.endswith("1")

    async def list_jobs_by_status(
        self, status: str, *, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT id, tenant_id, type, status, source_id, attempts, payload
            FROM ai.jobs
            WHERE status = $1
            ORDER BY id
            LIMIT $2
            """,
            status,
            limit,
        )

    async def list_source_chunks(
        self, tenant_id: int, source_id: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT d.id AS document_id, d.external_id, d.title, d.mime_type,
                   c.chunk_index, c.content, c.classification, c.acl, c.metadata
            FROM ai.documents d
            JOIN ai.document_chunks c ON c.document_id = d.id
            WHERE d.tenant_id = $1 AND d.source_id = $2
            ORDER BY d.id, c.chunk_index
            """,
            tenant_id,
            source_id,
        )
