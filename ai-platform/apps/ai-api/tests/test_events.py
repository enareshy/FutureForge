from __future__ import annotations

import json
from typing import Any

import pytest

from ai_api.application.services.event_service import EventConsumer, EventPublisher
from ai_api.domain.errors import ValidationError
from ai_api.domain.events import (
    AI_REQUEST_COMPLETED,
    KNOWLEDGE_SOURCE_REGISTERED,
    EventEnvelope,
    build_envelope,
    validate_event,
)
from ai_api.infrastructure.events.kafka import KafkaEventSink
from ai_api.infrastructure.events.memory_event_store import InMemoryEventStore

TENANT = 1


def test_validate_event_accepts_and_rejects() -> None:
    definition = validate_event(
        KNOWLEDGE_SOURCE_REGISTERED,
        {"source_id": 1, "code": "ops", "kind": "manual"},
    )
    assert definition.version == "v1"

    with pytest.raises(ValidationError):
        validate_event(KNOWLEDGE_SOURCE_REGISTERED, {"code": "ops"})

    with pytest.raises(ValidationError):
        validate_event("NotARealEvent", {})


async def test_publisher_writes_envelope_to_store() -> None:
    store = InMemoryEventStore()
    publisher = EventPublisher(sinks=(store,))

    envelope = await publisher.emit(
        KNOWLEDGE_SOURCE_REGISTERED,
        tenant_id=TENANT,
        actor_id=7,
        data={"source_id": 5, "code": "ops", "kind": "manual"},
    )

    assert envelope is not None
    rows = await store.list_events(limit=10)
    assert len(rows) == 1
    assert rows[0]["type"] == KNOWLEDGE_SOURCE_REGISTERED
    assert rows[0]["tenant_id"] == TENANT
    assert rows[0]["actor_id"] == 7


async def test_emit_without_tenant_is_skipped() -> None:
    store = InMemoryEventStore()
    publisher = EventPublisher(sinks=(store,))
    assert await publisher.emit(KNOWLEDGE_SOURCE_REGISTERED, tenant_id=None, data={}) is None
    assert await store.list_events(limit=10) == []


async def test_consumer_is_idempotent_per_group() -> None:
    store = InMemoryEventStore()
    record = build_envelope(
        AI_REQUEST_COMPLETED,
        tenant_id=TENANT,
        data={"operation": "chat", "status": "succeeded"},
    ).to_record()
    await store.publish([record])

    seen: list[str] = []

    async def handler(envelope: EventEnvelope) -> None:
        seen.append(envelope.event_id)

    consumer = EventConsumer(
        store=store, consumer_group="g1", handlers={AI_REQUEST_COMPLETED: handler}
    )
    assert await consumer.process_batch() == 1
    assert await consumer.process_batch() == 0
    assert len(seen) == 1

    stats = await store.delivery_stats("g1")
    assert stats["delivered"] == 1


async def test_consumer_retries_then_dead_letters() -> None:
    store = InMemoryEventStore()
    envelope = build_envelope(
        AI_REQUEST_COMPLETED, tenant_id=TENANT, data={"operation": "chat", "status": "failed"}
    )
    await store.publish([envelope.to_record()])

    async def always_fails(_: EventEnvelope) -> None:
        raise RuntimeError("boom")

    consumer = EventConsumer(
        store=store,
        consumer_group="g1",
        handlers={AI_REQUEST_COMPLETED: always_fails},
        max_attempts=2,
    )
    assert await consumer.process_batch() == 0  # attempt 1 -> failed
    assert await consumer.process_batch() == 0  # attempt 2 -> dead
    assert await consumer.process_batch() == 0  # no further attempts

    stats = await store.delivery_stats("g1")
    assert stats["dead"] == 1
    dead = await store.list_dead_letters(limit=10)
    assert dead and dead[0]["event_id"] == envelope.event_id


async def test_replay_resets_delivery() -> None:
    store = InMemoryEventStore()
    envelope = build_envelope(
        AI_REQUEST_COMPLETED, tenant_id=TENANT, data={"operation": "chat", "status": "failed"}
    )
    await store.publish([envelope.to_record()])

    calls = {"n": 0}

    async def flaky(_: EventEnvelope) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("first attempt fails")

    consumer = EventConsumer(
        store=store, consumer_group="g1", handlers={AI_REQUEST_COMPLETED: flaky}, max_attempts=5
    )
    await consumer.process_batch()  # fails
    assert (await store.delivery_stats("g1"))["failed"] == 1

    assert await store.replay(envelope.event_id, "g1") is True
    assert await consumer.process_batch() == 1  # now succeeds
    assert (await store.delivery_stats("g1"))["delivered"] == 1


class FakeProducer:
    def __init__(self) -> None:
        self.started = False
        self.sent: list[tuple[str, bytes, bytes | None]] = []

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.started = False

    async def send_and_wait(self, topic: str, value: bytes, key: bytes | None = None) -> Any:
        self.sent.append((topic, value, key))
        return None


async def test_kafka_sink_serializes_records() -> None:
    producer = FakeProducer()
    sink = KafkaEventSink("ai.events", producer=producer)
    record = build_envelope(
        AI_REQUEST_COMPLETED, tenant_id=TENANT, data={"operation": "chat", "status": "succeeded"}
    ).to_record()

    await sink.publish([record])

    assert producer.started is True
    topic, value, key = producer.sent[0]
    assert topic == "ai.events"
    assert key == b"1"
    assert json.loads(value)["type"] == AI_REQUEST_COMPLETED
    await sink.stop()
    assert producer.started is False
