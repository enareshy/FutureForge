"""Event infrastructure (Phase 8)."""

from __future__ import annotations

from ai_api.config.settings import Settings
from ai_api.infrastructure.events.kafka import KafkaEventSink
from ai_api.infrastructure.events.memory_event_store import InMemoryEventStore
from ai_api.infrastructure.events.postgres_event_store import PostgresEventStore

__all__ = [
    "InMemoryEventStore",
    "KafkaEventSink",
    "PostgresEventStore",
    "build_event_store",
]


def build_event_store(settings: Settings):
    """Return the durable outbox store.

    The store is always database-backed except under the `memory` repository
    (tests / local dev without PostgreSQL).
    """
    if settings.ai_repository == "memory":
        return InMemoryEventStore()
    from ai_api.infrastructure.db import PostgresDatabase

    return PostgresEventStore(PostgresDatabase(settings))
