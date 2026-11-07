from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
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
    rows = await store.list_events(TENANT, limit=10)
    assert len(rows) == 1
    assert rows[0]["type"] == KNOWLEDGE_SOURCE_REGISTERED
    assert rows[0]["tenant_id"] == TENANT
    assert rows[0]["actor_id"] == 7


async def test_emit_without_tenant_is_skipped() -> None:
    store = InMemoryEventStore()
    publisher = EventPublisher(sinks=(store,))
    assert await publisher.emit(KNOWLEDGE_SOURCE_REGISTERED, tenant_id=None, data={}) is None
    assert await store.list_events(TENANT, limit=10) == []


async def test_event_store_scopes_reads_and_replay_by_tenant() -> None:
    store = InMemoryEventStore()
    one = build_envelope(
        AI_REQUEST_COMPLETED, tenant_id=1, data={"operation": "chat", "status": "succeeded"}
    ).to_record()
    two = build_envelope(
        AI_REQUEST_COMPLETED, tenant_id=2, data={"operation": "chat", "status": "succeeded"}
    ).to_record()
    await store.publish([one, two])

    assert [row["tenant_id"] for row in await store.list_events(1, limit=10)] == [1]
    assert await store.get_event(1, two["event_id"]) is None
    assert await store.get_event(2, two["event_id"]) is not None

    await store.record_failure(one["event_id"], "g1", "boom", max_attempts=1)
    dead_one = await store.list_dead_letters(1, limit=10)
    assert [row["event_id"] for row in dead_one] == [one["event_id"]]
    assert await store.list_dead_letters(2, limit=10) == []
    assert (await store.delivery_stats(2, "g1"))["dead"] == 0

    await store.mark_delivered(two["event_id"], "g1")
    assert await store.replay(1, two["event_id"], "g1") is False
    assert await store.replay(2, two["event_id"], "g1") is True


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

    stats = await store.delivery_stats(TENANT, "g1")
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

    stats = await store.delivery_stats(TENANT, "g1")
    assert stats["dead"] == 1
    dead = await store.list_dead_letters(TENANT, limit=10)
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
    assert (await store.delivery_stats(TENANT, "g1"))["failed"] == 1

    assert await store.replay(TENANT, envelope.event_id, "g1") is True
    assert await consumer.process_batch() == 1  # now succeeds
    assert (await store.delivery_stats(TENANT, "g1"))["delivered"] == 1


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


async def test_two_consumers_do_not_double_process_a_claimed_event() -> None:
    """Two replicas of one group must each see a different event.

    Regression for the pre-claim behaviour, where `list_undelivered` was a peek
    and both consumers ran the handler for the same row.
    """
    store = InMemoryEventStore()
    first = build_envelope(
        AI_REQUEST_COMPLETED,
        tenant_id=TENANT,
        data={"operation": "chat", "status": "succeeded"},
    )
    second = build_envelope(
        AI_REQUEST_COMPLETED,
        tenant_id=TENANT,
        data={"operation": "chat", "status": "succeeded"},
    )
    await store.publish([first.to_record(), second.to_record()])

    seen: list[str] = []

    async def handler(envelope: EventEnvelope) -> None:
        seen.append(envelope.event_id)

    handlers = {AI_REQUEST_COMPLETED: handler}
    replica_a = EventConsumer(
        store=store, consumer_group="g1", handlers=handlers, worker_id="a"
    )
    replica_b = EventConsumer(
        store=store, consumer_group="g1", handlers=handlers, worker_id="b"
    )

    await replica_a.process_batch()
    await replica_b.process_batch()

    assert sorted(seen) == sorted([first.event_id, second.event_id])
    assert len(seen) == len(set(seen)) == 2


async def test_concurrent_claims_are_partitioned_not_duplicated() -> None:
    store = InMemoryEventStore()
    envelopes = [
        build_envelope(
            AI_REQUEST_COMPLETED,
            tenant_id=TENANT,
            data={"operation": "chat", "status": "succeeded"},
        )
        for _ in range(4)
    ]
    await store.publish([envelope.to_record() for envelope in envelopes])

    claims_a = await store.claim_undelivered(
        "g1", limit=10, claimed_by="a", lease_seconds=300
    )
    claims_b = await store.claim_undelivered(
        "g1", limit=10, claimed_by="b", lease_seconds=300
    )

    ids_a = {row["event_id"] for row in claims_a}
    ids_b = {row["event_id"] for row in claims_b}
    assert ids_a
    assert not ids_a & ids_b
    assert ids_a | ids_b == {envelope.event_id for envelope in envelopes}


async def test_abandoned_claim_is_reclaimable_after_lease_expiry() -> None:
    store = InMemoryEventStore()
    envelope = build_envelope(
        AI_REQUEST_COMPLETED,
        tenant_id=TENANT,
        data={"operation": "chat", "status": "succeeded"},
    )
    await store.publish([envelope.to_record()])

    claimed = await store.claim_undelivered(
        "g1", limit=10, claimed_by="dead-worker", lease_seconds=60
    )
    assert [row["event_id"] for row in claimed] == [envelope.event_id]
    assert await store.claim_undelivered(
        "g1", limit=10, claimed_by="other", lease_seconds=60
    ) == []

    # Simulate the lease expiring because the claiming worker died.
    key = (envelope.event_id, "g1")
    store._deliveries[key]["next_attempt_at"] = datetime.now(UTC) - timedelta(seconds=1)

    reclaimed = await store.claim_undelivered(
        "g1", limit=10, claimed_by="healthy-worker", lease_seconds=60
    )
    assert [row["event_id"] for row in reclaimed] == [envelope.event_id]
