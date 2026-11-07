from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    AgentMemoryServiceDep,
    AgentMonitoringServiceDep,
    AgentScheduleServiceDep,
    PaginationDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.agent_executions import (
    AgentExecutionStatsOut,
    AgentHealthOut,
    AgentMonitoringOverviewOut,
)
from ai_api.schemas.agent_memory import (
    AgentMemoryOut,
    AgentMemoryPage,
    AgentMemoryWriteRequest,
)
from ai_api.schemas.agent_schedules import (
    AgentScheduleCreateRequest,
    AgentScheduleOut,
    AgentSchedulePage,
    AgentScheduleUpdateRequest,
)
from ai_api.security.permissions import (
    CAP_AGENTS_EXECUTE,
    CAP_AGENTS_MANAGE,
    CAP_AGENTS_READ,
)

router = APIRouter(tags=["agent-operations"], dependencies=[Depends(enforce_rate_limit)])


# --- Monitoring -----------------------------------------------------------


@router.get(
    "/agent-monitoring/overview",
    response_model=AgentMonitoringOverviewOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def monitoring_overview(
    principal: PrincipalDep, service: AgentMonitoringServiceDep
) -> AgentMonitoringOverviewOut:
    data = await service.overview(principal)
    return AgentMonitoringOverviewOut(**data)


@router.get(
    "/agent-monitoring/failures",
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def monitoring_failures(
    principal: PrincipalDep,
    service: AgentMonitoringServiceDep,
    pagination: PaginationDep,
    agent_id: int | None = Query(default=None, ge=1),
) -> dict:
    items = await service.failures(principal, agent_id=agent_id, limit=pagination.limit)
    return {"items": items, "total": len(items)}


@router.get(
    "/agents/{agent_id}/stats",
    response_model=AgentExecutionStatsOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def agent_stats(
    agent_id: int, principal: PrincipalDep, service: AgentMonitoringServiceDep
) -> AgentExecutionStatsOut:
    data = await service.agent_stats(principal, agent_id)
    return AgentExecutionStatsOut(**data["executions"])


@router.get(
    "/agents/{agent_id}/health",
    response_model=AgentHealthOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def agent_health(
    agent_id: int, principal: PrincipalDep, service: AgentMonitoringServiceDep
) -> AgentHealthOut:
    return AgentHealthOut(**await service.health(principal, agent_id))


@router.get(
    "/agent-executions/{execution_id}/delegations",
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def execution_delegations(
    execution_id: int, principal: PrincipalDep, service: AgentMonitoringServiceDep
) -> dict:
    return await service.delegations(principal, execution_id)


# --- Schedules ------------------------------------------------------------


@router.post(
    "/agent-schedules",
    response_model=AgentScheduleOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_AGENTS_EXECUTE))],
)
async def create_agent_schedule(
    payload: AgentScheduleCreateRequest,
    principal: PrincipalDep,
    service: AgentScheduleServiceDep,
) -> AgentScheduleOut:
    return AgentScheduleOut(**await service.create(principal, payload))


@router.get(
    "/agent-schedules",
    response_model=AgentSchedulePage,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def list_agent_schedules(
    principal: PrincipalDep,
    service: AgentScheduleServiceDep,
    pagination: PaginationDep,
    agent_id: int | None = Query(default=None, ge=1),
    enabled: bool | None = Query(default=None),
) -> AgentSchedulePage:
    items, total = await service.list(
        principal,
        agent_id=agent_id,
        enabled=enabled,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return AgentSchedulePage(
        items=[AgentScheduleOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.get(
    "/agent-schedules/{schedule_id}",
    response_model=AgentScheduleOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def get_agent_schedule(
    schedule_id: int, principal: PrincipalDep, service: AgentScheduleServiceDep
) -> AgentScheduleOut:
    return AgentScheduleOut(**await service.get(principal, schedule_id))


@router.patch(
    "/agent-schedules/{schedule_id}",
    response_model=AgentScheduleOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def update_agent_schedule(
    schedule_id: int,
    payload: AgentScheduleUpdateRequest,
    principal: PrincipalDep,
    service: AgentScheduleServiceDep,
) -> AgentScheduleOut:
    return AgentScheduleOut(**await service.update(principal, schedule_id, payload))


@router.delete(
    "/agent-schedules/{schedule_id}",
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def delete_agent_schedule(
    schedule_id: int, principal: PrincipalDep, service: AgentScheduleServiceDep
) -> dict:
    return await service.delete(principal, schedule_id)


# --- Memory ---------------------------------------------------------------


@router.get(
    "/agent-memory",
    response_model=AgentMemoryPage,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def list_agent_memory(
    principal: PrincipalDep,
    service: AgentMemoryServiceDep,
    pagination: PaginationDep,
    agent_id: int | None = Query(default=None, ge=1),
    scope: str | None = Query(default=None, pattern=r"^(execution|conversation|agent)$"),
    execution_id: int | None = Query(default=None, ge=1),
    conversation_id: int | None = Query(default=None, ge=1),
    include_expired: bool = Query(default=False),
) -> AgentMemoryPage:
    items, total = await service.list(
        principal,
        agent_id=agent_id,
        scope=scope,
        execution_id=execution_id,
        conversation_id=conversation_id,
        include_expired=include_expired,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return AgentMemoryPage(
        items=[AgentMemoryOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/agent-memory",
    response_model=AgentMemoryOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_AGENTS_EXECUTE))],
)
async def write_agent_memory(
    payload: AgentMemoryWriteRequest,
    principal: PrincipalDep,
    service: AgentMemoryServiceDep,
) -> AgentMemoryOut:
    return AgentMemoryOut(**await service.write(principal, payload))


@router.delete(
    "/agent-memory/{entry_id}",
    response_model=AgentMemoryOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_EXECUTE))],
)
async def delete_agent_memory(
    entry_id: int, principal: PrincipalDep, service: AgentMemoryServiceDep
) -> AgentMemoryOut:
    return AgentMemoryOut(**await service.delete(principal, entry_id))


@router.post(
    "/agent-memory/purge",
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def purge_agent_memory(
    principal: PrincipalDep, service: AgentMemoryServiceDep
) -> dict:
    return await service.purge_expired(principal)
