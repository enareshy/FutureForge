"""In-memory event store for tests and local development (Phase 8)."""

from __future__ import annotations

from datetime import UTC, datetime
from itertools import count
from typing import Any


class InMemoryEventStore:
    def __init__(self) -> None:
        self._events: list[dict[str, Any]] = []
        self._deliveries: dict[tuple[str, str], dict[str, Any]] = {}
        self._dead_letters: list[dict[str, Any]] = []
        self._ids: count = count(1)

    async def publish(self, records: list[dict[str, Any]]) -> None:
        for record in records:
            stored = dict(record)
            stored.setdefault("published_at", datetime.now(UTC))
            stored["id"] = next(self._ids)
            self._events.append(stored)

    async def list_undelivered(
        self, consumer_group: str, *, limit: int
    ) -> list[dict[str, Any]]:
        pending: list[dict[str, Any]] = []
        for event in self._events:
            delivery = self._deliveries.get((event["event_id"], consumer_group))
            if delivery is None or delivery["status"] in ("pending", "failed"):
                pending.append(dict(event))
            if len(pending) >= limit:
                break
        return pending

    async def mark_delivered(self, event_id: str, consumer_group: str) -> None:
        self._deliveries[(event_id, consumer_group)] = {
            "status": "delivered",
            "attempts": self._deliveries.get((event_id, consumer_group), {}).get("attempts", 0),
            "last_error": None,
            "updated_at": datetime.now(UTC),
        }

    async def record_failure(
        self,
        event_id: str,
        consumer_group: str,
        error: str,
        *,
        max_attempts: int,
    ) -> str:
        current = self._deliveries.get((event_id, consumer_group), {})
        attempts = int(current.get("attempts", 0)) + 1
        status = "dead" if attempts >= max_attempts else "failed"
        self._deliveries[(event_id, consumer_group)] = {
            "status": status,
            "attempts": attempts,
            "last_error": error,
            "updated_at": datetime.now(UTC),
        }
        if status == "dead":
            self._dead_letters.append(
                {
                    "event_id": event_id,
                    "consumer_group": consumer_group,
                    "attempts": attempts,
                    "last_error": error,
                    "created_at": datetime.now(UTC),
                }
            )
        return status

    async def list_events(self, *, limit: int) -> list[dict[str, Any]]:
        ordered = sorted(self._events, key=lambda e: e["id"], reverse=True)
        return [dict(event) for event in ordered[:limit]]

    async def get_event(self, event_id: str) -> dict[str, Any] | None:
        for event in self._events:
            if event["event_id"] == event_id:
                return dict(event)
        return None

    async def list_dead_letters(self, *, limit: int) -> list[dict[str, Any]]:
        ordered = sorted(self._dead_letters, key=lambda e: e["created_at"], reverse=True)
        return [dict(item) for item in ordered[:limit]]

    async def replay(self, event_id: str, consumer_group: str) -> bool:
        delivery = self._deliveries.get((event_id, consumer_group))
        if delivery is None:
            return False
        delivery["status"] = "pending"
        delivery["attempts"] = 0
        delivery["last_error"] = None
        delivery["updated_at"] = datetime.now(UTC)
        return True

    async def delivery_stats(self, consumer_group: str) -> dict[str, int]:
        stats = {"pending": 0, "delivered": 0, "failed": 0, "dead": 0}
        for event in self._events:
            delivery = self._deliveries.get((event["event_id"], consumer_group))
            status = delivery["status"] if delivery else "pending"
            stats[status] = stats.get(status, 0) + 1
        return stats
