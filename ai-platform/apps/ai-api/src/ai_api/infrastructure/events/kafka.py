"""Kafka event sink (Phase 8, optional).

Enabled with ``EVENT_BUS_PROVIDER=kafka``. Requires the optional ``aiokafka``
dependency (``pip install aiokafka``). Envelopes are published as JSON to a
single topic; the durable outbox store remains the idempotency/retry authority,
so Kafka is a transport, not the source of truth.

The producer is injectable so tests can exercise serialization and publish
behaviour without a broker or the dependency installed.
"""

from __future__ import annotations

import json
from typing import Any, Protocol

from ai_api.domain.errors import ConfigurationError
from ai_api.telemetry.logging import get_logger

logger = get_logger("events.kafka")


class ProducerLike(Protocol):
    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def send_and_wait(
        self, topic: str, value: bytes, key: bytes | None = ...
    ) -> Any: ...


class KafkaEventSink:
    def __init__(
        self,
        topic: str,
        *,
        bootstrap_servers: str = "127.0.0.1:9092",
        producer: ProducerLike | None = None,
    ) -> None:
        self.topic = topic
        self.bootstrap_servers = bootstrap_servers
        self._producer = producer
        self._started = False

    async def start(self) -> None:
        if self._started:
            return
        if self._producer is None:
            try:
                from aiokafka import AIOKafkaProducer  # type: ignore[import-not-found]
            except ImportError as exc:  # pragma: no cover - optional dependency
                raise ConfigurationError(
                    "EVENT_BUS_PROVIDER=kafka requires the aiokafka dependency",
                    details={"hint": "pip install aiokafka"},
                ) from exc
            self._producer = AIOKafkaProducer(bootstrap_servers=self.bootstrap_servers)
        await self._producer.start()
        self._started = True

    async def stop(self) -> None:
        if self._producer is not None and self._started:
            await self._producer.stop()
        self._started = False

    async def publish(self, records: list[dict[str, Any]]) -> None:
        if not self._started:
            await self.start()
        assert self._producer is not None
        for record in records:
            value = json.dumps(record, default=str).encode("utf-8")
            key = str(record.get("tenant_id", "")).encode("utf-8")
            await self._producer.send_and_wait(self.topic, value=value, key=key)
