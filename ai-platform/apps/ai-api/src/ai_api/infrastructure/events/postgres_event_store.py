"""PostgreSQL-backed event store (Phase 8).

Backed by the shared enterprise database under the `ai` schema. Implements the
producer outbox (`ai.events`), per-consumer delivery tracking
(`ai.event_deliveries`) and dead letters (`ai.event_dead_letters`).
"""

from __future__ import annotations

from typing import Any

from ai_api.infrastructure.db import PostgresDatabase


class PostgresEventStore:
    def __init__(self, db: PostgresDatabase) -> None:
        self._db = db

    async def publish(self, records: list[dict[str, Any]]) -> None:
        for record in records:
            await self._db.execute(
                """
                INSERT INTO ai.events
                    (event_id, type, version, tenant_id, source, actor_id, subject_type,
                     subject_id, correlation_id, request_id, idempotency_key, payload, occurred_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (event_id) DO NOTHING
                """,
                record["event_id"],
                record["type"],
                record["version"],
                record["tenant_id"],
                record.get("source", "ai-api"),
                record.get("actor_id"),
                record.get("subject_type"),
                record.get("subject_id"),
                record.get("correlation_id"),
                record.get("request_id"),
                record.get("idempotency_key"),
                record.get("payload", {}),
                record.get("occurred_at"),
            )

    async def list_undelivered(
        self, consumer_group: str, *, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT e.id, e.event_id::text AS event_id, e.type, e.version, e.tenant_id, e.source,
                   e.actor_id, e.subject_type, e.subject_id, e.correlation_id,
                   e.request_id, e.idempotency_key, e.payload, e.occurred_at,
                   e.published_at
            FROM ai.events e
            LEFT JOIN ai.event_deliveries d
              ON d.event_id = e.event_id AND d.consumer_group = $1
            WHERE d.id IS NULL OR d.status IN ('pending', 'failed')
            ORDER BY e.id
            LIMIT $2
            """,
            consumer_group,
            limit,
        )

    async def mark_delivered(self, event_id: str, consumer_group: str) -> None:
        await self._db.execute(
            """
            INSERT INTO ai.event_deliveries (event_id, consumer_group, status, updated_at)
            VALUES ($1, $2, 'delivered', now())
            ON CONFLICT (event_id, consumer_group)
            DO UPDATE SET status = 'delivered', updated_at = now()
            """,
            event_id,
            consumer_group,
        )

    async def record_failure(
        self,
        event_id: str,
        consumer_group: str,
        error: str,
        *,
        max_attempts: int,
    ) -> str:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.event_deliveries
                (event_id, consumer_group, status, attempts, last_error, updated_at)
            VALUES ($1, $2, 'failed', 1, $3, now())
            ON CONFLICT (event_id, consumer_group)
            DO UPDATE SET
                attempts = ai.event_deliveries.attempts + 1,
                status = CASE
                    WHEN ai.event_deliveries.attempts + 1 >= $4 THEN 'dead'
                    ELSE 'failed'
                END,
                last_error = $3,
                updated_at = now()
            RETURNING status, attempts
            """,
            event_id,
            consumer_group,
            error,
            max_attempts,
        )
        status = row["status"] if row else "failed"
        if status == "dead":
            await self._db.execute(
                """
                INSERT INTO ai.event_dead_letters
                    (event_id, consumer_group, attempts, last_error, payload)
                SELECT e.event_id, $2, $3, $4, e.payload
                FROM ai.events e
                WHERE e.event_id = $1
                """,
                event_id,
                consumer_group,
                row["attempts"] if row else max_attempts,
                error,
            )
        return status

    async def list_events(self, *, limit: int) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT event_id::text AS event_id, type, version, tenant_id, actor_id, subject_type,
                   subject_id, correlation_id, request_id, payload, occurred_at,
                   published_at
            FROM ai.events
            ORDER BY id DESC
            LIMIT $1
            """,
            limit,
        )

    async def get_event(self, event_id: str) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, event_id::text AS event_id, type, version, tenant_id, actor_id, subject_type,
                   subject_id, correlation_id, request_id, idempotency_key, payload,
                   occurred_at, published_at
            FROM ai.events
            WHERE event_id = $1
            """,
            event_id,
        )

    async def list_dead_letters(self, *, limit: int) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT event_id::text AS event_id, consumer_group, attempts, last_error, created_at
            FROM ai.event_dead_letters
            ORDER BY created_at DESC
            LIMIT $1
            """,
            limit,
        )

    async def replay(self, event_id: str, consumer_group: str) -> bool:
        row = await self._db.fetchrow(
            """
            UPDATE ai.event_deliveries
            SET status = 'pending', attempts = 0, last_error = NULL, updated_at = now()
            WHERE event_id = $1 AND consumer_group = $2
            RETURNING id
            """,
            event_id,
            consumer_group,
        )
        return row is not None

    async def delivery_stats(self, consumer_group: str) -> dict[str, int]:
        rows = await self._db.fetch(
            """
            SELECT COALESCE(d.status, 'pending') AS status, count(*) AS count
            FROM ai.events e
            LEFT JOIN ai.event_deliveries d
              ON d.event_id = e.event_id AND d.consumer_group = $1
            GROUP BY 1
            """,
            consumer_group,
        )
        stats = {"pending": 0, "delivered": 0, "failed": 0, "dead": 0}
        for row in rows:
            stats[str(row["status"])] = int(row["count"])
        return stats
