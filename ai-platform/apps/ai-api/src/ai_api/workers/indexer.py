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
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.indexing_service import IndexingService
from ai_api.application.services.ingestion_service import IngestionService
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.config.settings import Settings, get_settings
from ai_api.infrastructure.db import PostgresDatabase
from ai_api.infrastructure.providers.registry import build_default_registry
from ai_api.infrastructure.repositories import InMemoryAiRepository, PostgresAiRepository
from ai_api.infrastructure.search import build_search_backend
from ai_api.infrastructure.storage import build_object_storage
from ai_api.security.policies import Policy
from ai_api.telemetry.langfuse import LangfusePublisher
from ai_api.telemetry.logging import configure_logging, get_logger
from ai_api.telemetry.metrics import record_job_metrics
from ai_api.workers.health import WorkerHealth, start_health_server

logger = get_logger("worker.indexer")
WORKER_NAME = "indexer"

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
        repository=repository,
        gateway=gateway,
        audit=AuditService(repository),
        settings=settings,
        storage=build_object_storage(settings),
        search=build_search_backend(settings, repository),
        governance=GovernanceService(repository),
        policy=Policy(),
    )
    return IndexingService(
        repository=repository, ingestion=ingestion, settings=settings
    )


async def _drain(service: IndexingService, settings: Settings) -> int:
    await service.reclaim_stale_jobs()
    results = await service.process_queued(limit=settings.ai_worker_batch_size)
    processed = sum(1 for item in results if item is not None)
    if processed:
        logger.info("indexer.batch_processed", count=processed)
    try:
        metrics = await service.metrics()
        record_job_metrics(
            by_status=metrics.get("by_status", {}),
            security_overdue=int(metrics.get("security_refresh_overdue", 0)),
        )
    except Exception as exc:  # noqa: BLE001 - metrics must not stop indexing
        logger.warning("indexer.metrics_failed", error=str(exc)[:200])
    return processed


def default_stale_seconds(settings: Settings) -> float:
    return max(
        300.0,
        settings.ai_worker_batch_size * settings.ai_job_timeout_seconds
        + settings.ai_worker_poll_seconds * 3,
    )


async def run(
    *,
    once: bool,
    settings: Settings | None = None,
    health: WorkerHealth | None = None,
) -> None:
    settings = settings or get_settings()
    health = health or WorkerHealth(WORKER_NAME, default_stale_seconds(settings))
    service = _build_service(settings)

    loop = asyncio.get_running_loop()
    _shutdown.clear()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown.set)
        except NotImplementedError:  # pragma: no cover - platform dependent
            pass

    if once:
        try:
            await _drain(service, settings)
        except Exception as exc:  # noqa: BLE001 - surface a failed one-shot run
            health.failure(exc)
            raise
        health.success()
        return

    logger.info("indexer.started", poll_seconds=settings.ai_worker_poll_seconds)
    while not _shutdown.is_set():
        try:
            processed = await _drain(service, settings)
            health.success()
        except Exception as exc:  # noqa: BLE001 - retry on the next poll
            processed = 0
            health.failure(exc)
            logger.warning("indexer.cycle_failed", error=str(exc)[:500])
        if processed == 0:
            try:
                await asyncio.wait_for(_shutdown.wait(), timeout=settings.ai_worker_poll_seconds)
            except TimeoutError:
                pass
    health.mark_shutdown()
    logger.info("indexer.stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description="AI knowledge indexer worker")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--once", action="store_true", help="process backlog then exit")
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
