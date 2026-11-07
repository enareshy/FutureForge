"""Event publishing and consumption (Phase 8).

`EventPublisher` validates payloads against the versioned registry and writes an
`EventEnvelope` to one or more sinks (the durable outbox store and/or Kafka).

`EventConsumer` drains the store for a consumer group with:
- idempotent delivery tracking (an event is handled once per consumer group),
- bounded retries, then a dead-letter record,
- correlation/request id propagation,
- defensive schema validation and graceful shutdown.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ai_api.application.ports import EventSink, EventStore
from ai_api.domain.events import (
    AI_EVALUATION_COMPLETED,
    AI_REQUEST_COMPLETED,
    KNOWLEDGE_INDEX_COMPLETED,
    KNOWLEDGE_INDEX_FAILED,
    KNOWLEDGE_INDEX_REQUESTED,
    KNOWLEDGE_SOURCE_REGISTERED,
    KNOWLEDGE_SOURCE_SECURITY_UPDATED,
    EventEnvelope,
    build_envelope,
)
from ai_api.infrastructure.db.tenant_context import system_scope, tenant_scope
from ai_api.telemetry.logging import get_logger, request_id_var
from ai_api.telemetry.metrics import (
    record_event_consumed,
    record_event_publish_failed,
    record_event_published,
)

logger = get_logger("events")

EventHandler = Callable[[EventEnvelope], Awaitable[None]]


@dataclass(slots=True)
class EventPublisher:
    sinks: Sequence[EventSink] = field(default_factory=tuple)
    enabled: bool = True

    async def publish(self, envelope: EventEnvelope) -> None:
        if not self.enabled:
            return
        record = envelope.to_record()
        published = False
        for sink in self.sinks:
            try:
                await sink.publish([record])
                published = True
            except Exception as exc:  # noqa: BLE001 - publishing must not break the request
                logger.warning(
                    "event.publish_failed",
                    event_type=envelope.type,
                    event_id=envelope.event_id,
                    error=str(exc),
                )
                record_event_publish_failed(event_type=envelope.type)
        if published:
            record_event_published(event_type=envelope.type)

    async def emit(
        self,
        event_type: str,
        *,
        tenant_id: int | None,
        data: dict[str, Any],
        actor_id: int | None = None,
        subject_type: str | None = None,
        subject_id: str | None = None,
        correlation_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> EventEnvelope | None:
        if not self.enabled or tenant_id is None:
            return None
        request_id = request_id_var.get()
        envelope = build_envelope(
            event_type,
            tenant_id=tenant_id,
            data=data,
            actor_id=actor_id,
            subject_type=subject_type,
            subject_id=subject_id,
            correlation_id=correlation_id or request_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
        )
        await self.publish(envelope)
        return envelope

    async def knowledge_source_registered(
        self, *, tenant_id: int, source: dict[str, Any], actor_id: int | None
    ) -> None:
        await self.emit(
            KNOWLEDGE_SOURCE_REGISTERED,
            tenant_id=tenant_id,
            actor_id=actor_id,
            subject_type="knowledge_source",
            subject_id=str(source["id"]),
            data={
                "source_id": source["id"],
                "code": source["code"],
                "kind": source["kind"],
                "classification": source.get("classification", "internal"),
            },
        )

    async def knowledge_source_security_updated(
        self,
        *,
        tenant_id: int,
        source: dict[str, Any],
        actor_id: int | None,
        change: str,
    ) -> None:
        version = int(source.get("version", 1))
        await self.emit(
            KNOWLEDGE_SOURCE_SECURITY_UPDATED,
            tenant_id=tenant_id,
            actor_id=actor_id,
            subject_type="knowledge_source",
            subject_id=str(source["id"]),
            idempotency_key=f"knowledge-source-{source['id']}-security-v{version}",
            data={
                "source_id": source["id"],
                "version": version,
                "classification": source.get("classification", "internal"),
                "acl": source.get("acl") or {},
                "change": change,
            },
        )

    async def knowledge_index_requested(
        self,
        *,
        tenant_id: int,
        source_id: int,
        job_id: int,
        documents: int,
        actor_id: int | None,
    ) -> None:
        await self.emit(
            KNOWLEDGE_INDEX_REQUESTED,
            tenant_id=tenant_id,
            actor_id=actor_id,
            subject_type="job",
            subject_id=str(job_id),
            data={"source_id": source_id, "job_id": job_id, "documents": documents},
        )

    async def knowledge_index_completed(
        self,
        *,
        tenant_id: int,
        source_id: int,
        job_id: int,
        documents: int,
        chunks: int,
    ) -> None:
        await self.emit(
            KNOWLEDGE_INDEX_COMPLETED,
            tenant_id=tenant_id,
            subject_type="job",
            subject_id=str(job_id),
            data={
                "source_id": source_id,
                "job_id": job_id,
                "documents": documents,
                "chunks": chunks,
            },
        )

    async def knowledge_index_failed(
        self, *, tenant_id: int, source_id: int, job_id: int, error: str
    ) -> None:
        await self.emit(
            KNOWLEDGE_INDEX_FAILED,
            tenant_id=tenant_id,
            subject_type="job",
            subject_id=str(job_id),
            data={"source_id": source_id, "job_id": job_id, "error": error[:500]},
        )

    async def ai_request_completed(
        self,
        *,
        tenant_id: int,
        actor_id: int | None,
        operation: str,
        model: str | None,
        provider: str | None,
        status: str,
        is_mock: bool,
        latency_ms: int | None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int = 0,
    ) -> None:
        await self.emit(
            AI_REQUEST_COMPLETED,
            tenant_id=tenant_id,
            actor_id=actor_id,
            subject_type="execution",
            data={
                "operation": operation,
                "model": model or "unknown",
                "provider": provider or "unknown",
                "status": status,
                "is_mock": is_mock,
                "latency_ms": latency_ms,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
            },
        )

    async def ai_evaluation_completed(
        self,
        *,
        tenant_id: int,
        code: str,
        evaluation_id: int | None,
        passed: int,
        failed: int,
        metrics: dict[str, Any] | None = None,
    ) -> None:
        await self.emit(
            AI_EVALUATION_COMPLETED,
            tenant_id=tenant_id,
            subject_type="evaluation",
            subject_id=str(evaluation_id) if evaluation_id is not None else None,
            data={
                "code": code,
                "evaluation_id": evaluation_id,
                "passed": passed,
                "failed": failed,
                "metrics": metrics or {},
            },
        )


@dataclass(slots=True)
class EventConsumer:
    store: EventStore
    consumer_group: str
    handlers: Mapping[str, EventHandler] = field(default_factory=dict)
    max_attempts: int = 5
    batch_size: int = 20
    retry_base_seconds: float = 0.0
    retry_max_seconds: float = 60.0
    retry_jitter: float = 0.1
    worker_id: str = "event-consumer"
    claim_lease_seconds: float = 300.0

    async def process_batch(self) -> int:
        # Claim rather than peek: two replicas of the same group must never
        # process the same event, so selection and ownership are one step.
        with system_scope():
            rows = await self.store.claim_undelivered(
                self.consumer_group,
                limit=self.batch_size,
                claimed_by=self.worker_id,
                lease_seconds=self.claim_lease_seconds,
            )
        delivered = 0
        for row in rows:
            envelope = EventEnvelope.from_record(row)
            handler = self.handlers.get(envelope.type)
            with tenant_scope(envelope.tenant_id):
                try:
                    if handler is not None:
                        await handler(envelope)
                except Exception as exc:  # noqa: BLE001 - bounded retry then dead-letter
                    attempts = int(row.get("delivery_attempts", 0) or 0)
                    delay = min(
                        self.retry_max_seconds,
                        self.retry_base_seconds * (2**attempts),
                    )
                    if self.retry_jitter:
                        delay *= 1 + random.uniform(
                            -self.retry_jitter, self.retry_jitter
                        )
                    try:
                        status = await self.store.record_failure(
                            envelope.event_id,
                            self.consumer_group,
                            str(exc)[:500],
                            max_attempts=self.max_attempts,
                            retry_delay_seconds=max(0.0, delay),
                        )
                    except Exception:  # noqa: BLE001 - bookkeeping must not crash the worker
                        logger.exception(
                            "event.failure_record_failed",
                            event_type=envelope.type,
                            event_id=envelope.event_id,
                            consumer_group=self.consumer_group,
                        )
                        continue
                    record_event_consumed(
                        consumer_group=self.consumer_group, outcome=status
                    )
                    logger.warning(
                        "event.handler_failed",
                        event_type=envelope.type,
                        event_id=envelope.event_id,
                        consumer_group=self.consumer_group,
                        outcome=status,
                        error=str(exc)[:500],
                    )
                    continue
                await self.store.mark_delivered(
                    envelope.event_id, self.consumer_group
                )
            record_event_consumed(
                consumer_group=self.consumer_group, outcome="delivered"
            )
            delivered += 1
        if delivered:
            logger.info(
                "event.batch_processed",
                consumer_group=self.consumer_group,
                delivered=delivered,
            )
        return delivered

    async def run(self, stop: asyncio.Event, *, poll_seconds: float = 5.0) -> None:
        logger.info("consumer.started", consumer_group=self.consumer_group)
        while not stop.is_set():
            processed = await self.process_batch()
            if processed == 0:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=poll_seconds)
                except TimeoutError:
                    pass
        logger.info("consumer.stopped", consumer_group=self.consumer_group)
