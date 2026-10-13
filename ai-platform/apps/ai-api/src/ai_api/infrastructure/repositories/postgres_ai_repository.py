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
            """
            SELECT id, code, name, description, kind, enabled, created_at, updated_at
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
            INSERT INTO ai.feedback (tenant_id, execution_id, actor_id, rating, comment)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, execution_id, actor_id, rating, comment, created_at
            """,
            tenant_id,
            data.get("execution_id"),
            data.get("actor_id"),
            data.get("rating"),
            data.get("comment"),
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
            SELECT id, execution_id, actor_id, rating, comment, created_at
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

    async def list_jobs(
        self, tenant_id: int, *, status: str | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await self._db.fetch(
            """
            SELECT id, type, status, source_id, progress, attempts,
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
                   c.chunk_index, c.content, c.classification, c.acl, c.metadata
            FROM ai.documents d
            JOIN ai.document_chunks c ON c.document_id = d.id
            WHERE d.tenant_id = $1 AND d.source_id = $2
            ORDER BY d.id, c.chunk_index
            """,
            tenant_id,
            source_id,
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
