"""Indexer worker: drains queued knowledge-index jobs.

Usage:
    python -m ai_api.workers.indexer --once     # process the current backlog and exit
    python -m ai_api.workers.indexer --watch    # poll continuously

Job execution is idempotent: completed jobs are skipped, retries increment the
attempt counter, and failures are recorded on the job row (status `failed`) with
a bounded error message. Kafka-based decoupling arrives in Phase 8.
"""

from __future__ import annotations

import argparse
import asyncio
import signal

from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.indexing_service import IndexingService
from ai_api.application.services.ingestion_service import IngestionService
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.config.settings import Settings, get_settings
from ai_api.infrastructure.db import PostgresDatabase
from ai_api.infrastructure.providers.registry import build_default_registry
from ai_api.infrastructure.repositories import InMemoryAiRepository, PostgresAiRepository
from ai_api.telemetry.langfuse import LangfusePublisher
from ai_api.telemetry.logging import configure_logging, get_logger
from ai_api.telemetry.metrics_server import start_metrics_server

logger = get_logger("worker.indexer")

_shutdown = asyncio.Event()


def _build_service(settings: Settings) -> IndexingService:
    if settings.ai_repository == "memory":
        repository = InMemoryAiRepository()
    else:
        repository = PostgresAiRepository(PostgresDatabase(settings))
    gateway = ModelGateway(
        registry=build_default_registry(settings),
        settings=settings,
        langfuse=LangfusePublisher(
            host=settings.langfuse_host,
            public_key=settings.langfuse_public_key,
            secret_key=settings.langfuse_secret_key,
        ),
    )
    ingestion = IngestionService(
        repository=repository, gateway=gateway, audit=AuditService(repository), settings=settings
    )
    return IndexingService(repository=repository, ingestion=ingestion)


async def _drain(service: IndexingService, settings: Settings) -> int:
    results = await service.process_queued(limit=settings.ai_worker_batch_size)
    processed = sum(1 for item in results if item is not None)
    if processed:
        logger.info("indexer.batch_processed", count=processed)
    return processed


async def run(*, once: bool, settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    service = _build_service(settings)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown.set)
        except NotImplementedError:  # pragma: no cover - platform dependent
            pass

    if once:
        await _drain(service, settings)
        return

    logger.info("indexer.started", poll_seconds=settings.ai_worker_poll_seconds)
    while not _shutdown.is_set():
        processed = await _drain(service, settings)
        if processed == 0:
            try:
                await asyncio.wait_for(_shutdown.wait(), timeout=settings.ai_worker_poll_seconds)
            except TimeoutError:
                pass
    logger.info("indexer.stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description="AI knowledge indexer worker")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--once", action="store_true", help="process backlog then exit")
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
