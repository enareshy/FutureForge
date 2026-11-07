from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    AgentApprovalServiceDep,
    AgentExecutionServiceDep,
    PaginationDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.agent_executions import (
    AgentApprovalDecision,
    AgentApprovalOut,
    AgentApprovalPage,
    AgentExecutionCreateRequest,
    AgentExecutionOut,
    AgentExecutionPage,
)
from ai_api.security.permissions import (
    CAP_AGENT_APPROVALS_DECIDE,
    CAP_AGENT_APPROVALS_READ,
    CAP_AGENT_EXECUTIONS_MANAGE,
    CAP_AGENTS_EXECUTE,
    CAP_AGENTS_READ,
)

router = APIRouter(tags=["agent-executions"], dependencies=[Depends(enforce_rate_limit)])


@router.post(
    "/agent-executions",
    response_model=AgentExecutionOut,
    status_code=202,
    dependencies=[Depends(require_capability(CAP_AGENTS_EXECUTE))],
)
async def create_agent_execution(
    payload: AgentExecutionCreateRequest,
    principal: PrincipalDep,
    service: AgentExecutionServiceDep,
) -> AgentExecutionOut:
    return AgentExecutionOut(**await service.create(principal, payload))


@router.get(
    "/agent-executions",
    response_model=AgentExecutionPage,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def list_agent_executions(
    principal: PrincipalDep,
    service: AgentExecutionServiceDep,
    pagination: PaginationDep,
    state: str | None = Query(default=None, max_length=32),
    agent_id: int | None = Query(default=None, ge=1),
) -> AgentExecutionPage:
    items, total = await service.list(
        principal,
        state=state,
        agent_id=agent_id,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return AgentExecutionPage(
        items=[AgentExecutionOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.get(
    "/agent-executions/{execution_id}",
    response_model=AgentExecutionOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def get_agent_execution(
    execution_id: int, principal: PrincipalDep, service: AgentExecutionServiceDep
) -> AgentExecutionOut:
    return AgentExecutionOut(**await service.get(principal, execution_id))


@router.get(
    "/agent-executions/{execution_id}/trace",
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def get_agent_execution_trace(
    execution_id: int, principal: PrincipalDep, service: AgentExecutionServiceDep
) -> dict:
    return await service.trace(principal, execution_id)


@router.get(
    "/agent-executions/{execution_id}/result",
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def get_agent_execution_result(
    execution_id: int, principal: PrincipalDep, service: AgentExecutionServiceDep
) -> dict:
    return await service.result(principal, execution_id)


@router.post(
    "/agent-executions/{execution_id}/cancel",
    response_model=AgentExecutionOut,
    dependencies=[Depends(require_capability(CAP_AGENT_EXECUTIONS_MANAGE))],
)
async def cancel_agent_execution(
    execution_id: int, principal: PrincipalDep, service: AgentExecutionServiceDep
) -> AgentExecutionOut:
    return AgentExecutionOut(**await service.cancel(principal, execution_id))


@router.post(
    "/agent-executions/{execution_id}/retry",
    response_model=AgentExecutionOut,
    dependencies=[Depends(require_capability(CAP_AGENT_EXECUTIONS_MANAGE))],
)
async def retry_agent_execution(
    execution_id: int, principal: PrincipalDep, service: AgentExecutionServiceDep
) -> AgentExecutionOut:
    return AgentExecutionOut(**await service.retry(principal, execution_id))


@router.get(
    "/agent-approvals",
    response_model=AgentApprovalPage,
    dependencies=[Depends(require_capability(CAP_AGENT_APPROVALS_READ))],
)
async def list_agent_approvals(
    principal: PrincipalDep,
    service: AgentApprovalServiceDep,
    pagination: PaginationDep,
    status: str | None = Query(default=None, max_length=32),
) -> AgentApprovalPage:
    items, total = await service.list(
        principal, status=status, limit=pagination.limit, offset=pagination.offset
    )
    return AgentApprovalPage(
        items=[AgentApprovalOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.get(
    "/agent-approvals/{approval_id}",
    response_model=AgentApprovalOut,
    dependencies=[Depends(require_capability(CAP_AGENT_APPROVALS_READ))],
)
async def get_agent_approval(
    approval_id: int, principal: PrincipalDep, service: AgentApprovalServiceDep
) -> AgentApprovalOut:
    return AgentApprovalOut(**await service.get(principal, approval_id))


@router.post(
    "/agent-approvals/{approval_id}/approve",
    response_model=AgentApprovalOut,
    dependencies=[Depends(require_capability(CAP_AGENT_APPROVALS_DECIDE))],
)
async def approve_agent_operation(
    approval_id: int,
    payload: AgentApprovalDecision,
    principal: PrincipalDep,
    service: AgentApprovalServiceDep,
) -> AgentApprovalOut:
    return AgentApprovalOut(
        **await service.approve(principal, approval_id, payload.reason)
    )


@router.post(
    "/agent-approvals/{approval_id}/reject",
    response_model=AgentApprovalOut,
    dependencies=[Depends(require_capability(CAP_AGENT_APPROVALS_DECIDE))],
)
async def reject_agent_operation(
    approval_id: int,
    payload: AgentApprovalDecision,
    principal: PrincipalDep,
    service: AgentApprovalServiceDep,
) -> AgentApprovalOut:
    return AgentApprovalOut(
        **await service.reject(principal, approval_id, payload.reason)
    )
