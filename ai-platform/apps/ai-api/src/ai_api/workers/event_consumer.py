"""Event consumer worker (Phase 8).

Drains the durable event log for the configured consumer group, invoking
registered handlers with bounded retries and dead-lettering. Idempotent per
(event, consumer group). Graceful shutdown on SIGINT/SIGTERM.

Usage:
    python -m ai_api.workers.event_consumer --once
    python -m ai_api.workers.event_consumer --watch
"""

from __future__ import annotations

import argparse
import asyncio
import signal
from collections.abc import Mapping

from ai_api.application.services.event_service import EventConsumer, EventHandler
from ai_api.config.settings import Settings, get_settings
from ai_api.domain.events import (
    AI_EVALUATION_COMPLETED,
    AI_REQUEST_COMPLETED,
    KNOWLEDGE_INDEX_COMPLETED,
    KNOWLEDGE_INDEX_FAILED,
    KNOWLEDGE_INDEX_REQUESTED,
    KNOWLEDGE_SOURCE_REGISTERED,
    EventEnvelope,
)
from ai_api.infrastructure.events import build_event_store
from ai_api.telemetry.logging import configure_logging, get_logger
from ai_api.telemetry.metrics_server import start_metrics_server

logger = get_logger("worker.events")

_shutdown = asyncio.Event()


def build_default_handlers() -> Mapping[str, EventHandler]:
    async def _observe(envelope: EventEnvelope) -> None:
        logger.info(
            "event.observed",
            event_type=envelope.type,
            event_id=envelope.event_id,
            tenant_id=envelope.tenant_id,
            correlation_id=envelope.correlation_id,
            subject_type=envelope.subject_type,
        )

    return {
        KNOWLEDGE_SOURCE_REGISTERED: _observe,
        KNOWLEDGE_INDEX_REQUESTED: _observe,
        KNOWLEDGE_INDEX_COMPLETED: _observe,
        KNOWLEDGE_INDEX_FAILED: _observe,
        AI_REQUEST_COMPLETED: _observe,
        AI_EVALUATION_COMPLETED: _observe,
    }


def build_consumer(settings: Settings) -> EventConsumer:
    return EventConsumer(
        store=build_event_store(settings),
        consumer_group=settings.ai_event_consumer_group,
        handlers=build_default_handlers(),
        max_attempts=settings.ai_event_max_attempts,
        batch_size=settings.ai_event_batch_size,
    )


async def run(*, once: bool, settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    consumer = build_consumer(settings)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown.set)
        except NotImplementedError:  # pragma: no cover - platform dependent
            pass

    if once:
        await consumer.process_batch()
        return
    await consumer.run(_shutdown, poll_seconds=settings.ai_event_poll_seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description="AI event consumer worker")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--once", action="store_true", help="drain backlog then exit")
    group.add_argument("--watch", action="store_true", help="poll continuously")
    parser.add_argument(
        "--metrics-port", type=int, default=0, help="expose Prometheus metrics on this port"
    )
    args = parser.parse_args()
    settings = get_settings()
    configure_logging(settings.ai_api_log_level, json_logs=settings.is_production)
    start_metrics_server(args.metrics_port)
    asyncio.run(run(once=not args.watch, settings=settings))


if __name__ == "__main__":
    main()
