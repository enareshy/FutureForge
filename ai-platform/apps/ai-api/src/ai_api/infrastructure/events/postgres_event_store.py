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
                   e.published_at, COALESCE(d.attempts, 0) AS delivery_attempts
            FROM ai.events e
            LEFT JOIN ai.event_deliveries d
              ON d.event_id = e.event_id AND d.consumer_group = $1
            WHERE d.id IS NULL
               OR (
                    d.status IN ('pending', 'failed')
                    AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
               )
            ORDER BY e.id
            LIMIT $2
            """,
            consumer_group,
            limit,
        )

    async def claim_undelivered(
        self,
        consumer_group: str,
        *,
        limit: int,
        claimed_by: str,
        lease_seconds: float,
    ) -> list[dict[str, Any]]:
        """Atomically claim a batch of undelivered events.

        ``list_undelivered`` is a read-only peek: two concurrent consumers of
        the same group can both see the same row and both run the handler. This
        method closes that gap with ``FOR UPDATE SKIP LOCKED`` inside one
        transaction, so each eligible event is handed to exactly one worker.

        The claim lease reuses ``next_attempt_at`` rather than adding columns:
        for this table both a retry backoff and an in-flight claim mean "not
        before this instant", so a single timestamp expresses both. A claimed
        row is pushed past ``now()``; if the claiming worker dies, the lease
        expires and the row becomes eligible again instead of being stranded.

        ``claimed_by`` is recorded in ``last_error`` only as an in-flight marker
        so an operator can see who holds a lease. It is overwritten by the real
        error on failure and cleared on delivery.
        """
        async with self._db.transaction() as tx:
            rows = await tx.fetch(
                """
                SELECT e.id, e.event_id::text AS event_id, e.type, e.version,
                       e.tenant_id, e.source, e.actor_id, e.subject_type,
                       e.subject_id, e.correlation_id, e.request_id,
                       e.idempotency_key, e.payload, e.occurred_at,
                       e.published_at, COALESCE(d.attempts, 0) AS delivery_attempts
                FROM ai.events e
                LEFT JOIN ai.event_deliveries d
                  ON d.event_id = e.event_id AND d.consumer_group = $1
                WHERE d.id IS NULL
                   OR (
                        d.status IN ('pending', 'failed')
                        AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
                   )
                ORDER BY e.id
                FOR UPDATE OF e SKIP LOCKED
                LIMIT $2
                """,
                consumer_group,
                limit,
            )
            if not rows:
                return []
            event_ids = [row["event_id"] for row in rows]
            await tx.execute(
                """
                INSERT INTO ai.event_deliveries
                    (event_id, consumer_group, status, attempts, last_error,
                     next_attempt_at, updated_at)
                SELECT unnest($1::uuid[]), $2, 'pending', 0, $3,
                       now() + make_interval(secs => $4), now()
                ON CONFLICT (event_id, consumer_group)
                DO UPDATE SET
                    status = 'pending',
                    last_error = EXCLUDED.last_error,
                    next_attempt_at = EXCLUDED.next_attempt_at,
                    updated_at = now()
                """,
                event_ids,
                consumer_group,
                f"claimed_by:{claimed_by}",
                max(0.0, lease_seconds),
            )
            return [dict(row) for row in rows]

    async def mark_delivered(self, event_id: str, consumer_group: str) -> None:
        await self._db.execute(
            """
            INSERT INTO ai.event_deliveries
                (event_id, consumer_group, status, next_attempt_at, updated_at)
            VALUES ($1, $2, 'delivered', NULL, now())
            ON CONFLICT (event_id, consumer_group)
            DO UPDATE SET status = 'delivered', next_attempt_at = NULL, updated_at = now()
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
        retry_delay_seconds: float = 0.0,
    ) -> str:
        row = await self._db.fetchrow(
            """
            INSERT INTO ai.event_deliveries
                (event_id, consumer_group, status, attempts, last_error,
                 next_attempt_at, updated_at)
            VALUES (
                $1, $2,
                CASE WHEN 1 >= $4 THEN 'dead' ELSE 'failed' END,
                1, $3,
                CASE
                    WHEN 1 >= $4 THEN NULL
                    ELSE now() + make_interval(secs => $5)
                END,
                now()
            )
            ON CONFLICT (event_id, consumer_group)
            DO UPDATE SET
                attempts = ai.event_deliveries.attempts + 1,
                status = CASE
                    WHEN ai.event_deliveries.attempts + 1 >= $4 THEN 'dead'
                    ELSE 'failed'
                END,
                last_error = $3,
                next_attempt_at = CASE
                    WHEN ai.event_deliveries.attempts + 1 >= $4 THEN NULL
                    ELSE now() + make_interval(secs => $5)
                END,
                updated_at = now()
            RETURNING status, attempts
            """,
            event_id,
            consumer_group,
            error,
            max_attempts,
            max(0.0, retry_delay_seconds),
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

    async def list_events(self, tenant_id: int, *, limit: int) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT event_id::text AS event_id, type, version, tenant_id, actor_id, subject_type,
                   subject_id, correlation_id, request_id, payload, occurred_at,
                   published_at
            FROM ai.events
            WHERE tenant_id = $1
            ORDER BY id DESC
            LIMIT $2
            """,
            tenant_id,
            limit,
        )

    async def get_event(self, tenant_id: int, event_id: str) -> dict[str, Any] | None:
        return await self._db.fetchrow(
            """
            SELECT id, event_id::text AS event_id, type, version, tenant_id, actor_id, subject_type,
                   subject_id, correlation_id, request_id, idempotency_key, payload,
                   occurred_at, published_at
            FROM ai.events
            WHERE event_id = $1 AND tenant_id = $2
            """,
            event_id,
            tenant_id,
        )

    async def list_dead_letters(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        return await self._db.fetch(
            """
            SELECT dl.event_id::text AS event_id, dl.consumer_group, dl.attempts,
                   dl.last_error, dl.created_at
            FROM ai.event_dead_letters dl
            JOIN ai.events e ON e.event_id = dl.event_id
            WHERE e.tenant_id = $1
            ORDER BY dl.created_at DESC
            LIMIT $2
            """,
            tenant_id,
            limit,
        )

    async def replay(self, tenant_id: int, event_id: str, consumer_group: str) -> bool:
        row = await self._db.fetchrow(
            """
            UPDATE ai.event_deliveries d
            SET status = 'pending', attempts = 0, last_error = NULL,
                next_attempt_at = NULL, updated_at = now()
            WHERE d.event_id = $1 AND d.consumer_group = $2
              AND EXISTS (
                  SELECT 1 FROM ai.events e
                  WHERE e.event_id = $1 AND e.tenant_id = $3
              )
            RETURNING d.id
            """,
            event_id,
            consumer_group,
            tenant_id,
        )
        if row is not None:
            await self._db.execute(
                """
                DELETE FROM ai.event_dead_letters
                WHERE event_id = $1 AND consumer_group = $2
                """,
                event_id,
                consumer_group,
            )
        return row is not None

    async def delivery_stats(self, tenant_id: int, consumer_group: str) -> dict[str, int]:
        rows = await self._db.fetch(
            """
            SELECT COALESCE(d.status, 'pending') AS status, count(*) AS count
            FROM ai.events e
            LEFT JOIN ai.event_deliveries d
              ON d.event_id = e.event_id AND d.consumer_group = $1
            WHERE e.tenant_id = $2
            GROUP BY 1
            """,
            consumer_group,
            tenant_id,
        )
        stats = {"pending": 0, "delivered": 0, "failed": 0, "dead": 0}
        for row in rows:
            stats[str(row["status"])] = int(row["count"])
        return stats

    async def delivery_backlog(self) -> dict[str, int]:
        row = await self._db.fetchrow(
            """
            WITH deliveries AS (
                SELECT COALESCE(d.status, 'pending') AS status, d.next_attempt_at,
                       e.occurred_at
                FROM ai.events e
                LEFT JOIN ai.event_deliveries d ON d.event_id = e.event_id
            )
            SELECT
                count(*) FILTER (
                    WHERE status IN ('pending', 'failed')
                      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                ) AS pending,
                count(*) FILTER (
                    WHERE status IN ('pending', 'failed')
                      AND next_attempt_at > now()
                ) AS delayed,
                count(*) FILTER (WHERE status = 'dead') AS dead,
                EXTRACT(EPOCH FROM (
                    now() - min(occurred_at) FILTER (
                        WHERE status IN ('pending', 'failed')
                          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                    )
                )) AS oldest_pending_seconds
            FROM deliveries
            """
        )
        return {
            "pending": int(row["pending"] or 0) if row else 0,
            "delayed": int(row["delayed"] or 0) if row else 0,
            "dead": int(row["dead"] or 0) if row else 0,
            "oldest_pending_seconds": (
                float(row["oldest_pending_seconds"] or 0.0) if row else 0.0
            ),
        }
