"""In-memory event store for tests and local development (Phase 8)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from itertools import count
from typing import Any


class InMemoryEventStore:
    def __init__(self) -> None:
        self._events: list[dict[str, Any]] = []
        self._deliveries: dict[tuple[str, str], dict[str, Any]] = {}
        self._dead_letters: list[dict[str, Any]] = []
        self._ids: count = count(1)

    async def publish(self, records: list[dict[str, Any]]) -> None:
        """Append events, ignoring a repeated ``event_id``.

        This mirrors the Postgres sink, which inserts with
        ``ON CONFLICT (event_id) DO NOTHING``. Without the guard the fake would
        accept a duplicate the real store silently drops, so tests could assert
        a duplicate-delivery behaviour production can never exhibit.
        """
        known = {event["event_id"] for event in self._events}
        for record in records:
            event_id = record.get("event_id")
            if event_id is not None and event_id in known:
                continue
            stored = dict(record)
            stored.setdefault("published_at", datetime.now(UTC))
            stored["id"] = next(self._ids)
            self._events.append(stored)
            if event_id is not None:
                known.add(event_id)

    async def list_undelivered(
        self, consumer_group: str, *, limit: int
    ) -> list[dict[str, Any]]:
        pending: list[dict[str, Any]] = []
        for event in self._events:
            delivery = self._deliveries.get((event["event_id"], consumer_group))
            if delivery is None:
                item = dict(event)
                item["delivery_attempts"] = 0
                pending.append(item)
            elif delivery["status"] in ("pending", "failed"):
                retry_at = delivery.get("next_attempt_at")
                if retry_at is None or retry_at <= datetime.now(UTC):
                    item = dict(event)
                    item["delivery_attempts"] = int(delivery.get("attempts", 0))
                    pending.append(item)
            if len(pending) >= limit:
                break
        return pending

    async def claim_undelivered(
        self,
        consumer_group: str,
        *,
        limit: int,
        claimed_by: str,
        lease_seconds: float,
    ) -> list[dict[str, Any]]:
        """Atomically claim pending events, mirroring the Postgres contract.

        Python does not interleave between the read and the write below because
        there is no ``await`` in that section, so the claim is atomic with
        respect to other coroutines in the same process. The lease uses
        ``next_attempt_at`` exactly as the SQL implementation does, so an
        abandoned claim expires instead of stranding the event.
        """
        now = datetime.now(UTC)
        lease_until = now + timedelta(seconds=max(0.0, lease_seconds))
        claimed: list[dict[str, Any]] = []
        for event in self._events:
            key = (event["event_id"], consumer_group)
            delivery = self._deliveries.get(key)
            if delivery is None:
                attempts = 0
            elif delivery["status"] in ("pending", "failed"):
                retry_at = delivery.get("next_attempt_at")
                if retry_at is not None and retry_at > now:
                    continue
                attempts = int(delivery.get("attempts", 0))
            else:
                continue
            item = dict(event)
            item["delivery_attempts"] = attempts
            claimed.append(item)
            self._deliveries[key] = {
                "status": "pending",
                "attempts": attempts,
                "last_error": f"claimed_by:{claimed_by}",
                "next_attempt_at": lease_until,
                "updated_at": now,
            }
            if len(claimed) >= limit:
                break
        return claimed

    async def mark_delivered(self, event_id: str, consumer_group: str) -> None:
        self._deliveries[(event_id, consumer_group)] = {
            "status": "delivered",
            "attempts": self._deliveries.get((event_id, consumer_group), {}).get("attempts", 0),
            "last_error": None,
            "next_attempt_at": None,
            "updated_at": datetime.now(UTC),
        }

    async def record_failure(
        self,
        event_id: str,
        consumer_group: str,
        error: str,
        *,
        max_attempts: int,
        retry_delay_seconds: float = 0.0,
    ) -> str:
        current = self._deliveries.get((event_id, consumer_group), {})
        attempts = int(current.get("attempts", 0)) + 1
        status = "dead" if attempts >= max_attempts else "failed"
        self._deliveries[(event_id, consumer_group)] = {
            "status": status,
            "attempts": attempts,
            "last_error": error,
            "next_attempt_at": (
                None
                if status == "dead"
                else datetime.now(UTC) + timedelta(seconds=max(0.0, retry_delay_seconds))
            ),
            "updated_at": datetime.now(UTC),
        }
        if status == "dead":
            tenant_id = next(
                (
                    event.get("tenant_id")
                    for event in self._events
                    if event["event_id"] == event_id
                ),
                None,
            )
            self._dead_letters.append(
                {
                    "event_id": event_id,
                    "consumer_group": consumer_group,
                    "attempts": attempts,
                    "last_error": error,
                    "tenant_id": tenant_id,
                    "created_at": datetime.now(UTC),
                }
            )
        return status

    async def list_events(self, tenant_id: int, *, limit: int) -> list[dict[str, Any]]:
        ordered = sorted(
            (event for event in self._events if event.get("tenant_id") == tenant_id),
            key=lambda e: e["id"],
            reverse=True,
        )
        return [dict(event) for event in ordered[:limit]]

    async def get_event(self, tenant_id: int, event_id: str) -> dict[str, Any] | None:
        for event in self._events:
            if event["event_id"] == event_id and event.get("tenant_id") == tenant_id:
                return dict(event)
        return None

    async def list_dead_letters(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        ordered = sorted(
            (
                item
                for item in self._dead_letters
                if item.get("tenant_id") == tenant_id
            ),
            key=lambda e: e["created_at"],
            reverse=True,
        )
        return [dict(item) for item in ordered[:limit]]

    async def replay(self, tenant_id: int, event_id: str, consumer_group: str) -> bool:
        event = await self.get_event(tenant_id, event_id)
        if event is None:
            return False
        delivery = self._deliveries.get((event_id, consumer_group))
        if delivery is None:
            return False
        delivery["status"] = "pending"
        delivery["attempts"] = 0
        delivery["last_error"] = None
        delivery["next_attempt_at"] = None
        delivery["updated_at"] = datetime.now(UTC)
        self._dead_letters = [
            item
            for item in self._dead_letters
            if not (
                item["event_id"] == event_id
                and item["consumer_group"] == consumer_group
            )
        ]
        return True

    async def delivery_stats(self, tenant_id: int, consumer_group: str) -> dict[str, int]:
        stats = {"pending": 0, "delivered": 0, "failed": 0, "dead": 0}
        for event in self._events:
            if event.get("tenant_id") != tenant_id:
                continue
            delivery = self._deliveries.get((event["event_id"], consumer_group))
            status = delivery["status"] if delivery else "pending"
            stats[status] = stats.get(status, 0) + 1
        return stats

    async def delivery_backlog(self) -> dict[str, int | float]:
        now = datetime.now(UTC)
        backlog: dict[str, int | float] = {
            "pending": 0,
            "delayed": 0,
            "dead": 0,
            "oldest_pending_seconds": 0.0,
        }
        deliveries: dict[str, list[dict[str, Any]]] = {}
        for (event_id, _), delivery in self._deliveries.items():
            deliveries.setdefault(event_id, []).append(delivery)
        oldest: datetime | None = None
        for event in self._events:
            occurred = event.get("occurred_at") or event.get("published_at")
            for delivery in deliveries.get(event["event_id"], []):
                if delivery["status"] == "dead":
                    backlog["dead"] = int(backlog["dead"]) + 1
                elif delivery["status"] in ("pending", "failed"):
                    retry_at = delivery.get("next_attempt_at")
                    if retry_at is not None and retry_at > now:
                        backlog["delayed"] = int(backlog["delayed"]) + 1
                    else:
                        backlog["pending"] = int(backlog["pending"]) + 1
                        if isinstance(occurred, datetime) and (
                            oldest is None or occurred < oldest
                        ):
                            oldest = occurred
            if not deliveries.get(event["event_id"]):
                backlog["pending"] = int(backlog["pending"]) + 1
                if isinstance(occurred, datetime) and (
                    oldest is None or occurred < oldest
                ):
                    oldest = occurred
        if oldest is not None:
            backlog["oldest_pending_seconds"] = max(
                0.0, (now - oldest).total_seconds()
            )
        return backlog
