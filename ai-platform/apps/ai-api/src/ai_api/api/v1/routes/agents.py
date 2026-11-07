from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    AgentRegistryServiceDep,
    AgentServiceDep,
    AgentTemplateServiceDep,
    AgentToolServiceDep,
    PaginationDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.agent_tools import (
    AgentToolCreateRequest,
    AgentToolDetailOut,
    AgentToolOut,
    AgentToolUpdateRequest,
    AgentToolValidationOut,
    AgentToolVersionCreateRequest,
    AgentToolVersionOut,
)
from ai_api.schemas.agents import (
    AgentActivateRequest,
    AgentCreateRequest,
    AgentDeleteRequest,
    AgentDetailOut,
    AgentDisableRequest,
    AgentDuplicateRequest,
    AgentExecuteRequest,
    AgentExecuteResponse,
    AgentExecutionOut,
    AgentExecutionPage,
    AgentPublishRequest,
    AgentRollbackRequest,
    AgentSuspendRequest,
    AgentTemplateInstantiateRequest,
    AgentTemplateOut,
    AgentUpdateRequest,
    AgentValidateRequest,
    AgentValidationOut,
    AgentVersionOut,
    AgentVersionToolOut,
    AgentWorkingConfigOut,
)
from ai_api.security.permissions import (
    CAP_AGENT_TOOLS_MANAGE,
    CAP_AGENT_TOOLS_READ,
    CAP_AGENTS_EXECUTE,
    CAP_AGENTS_MANAGE,
    CAP_AGENTS_READ,
)

router = APIRouter(tags=["agents"], dependencies=[Depends(enforce_rate_limit)])


@router.get(
    "/agents",
    response_model=list[AgentDetailOut],
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def list_agents(
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
    pagination: PaginationDep,
    query: str | None = Query(default=None, max_length=200),
    lifecycle_status: str | None = Query(default=None, max_length=32),
    category: str | None = Query(default=None, max_length=100),
) -> list[AgentDetailOut]:
    items, _ = await service.list_agents(
        principal,
        query=query,
        lifecycle_status=lifecycle_status,
        category=category,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return [AgentDetailOut(**agent) for agent in items]


@router.post(
    "/agents",
    response_model=AgentDetailOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def create_agent(
    payload: AgentCreateRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(**await service.create_draft(principal, payload))


@router.get(
    "/agents/executions",
    response_model=AgentExecutionPage,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def list_agent_executions(
    principal: PrincipalDep,
    service: AgentServiceDep,
    pagination: PaginationDep,
    agent_id: int | None = Query(default=None),
) -> AgentExecutionPage:
    items, total = await service.list_executions(
        principal, agent_id=agent_id, limit=pagination.limit, offset=pagination.offset
    )
    return AgentExecutionPage(
        items=[AgentExecutionOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.get(
    "/agents/{agent_id}",
    response_model=AgentDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def get_agent(
    agent_id: int, principal: PrincipalDep, service: AgentRegistryServiceDep
) -> AgentDetailOut:
    return AgentDetailOut(**await service.get_agent(principal, agent_id))


@router.patch(
    "/agents/{agent_id}",
    response_model=AgentDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def update_agent(
    agent_id: int,
    payload: AgentUpdateRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(
        **await service.update_draft(principal, agent_id, payload)
    )


@router.post(
    "/agents/{agent_id}/validate",
    response_model=AgentValidationOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def validate_agent(
    agent_id: int,
    payload: AgentValidateRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentValidationOut:
    return AgentValidationOut(
        **await service.validate_agent(principal, agent_id, payload.version_id)
    )


@router.post(
    "/agents/{agent_id}/publish",
    response_model=AgentDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def publish_agent(
    agent_id: int,
    payload: AgentPublishRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(**await service.publish(principal, agent_id, payload))


@router.post(
    "/agents/{agent_id}/disable",
    response_model=AgentDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def disable_agent(
    agent_id: int,
    payload: AgentDisableRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(**await service.disable(principal, agent_id, payload.reason))


@router.post(
    "/agents/{agent_id}/rollback",
    response_model=AgentDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def rollback_agent(
    agent_id: int,
    payload: AgentRollbackRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(
        **await service.rollback(principal, agent_id, payload.version_id)
    )


@router.get(
    "/agents/{agent_id}/versions",
    response_model=list[AgentVersionOut],
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def list_agent_versions(
    agent_id: int, principal: PrincipalDep, service: AgentRegistryServiceDep
) -> list[AgentVersionOut]:
    return [
        AgentVersionOut(**version)
        for version in await service.list_versions(principal, agent_id)
    ]


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


@router.get(
    "/agents/{agent_id}/versions/{version_id}/tools",
    response_model=list[AgentVersionToolOut],
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def list_agent_version_tools(
    agent_id: int,
    version_id: int,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> list[AgentVersionToolOut]:
    return [
        AgentVersionToolOut(**tool)
        for tool in await service.get_version_tools(principal, agent_id, version_id)
    ]


@router.post(
    "/agents/{agent_id}/activate",
    response_model=AgentDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def activate_agent(
    agent_id: int,
    payload: AgentActivateRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(
        **await service.activate(
            principal, agent_id, version_id=payload.version_id, note=payload.note
        )
    )


@router.post(
    "/agents/{agent_id}/deactivate",
    response_model=AgentDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def deactivate_agent(
    agent_id: int,
    payload: AgentActivateRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(
        **await service.deactivate(principal, agent_id, payload.note)
    )


@router.post(
    "/agents/{agent_id}/suspend",
    response_model=AgentDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def suspend_agent(
    agent_id: int,
    payload: AgentSuspendRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(**await service.suspend(principal, agent_id, payload.reason))


@router.post(
    "/agents/{agent_id}/duplicate",
    response_model=AgentDetailOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def duplicate_agent(
    agent_id: int,
    payload: AgentDuplicateRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(**await service.duplicate(principal, agent_id, payload))


@router.delete(
    "/agents/{agent_id}",
    response_model=AgentDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def delete_agent(
    agent_id: int,
    payload: AgentDeleteRequest,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(**await service.delete(principal, agent_id, payload))


@router.get(
    "/agents/{agent_id}/working-config",
    response_model=AgentWorkingConfigOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def get_working_config(
    agent_id: int, principal: PrincipalDep, service: AgentRegistryServiceDep
) -> AgentWorkingConfigOut:
    agent = await service.get_agent(principal, agent_id)
    return AgentWorkingConfigOut(
        agent_id=agent_id,
        working_config=agent.get("working_config") or {},
        lock_version=int(agent.get("lock_version") or 1),
    )


@router.put(
    "/agents/{agent_id}/working-config",
    response_model=AgentWorkingConfigOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def update_working_config(
    agent_id: int,
    payload: dict,
    principal: PrincipalDep,
    service: AgentRegistryServiceDep,
) -> AgentWorkingConfigOut:
    agent = await service.update_working_config(principal, agent_id, payload)
    return AgentWorkingConfigOut(
        agent_id=agent_id,
        working_config=agent.get("working_config") or {},
        lock_version=int(agent.get("lock_version") or 1),
    )


@router.get(
    "/agent-templates",
    response_model=list[AgentTemplateOut],
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def list_agent_templates(
    principal: PrincipalDep,
    service: AgentTemplateServiceDep,
    pagination: PaginationDep,
    category: str | None = Query(default=None, max_length=100),
) -> list[AgentTemplateOut]:
    items, _ = await service.list(
        principal, category=category, limit=pagination.limit, offset=pagination.offset
    )
    return [AgentTemplateOut(**item) for item in items]


@router.get(
    "/agent-templates/{template_id}",
    response_model=AgentTemplateOut,
    dependencies=[Depends(require_capability(CAP_AGENTS_READ))],
)
async def get_agent_template(
    template_id: int, principal: PrincipalDep, service: AgentTemplateServiceDep
) -> AgentTemplateOut:
    return AgentTemplateOut(**await service.get(principal, template_id))


@router.post(
    "/agent-templates/{template_id}/instantiate",
    response_model=AgentDetailOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_AGENTS_MANAGE))],
)
async def instantiate_agent_template(
    template_id: int,
    payload: AgentTemplateInstantiateRequest,
    principal: PrincipalDep,
    service: AgentTemplateServiceDep,
) -> AgentDetailOut:
    return AgentDetailOut(**await service.instantiate(principal, template_id, payload))


@router.get(
    "/agent-tools",
    response_model=list[AgentToolOut],
    dependencies=[Depends(require_capability(CAP_AGENT_TOOLS_READ))],
)
async def list_agent_tools(
    principal: PrincipalDep,
    service: AgentToolServiceDep,
    pagination: PaginationDep,
    query: str | None = Query(default=None, max_length=200),
    enabled: bool | None = Query(default=None),
) -> list[AgentToolOut]:
    items, _ = await service.list_tools(
        principal,
        query=query,
        enabled=enabled,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return [AgentToolOut(**tool) for tool in items]


@router.post(
    "/agent-tools",
    response_model=AgentToolDetailOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_AGENT_TOOLS_MANAGE))],
)
async def create_agent_tool(
    payload: AgentToolCreateRequest,
    principal: PrincipalDep,
    service: AgentToolServiceDep,
) -> AgentToolDetailOut:
    return AgentToolDetailOut(**await service.create_tool(principal, payload))


@router.get(
    "/agent-tools/{tool_id}",
    response_model=AgentToolDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENT_TOOLS_READ))],
)
async def get_agent_tool(
    tool_id: int, principal: PrincipalDep, service: AgentToolServiceDep
) -> AgentToolDetailOut:
    return AgentToolDetailOut(**await service.get_tool(principal, tool_id))


@router.patch(
    "/agent-tools/{tool_id}",
    response_model=AgentToolDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENT_TOOLS_MANAGE))],
)
async def update_agent_tool(
    tool_id: int,
    payload: AgentToolUpdateRequest,
    principal: PrincipalDep,
    service: AgentToolServiceDep,
) -> AgentToolDetailOut:
    return AgentToolDetailOut(**await service.update_tool(principal, tool_id, payload))


@router.get(
    "/agent-tools/{tool_id}/versions",
    response_model=list[AgentToolVersionOut],
    dependencies=[Depends(require_capability(CAP_AGENT_TOOLS_READ))],
)
async def list_agent_tool_versions(
    tool_id: int, principal: PrincipalDep, service: AgentToolServiceDep
) -> list[AgentToolVersionOut]:
    return [
        AgentToolVersionOut(**version)
        for version in await service.list_versions(principal, tool_id)
    ]


@router.post(
    "/agent-tools/{tool_id}/versions",
    response_model=AgentToolVersionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_AGENT_TOOLS_MANAGE))],
)
async def create_agent_tool_version(
    tool_id: int,
    payload: AgentToolVersionCreateRequest,
    principal: PrincipalDep,
    service: AgentToolServiceDep,
) -> AgentToolVersionOut:
    return AgentToolVersionOut(
        **await service.create_version(principal, tool_id, payload)
    )


@router.post(
    "/agent-tools/{tool_id}/validate",
    response_model=AgentToolValidationOut,
    dependencies=[Depends(require_capability(CAP_AGENT_TOOLS_MANAGE))],
)
async def validate_agent_tool(
    tool_id: int,
    principal: PrincipalDep,
    service: AgentToolServiceDep,
    version_id: int | None = Query(default=None),
) -> AgentToolValidationOut:
    return AgentToolValidationOut(
        **await service.validate(principal, tool_id, version_id)
    )


@router.post(
    "/agent-tools/{tool_id}/publish",
    response_model=AgentToolDetailOut,
    dependencies=[Depends(require_capability(CAP_AGENT_TOOLS_MANAGE))],
)
async def publish_agent_tool(
    tool_id: int,
    principal: PrincipalDep,
    service: AgentToolServiceDep,
    version_id: int | None = Query(default=None),
) -> AgentToolDetailOut:
    return AgentToolDetailOut(
        **await service.publish(principal, tool_id, version_id)
    )
