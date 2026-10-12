"""Application ports (interfaces implemented by infrastructure).

Kept framework-free so services depend on abstractions, and tests can inject
in-memory implementations.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class AiRepository(Protocol):
    """Persistence boundary for the `ai` schema."""

    async def list_knowledge_sources(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def create_knowledge_source(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def get_knowledge_source(
        self, tenant_id: int, source_id: int
    ) -> dict[str, Any] | None: ...

    async def create_job(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def get_job(self, tenant_id: int, job_id: int) -> dict[str, Any] | None: ...

    async def record_execution(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]: ...

    async def record_usage(self, tenant_id: int, data: dict[str, Any]) -> None: ...

    async def usage_summary(self, tenant_id: int, *, since: datetime | None) -> dict[str, Any]: ...

    async def list_usage(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def write_audit(self, tenant_id: int, data: dict[str, Any]) -> None: ...

    async def list_audit(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def list_agents(self, tenant_id: int) -> list[dict[str, Any]]: ...

    async def get_agent(self, tenant_id: int, agent_id: int) -> dict[str, Any] | None: ...

    async def get_governance_policy(self, tenant_id: int) -> dict[str, Any] | None: ...

    async def upsert_governance_policy(
        self, tenant_id: int, policy: dict[str, Any]
    ) -> dict[str, Any]: ...

    # --- Knowledge ingestion / retrieval (Phase 7) ----------------------
    async def create_or_replace_document(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def add_chunks(
        self, tenant_id: int, document_id: int, chunks: list[dict[str, Any]]
    ) -> list[dict[str, Any]]: ...

    async def add_embeddings(self, tenant_id: int, rows: list[dict[str, Any]]) -> int: ...

    async def vector_search(
        self, tenant_id: int, embedding: list[float], *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def lexical_search(
        self, tenant_id: int, query: str, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def list_documents(
        self, tenant_id: int, source_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def set_source_status(self, tenant_id: int, source_id: int, status: str) -> None: ...

    async def update_job(
        self, tenant_id: int, job_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def list_jobs_by_status(
        self, status: str, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def delete_source(self, tenant_id: int, source_id: int) -> bool: ...

    async def list_source_chunks(
        self, tenant_id: int, source_id: int
    ) -> list[dict[str, Any]]: ...


@runtime_checkable
class EventSink(Protocol):
    """A destination an event is written to (outbox store and/or Kafka)."""

    async def publish(self, records: list[dict[str, Any]]) -> None: ...


@runtime_checkable
class EventStore(Protocol):
    """Durable event log plus per-consumer-group delivery tracking."""

    async def publish(self, records: list[dict[str, Any]]) -> None: ...

    async def list_undelivered(
        self, consumer_group: str, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def mark_delivered(self, event_id: str, consumer_group: str) -> None: ...

    async def record_failure(
        self,
        event_id: str,
        consumer_group: str,
        error: str,
        *,
        max_attempts: int,
    ) -> str: ...

    async def list_events(self, *, limit: int) -> list[dict[str, Any]]: ...

    async def get_event(self, event_id: str) -> dict[str, Any] | None: ...

    async def list_dead_letters(self, *, limit: int) -> list[dict[str, Any]]: ...

    async def replay(self, event_id: str, consumer_group: str) -> bool: ...

    async def delivery_stats(self, consumer_group: str) -> dict[str, int]: ...
