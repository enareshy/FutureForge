from __future__ import annotations

from fastapi import APIRouter, Depends

from ai_api.api.deps import AgentServiceDep, PrincipalDep, enforce_rate_limit, require_capability
from ai_api.schemas.agents import AgentExecuteRequest, AgentExecuteResponse, AgentOut
from ai_api.security.permissions import CAP_AGENTS_EXECUTE, CAP_AGENTS_READ

router = APIRouter(tags=["agents"], dependencies=[Depends(enforce_rate_limit)])


@router.get(
    "/agents",
    response_model=list[AgentOut],
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def list_agents(principal: PrincipalDep, service: AgentServiceDep) -> list[AgentOut]:
    return [AgentOut(**agent) for agent in await service.list_agents(principal)]


@router.get(
    "/agents/{agent_id}",
    response_model=AgentOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def get_agent(agent_id: int, principal: PrincipalDep, service: AgentServiceDep) -> AgentOut:
    return AgentOut(**await service.get_agent(principal, agent_id))


@router.post(
    "/agents/{agent_id}/execute",
    response_model=AgentExecuteResponse,
    dependencies=[Depends(require_capability(CAP_AGENTS_EXECUTE))],
)
async def execute_agent(
    agent_id: int,
    payload: AgentExecuteRequest,
    principal: PrincipalDep,
    service: AgentServiceDep,
) -> AgentExecuteResponse:
    return AgentExecuteResponse(**await service.execute(principal, agent_id, payload))
