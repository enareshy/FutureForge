"""Agent execution worker: claims queued Stage 6 executions and runs them.

Usage:
    python -m ai_api.workers.agent --once
    python -m ai_api.workers.agent --watch

Claims use ``FOR UPDATE SKIP LOCKED`` with leases, so multiple workers can run
safely and expired leases are reclaimed. Paused executions waiting for human
approval are released by the approval service, not by this worker.
"""

from __future__ import annotations

import argparse
import asyncio
import signal
import socket
import uuid

from ai_api.application.services.agent_execution_service import AgentExecutionService
from ai_api.application.services.agent_memory_service import AgentMemoryService
from ai_api.application.services.agent_schedule_service import AgentScheduleService
from ai_api.application.services.agent_tool_service import AgentToolService
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.bom_service import BomService
from ai_api.application.services.enterprise_tools import (
    build_enterprise_tool_client,
)
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.graph_query_service import GraphQueryService
from ai_api.application.services.graph_service import GraphService
from ai_api.application.services.manufacturing_service import ManufacturingService
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.application.services.predictive_service import PredictiveService
from ai_api.application.services.product_service import ProductService
from ai_api.application.services.quality_service import QualityService
from ai_api.application.services.retrieval_service import RetrievalService
from ai_api.config.settings import Settings, get_settings
from ai_api.infrastructure.db import PostgresDatabase, system_scope, tenant_scope
from ai_api.infrastructure.providers.registry import build_default_registry
from ai_api.infrastructure.repositories import (
    InMemoryAiRepository,
    PostgresAiRepository,
)
from ai_api.infrastructure.search import build_search_backend
from ai_api.security.access_control import AccessControl
from ai_api.security.permissions import build_permission_map
from ai_api.security.policies import PermissionMap, Policy
from ai_api.telemetry.langfuse import LangfusePublisher
from ai_api.telemetry.logging import configure_logging, get_logger
from ai_api.workers.health import WorkerHealth, start_health_server

logger = get_logger("worker.agent")
WORKER_NAME = "agent"

_shutdown = asyncio.Event()


def _build_services(
    settings: Settings,
) -> tuple[AgentExecutionService, AgentScheduleService]:
    if settings.ai_repository == "memory":
        repository = InMemoryAiRepository()
    else:
        repository = PostgresAiRepository(PostgresDatabase(settings))
    audit = AuditService(repository)
    policy = Policy()
    gateway = ModelGateway(
        registry=build_default_registry(settings),
        settings=settings,
        langfuse=LangfusePublisher(
            host=settings.langfuse_host,
            public_key=settings.langfuse_public_key,
            secret_key=settings.langfuse_secret_key,
        ),
    )
    retrieval = RetrievalService(
        gateway=gateway,
        repository=repository,
        audit=audit,
        access=AccessControl(policy=policy),
        governance=GovernanceService(repository=repository),
        settings=settings,
        events=None,
        search_backend=build_search_backend(settings, repository),
    )
    tools = AgentToolService(repository=repository, audit=audit, policy=policy)
    memory = AgentMemoryService(repository=repository, audit=audit, policy=policy)
    # Enterprise Stage 8-10 tools must be wired exactly as the API wires them,
    # otherwise workflow agents that call product/BOM/manufacturing/quality/
    # predictive tools fail with "tool implementation is not enabled" when run
    # by the worker (the real deployment path, not the in-process test path).
    access = AccessControl(policy=policy)
    governance = GovernanceService(repository=repository)
    events = EventPublisher(sinks=())
    graph = GraphService(
        repository=repository,
        audit=audit,
        access=access,
        governance=governance,
        events=events,
    )
    graph_query = GraphQueryService(repository=repository, graph=graph, audit=audit)
    products = ProductService(
        repository=repository,
        audit=audit,
        access=access,
        governance=governance,
        graph=graph,
        events=events,
    )
    boms = BomService(
        repository=repository,
        products=products,
        audit=audit,
        graph=graph,
        graph_query=graph_query,
        events=events,
    )
    manufacturing = ManufacturingService(
        repository=repository,
        products=products,
        audit=audit,
        access=access,
        governance=governance,
        graph=graph,
        events=events,
    )
    quality = QualityService(
        repository=repository,
        products=products,
        manufacturing=manufacturing,
        audit=audit,
        access=access,
        governance=governance,
        graph=graph,
        events=events,
    )
    predictive = PredictiveService(
        repository=repository,
        products=products,
        boms=boms,
        manufacturing=manufacturing,
        quality=quality,
        audit=audit,
        access=access,
        governance=governance,
        graph=graph,
        events=events,
        graph_query=graph_query,
        gateway=gateway,
        settings=settings,
    )
    enterprise_tools = build_enterprise_tool_client(
        settings,
        policy,
        graph=graph_query,
        products=products,
        boms=boms,
        manufacturing=manufacturing,
        quality=quality,
        predictive=predictive,
    )
    execution_service = AgentExecutionService(
        repository=repository,
        retrieval=retrieval,
        audit=audit,
        policy=policy,
        settings=settings,
        tools=tools,
        permissions=PermissionMap(build_permission_map(settings)),
        memory=memory,
        enterprise_tools=enterprise_tools,
    )
    schedule_service = AgentScheduleService(
        repository=repository,
        execution_service=execution_service,
        audit=audit,
        policy=policy,
    )
    return execution_service, schedule_service


async def _drain(service: AgentExecutionService, settings: Settings, worker_id: str) -> int:
    processed = 0
    for _ in range(max(1, settings.ai_agent_worker_batch_size)):
        with system_scope():
            execution = await service.repository.claim_agent_execution(
                worker_id=worker_id,
                lease_seconds=settings.ai_agent_execution_lease_seconds,
            )
        if execution is None:
            break
        logger.info(
            "agent.execution.claimed",
            execution_id=execution["id"],
            status=execution["status"],
        )
        with tenant_scope(execution["tenant_id"]):
            await service.run_claimed(execution)
        processed += 1
    return processed


def default_stale_seconds(settings: Settings) -> float:
    return max(900.0, settings.ai_agent_execution_lease_seconds * 2 + 120)


async def run(
    *,
    once: bool,
    settings: Settings | None = None,
    health: WorkerHealth | None = None,
) -> None:
    settings = settings or get_settings()
    health = health or WorkerHealth(WORKER_NAME, default_stale_seconds(settings))
    service, schedules = _build_services(settings)
    worker_id = f"{socket.gethostname()}:{uuid.uuid4().hex[:12]}"

    loop = asyncio.get_running_loop()
    _shutdown.clear()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown.set)
        except NotImplementedError:  # pragma: no cover - platform dependent
            pass

    async def cycle() -> int:
        with system_scope():
            enqueued = await schedules.run_due(limit=settings.ai_agent_worker_batch_size)
        if enqueued:
            logger.info("agent.schedule.enqueued", count=enqueued)
        return await _drain(service, settings, worker_id)

    if once:
        try:
            await cycle()
        except Exception as exc:  # noqa: BLE001 - surface a failed one-shot run
            health.failure(exc)
            raise
        health.success()
        return

    logger.info(
        "agent.worker.started",
        poll_seconds=settings.ai_worker_poll_seconds,
        worker_id=worker_id,
    )
    while not _shutdown.is_set():
        try:
            processed = await cycle()
            health.success()
        except Exception as exc:  # noqa: BLE001 - retry on the next poll
            processed = 0
            health.failure(exc)
            logger.warning("agent.worker.cycle_failed", error=str(exc)[:500])
        if processed == 0:
            try:
                await asyncio.wait_for(
                    _shutdown.wait(), timeout=settings.ai_worker_poll_seconds
                )
            except TimeoutError:
                pass
    health.mark_shutdown()
    logger.info("agent.worker.stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description="Stage 6 agent execution worker")
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
