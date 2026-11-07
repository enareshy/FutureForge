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
import socket
import uuid
from collections.abc import Mapping

from ai_api.application.ports import AiRepository
from ai_api.application.services.event_service import EventConsumer, EventHandler
from ai_api.config.settings import Settings, get_settings
from ai_api.domain.events import (
    AI_EVALUATION_COMPLETED,
    AI_REQUEST_COMPLETED,
    KNOWLEDGE_INDEX_COMPLETED,
    KNOWLEDGE_INDEX_FAILED,
    KNOWLEDGE_INDEX_REQUESTED,
    KNOWLEDGE_SOURCE_REGISTERED,
    KNOWLEDGE_SOURCE_SECURITY_UPDATED,
    EventEnvelope,
)
from ai_api.infrastructure.db import PostgresDatabase
from ai_api.infrastructure.db.tenant_context import system_scope
from ai_api.infrastructure.events import build_event_store
from ai_api.infrastructure.repositories import InMemoryAiRepository, PostgresAiRepository
from ai_api.telemetry.logging import configure_logging, get_logger
from ai_api.telemetry.metrics import record_event_backlog
from ai_api.workers.health import WorkerHealth, start_health_server

logger = get_logger("worker.events")
WORKER_NAME = "event-consumer"

_shutdown = asyncio.Event()


def build_security_updated_handler(repository: AiRepository) -> EventHandler:
    """Consume security invalidation events without trusting their contents.

    The database is the authority: this handler re-reads the current source,
    ignores deleted/disabled sources and out-of-order events, and enqueues an
    idempotent reindex for the authoritative current state. It never writes ACL
    or classification values from the event payload.
    """

    async def _handle(envelope: EventEnvelope) -> None:
        if envelope.version != "v1":
            raise ValueError(f"unsupported event version: {envelope.version}")
        data = envelope.data or {}
        try:
            source_id = int(data["source_id"])
            event_version = int(data["version"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("invalid KnowledgeSourceSecurityUpdated payload") from exc
        if event_version < 1:
            raise ValueError("invalid source security version")
        if envelope.subject_type != "knowledge_source":
            raise ValueError("unexpected subject_type for security update")
        if envelope.subject_id is None or str(source_id) != str(envelope.subject_id):
            raise ValueError("event subject does not match source_id")

        source = await repository.get_knowledge_source(envelope.tenant_id, source_id)
        if source is None:
            logger.info(
                "security_sync.source_missing",
                tenant_id=envelope.tenant_id,
                source_id=source_id,
                event_version=event_version,
            )
            return
        current_version = int(source.get("version", 1))
        if current_version > event_version:
            logger.info(
                "security_sync.stale_event_ignored",
                tenant_id=envelope.tenant_id,
                source_id=source_id,
                event_version=event_version,
                current_version=current_version,
            )
            return
        if source.get("status") == "disabled":
            logger.info(
                "security_sync.disabled_source_ignored",
                tenant_id=envelope.tenant_id,
                source_id=source_id,
                event_version=event_version,
            )
            return
        if current_version < event_version:
            logger.warning(
                "security_sync.event_ahead_of_store",
                tenant_id=envelope.tenant_id,
                source_id=source_id,
                event_version=event_version,
                current_version=current_version,
            )
        job = await repository.create_job(
            envelope.tenant_id,
            {
                "type": "index",
                "source_id": source_id,
                "idempotency_key": f"source-security-{source_id}-v{event_version}",
                "payload": {"force": False, "security_event": True},
            },
        )
        logger.info(
            "security_sync.refresh_queued",
            tenant_id=envelope.tenant_id,
            source_id=source_id,
            event_version=event_version,
            job_id=job["id"] if job else None,
        )

    return _handle


def build_default_handlers(
    repository: AiRepository | None = None,
) -> Mapping[str, EventHandler]:
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
        KNOWLEDGE_SOURCE_SECURITY_UPDATED: (
            build_security_updated_handler(repository)
            if repository is not None
            else _observe
        ),
        KNOWLEDGE_INDEX_REQUESTED: _observe,
        KNOWLEDGE_INDEX_COMPLETED: _observe,
        KNOWLEDGE_INDEX_FAILED: _observe,
        AI_REQUEST_COMPLETED: _observe,
        AI_EVALUATION_COMPLETED: _observe,
    }


def build_repository(settings: Settings) -> AiRepository:
    if settings.ai_repository == "memory":
        return InMemoryAiRepository()
    return PostgresAiRepository(PostgresDatabase(settings))


def build_consumer(settings: Settings) -> EventConsumer:
    return EventConsumer(
        store=build_event_store(settings),
        consumer_group=settings.ai_event_consumer_group,
        handlers=build_default_handlers(build_repository(settings)),
        max_attempts=settings.ai_event_max_attempts,
        batch_size=settings.ai_event_batch_size,
        retry_base_seconds=settings.ai_event_retry_base_seconds,
        retry_max_seconds=settings.ai_event_retry_max_seconds,
        retry_jitter=settings.ai_event_retry_jitter,
        worker_id=f"{socket.gethostname()}:{uuid.uuid4().hex[:12]}",
        claim_lease_seconds=settings.ai_event_claim_lease_seconds,
    )


async def _record_backlog(consumer: EventConsumer) -> None:
    try:
        with system_scope():
            backlog = await consumer.store.delivery_backlog()
        record_event_backlog(
            pending=int(backlog.get("pending", 0)),
            delayed=int(backlog.get("delayed", 0)),
            dead=int(backlog.get("dead", 0)),
            oldest_pending_seconds=float(backlog.get("oldest_pending_seconds", 0.0)),
        )
    except Exception as exc:  # noqa: BLE001 - metrics must not stop consumption
        logger.warning("event.backlog_metrics_failed", error=str(exc)[:200])


def default_stale_seconds(settings: Settings) -> float:
    return max(60.0, settings.ai_event_poll_seconds * 4)


async def _cycle(consumer: EventConsumer, health: WorkerHealth) -> None:
    await consumer.process_batch()
    await _record_backlog(consumer)
    health.success()


async def run(
    *,
    once: bool,
    settings: Settings | None = None,
    health: WorkerHealth | None = None,
) -> None:
    settings = settings or get_settings()
    health = health or WorkerHealth(WORKER_NAME, default_stale_seconds(settings))
    consumer = build_consumer(settings)

    loop = asyncio.get_running_loop()
    _shutdown.clear()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown.set)
        except NotImplementedError:  # pragma: no cover - platform dependent
            pass

    if once:
        try:
            await _cycle(consumer, health)
        except Exception as exc:  # noqa: BLE001 - surface a failed one-shot run
            health.failure(exc)
            raise
        return
    logger.info(
        "event.consumer.started",
        poll_seconds=settings.ai_event_poll_seconds,
        consumer_group=settings.ai_event_consumer_group,
    )
    while not _shutdown.is_set():
        try:
            await _cycle(consumer, health)
        except Exception as exc:  # noqa: BLE001 - keep the durable consumer alive
            health.failure(exc)
            logger.warning("event.consumer.cycle_failed", error=str(exc)[:500])
        try:
            await asyncio.wait_for(
                _shutdown.wait(), timeout=settings.ai_event_poll_seconds
            )
        except TimeoutError:
            pass
    health.mark_shutdown()
    logger.info("event.consumer.stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description="AI event consumer worker")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--once", action="store_true", help="drain backlog then exit")
    group.add_argument("--watch", action="store_true", help="poll continuously")
    parser.add_argument(
        "--metrics-port", type=int, default=0, help="expose health and metrics on this port"
    )
    parser.add_argument(
        "--health-stale-seconds",
        type=float,
        default=0.0,
        help="readiness fails when the last successful cycle is older than this",
    )
    args = parser.parse_args()
    settings = get_settings()
    configure_logging(settings.ai_api_log_level, json_logs=settings.is_production)
    stale = args.health_stale_seconds or default_stale_seconds(settings)
    health = WorkerHealth(WORKER_NAME, stale)
    start_health_server(
        args.metrics_port,
        health,
        metrics_token=settings.ai_metrics_auth_token.get_secret_value(),
    )
    asyncio.run(run(once=not args.watch, settings=settings, health=health))


if __name__ == "__main__":
    main()
