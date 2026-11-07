from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import StreamingResponse

from ai_api.api.deps import (
    AssistantServiceDep,
    CopilotServiceDep,
    PaginationDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.agent_executions import AgentExecutionOut
from ai_api.schemas.assistant import (
    AssistantFeedbackCreate,
    ConversationCreate,
    ConversationDetailOut,
    ConversationOut,
    ConversationUpdate,
    CopilotActionCreate,
    CopilotActionDecision,
    CopilotActionOut,
    CopilotAgentRunRequest,
    CopilotCapabilitiesOut,
    CopilotTaskRequest,
    CopilotTaskResponse,
    MessageCreate,
    MessageOut,
    MessagePageOut,
)
from ai_api.schemas.common import Page, PageMeta
from ai_api.schemas.feedback import FeedbackOut
from ai_api.security.permissions import (
    CAP_AGENTS_EXECUTE,
    CAP_COPILOT_ACTIONS_DECIDE,
    CAP_COPILOT_ACTIONS_EXECUTE,
    CAP_COPILOT_ACTIONS_READ,
    CAP_FEEDBACK_WRITE,
    CAP_RETRIEVAL_RAG,
)

router = APIRouter(tags=["assistant"], dependencies=[Depends(enforce_rate_limit)])

_TASK_CAPABILITY = Depends(require_capability(CAP_RETRIEVAL_RAG))


@router.post(
    "/assistant/conversations",
    response_model=ConversationOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[_TASK_CAPABILITY],
)
async def create_conversation(
    payload: ConversationCreate, principal: PrincipalDep, service: CopilotServiceDep
) -> ConversationOut:
    return ConversationOut(**await service.create_conversation(principal, payload))


@router.get(
    "/assistant/conversations",
    response_model=Page[ConversationOut],
    dependencies=[_TASK_CAPABILITY],
)
async def list_conversations(
    principal: PrincipalDep,
    service: CopilotServiceDep,
    pagination: PaginationDep,
    mine: bool = Query(default=True),
) -> Page[ConversationOut]:
    items, total = await service.list_conversations(
        principal, mine=mine, limit=pagination.limit, offset=pagination.offset
    )
    return Page[ConversationOut](
        items=[ConversationOut(**item) for item in items],
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )


@router.get(
    "/assistant/capabilities",
    response_model=CopilotCapabilitiesOut,
    dependencies=[_TASK_CAPABILITY],
)
async def capabilities(
    principal: PrincipalDep, service: CopilotServiceDep
) -> CopilotCapabilitiesOut:
    return CopilotCapabilitiesOut(**await service.capabilities(principal))


@router.get(
    "/assistant/conversations/{conversation_id}",
    response_model=ConversationDetailOut,
    dependencies=[_TASK_CAPABILITY],
)
async def get_conversation(
    conversation_id: int,
    principal: PrincipalDep,
    service: CopilotServiceDep,
    pagination: PaginationDep,
) -> ConversationDetailOut:
    detail = await service.get_conversation(
        principal,
        conversation_id,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return ConversationDetailOut(**detail)


@router.patch(
    "/assistant/conversations/{conversation_id}",
    response_model=ConversationOut,
    dependencies=[_TASK_CAPABILITY],
)
async def update_conversation(
    conversation_id: int,
    payload: ConversationUpdate,
    principal: PrincipalDep,
    service: CopilotServiceDep,
) -> ConversationOut:
    return ConversationOut(
        **await service.update_conversation(principal, conversation_id, payload)
    )


@router.delete(
    "/assistant/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[_TASK_CAPABILITY],
)
async def delete_conversation(
    conversation_id: int, principal: PrincipalDep, service: CopilotServiceDep
) -> None:
    await service.delete_conversation(principal, conversation_id)


@router.get(
    "/assistant/conversations/{conversation_id}/messages",
    response_model=MessagePageOut,
    dependencies=[_TASK_CAPABILITY],
)
async def list_messages(
    conversation_id: int,
    principal: PrincipalDep,
    service: CopilotServiceDep,
    pagination: PaginationDep,
) -> MessagePageOut:
    return MessagePageOut(
        **await service.list_messages(
            principal,
            conversation_id,
            limit=pagination.limit,
            offset=pagination.offset,
        )
    )


@router.post(
    "/assistant/conversations/{conversation_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[_TASK_CAPABILITY],
)
async def create_message(
    conversation_id: int,
    payload: MessageCreate,
    principal: PrincipalDep,
    service: CopilotServiceDep,
) -> MessageOut:
    return MessageOut(**await service.ask(principal, conversation_id, payload))


@router.post(
    "/assistant/conversations/{conversation_id}/messages/stream",
    dependencies=[_TASK_CAPABILITY],
)
async def stream_message(
    conversation_id: int,
    payload: MessageCreate,
    principal: PrincipalDep,
    service: CopilotServiceDep,
) -> StreamingResponse:
    plan = await service.prepare_stream(principal, conversation_id, payload)
    return StreamingResponse(
        service.stream_events(principal, plan),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/assistant/conversations/{conversation_id}/cancel",
    dependencies=[_TASK_CAPABILITY],
)
async def cancel_generation(
    conversation_id: int, principal: PrincipalDep, service: CopilotServiceDep
) -> dict:
    return await service.cancel(principal, conversation_id)


@router.post(
    "/assistant/summarize",
    response_model=CopilotTaskResponse,
    dependencies=[_TASK_CAPABILITY],
)
async def summarize(
    payload: CopilotTaskRequest, principal: PrincipalDep, service: CopilotServiceDep
) -> CopilotTaskResponse:
    return CopilotTaskResponse(
        **await service.task(principal, "summarize", payload)
    )


@router.post(
    "/assistant/explain",
    response_model=CopilotTaskResponse,
    dependencies=[_TASK_CAPABILITY],
)
async def explain(
    payload: CopilotTaskRequest, principal: PrincipalDep, service: CopilotServiceDep
) -> CopilotTaskResponse:
    return CopilotTaskResponse(**await service.task(principal, "explain", payload))


@router.post(
    "/assistant/compare",
    response_model=CopilotTaskResponse,
    dependencies=[_TASK_CAPABILITY],
)
async def compare(
    payload: CopilotTaskRequest, principal: PrincipalDep, service: CopilotServiceDep
) -> CopilotTaskResponse:
    return CopilotTaskResponse(**await service.task(principal, "compare", payload))


@router.post(
    "/assistant/extract",
    response_model=CopilotTaskResponse,
    dependencies=[_TASK_CAPABILITY],
)
async def extract(
    payload: CopilotTaskRequest, principal: PrincipalDep, service: CopilotServiceDep
) -> CopilotTaskResponse:
    return CopilotTaskResponse(**await service.task(principal, "extract", payload))


@router.post(
    "/assistant/feedback",
    response_model=FeedbackOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_capability(CAP_FEEDBACK_WRITE))],
)
async def assistant_feedback(
    payload: AssistantFeedbackCreate,
    principal: PrincipalDep,
    service: AssistantServiceDep,
) -> FeedbackOut:
    return FeedbackOut(**await service.submit_feedback(principal, payload))


@router.post(
    "/assistant/messages/{message_id}/feedback",
    response_model=FeedbackOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_capability(CAP_FEEDBACK_WRITE))],
)
async def assistant_message_feedback(
    message_id: int,
    payload: AssistantFeedbackCreate,
    principal: PrincipalDep,
    service: AssistantServiceDep,
) -> FeedbackOut:
    if payload.message_id != message_id:
        from ai_api.domain.errors import ValidationError

        raise ValidationError(
            "message_id in body does not match the path",
            details={"message_id": message_id},
        )
    return FeedbackOut(**await service.submit_feedback(principal, payload))


@router.post(
    "/assistant/agents/run",
    response_model=AgentExecutionOut,
    status_code=202,
    dependencies=[Depends(require_capability(CAP_AGENTS_EXECUTE))],
)
async def run_agent_from_copilot(
    payload: CopilotAgentRunRequest,
    principal: PrincipalDep,
    service: CopilotServiceDep,
) -> AgentExecutionOut:
    return AgentExecutionOut(**await service.run_agent(principal, payload))


# --- Controlled enterprise actions -------------------------------------
@router.get(
    "/assistant/actions",
    response_model=Page[CopilotActionOut],
    dependencies=[Depends(require_capability(CAP_COPILOT_ACTIONS_READ))],
)
async def list_actions(
    principal: PrincipalDep,
    service: CopilotServiceDep,
    pagination: PaginationDep,
    action_status: str | None = Query(default=None, alias="status"),
    conversation_id: int | None = Query(default=None, ge=1),
) -> Page[CopilotActionOut]:
    items, total = await service.list_actions(
        principal,
        status=action_status,
        conversation_id=conversation_id,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return Page[CopilotActionOut](
        items=[CopilotActionOut(**item) for item in items],
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )


@router.post(
    "/assistant/actions",
    response_model=CopilotActionOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_RAG))],
)
async def propose_action(
    payload: CopilotActionCreate, principal: PrincipalDep, service: CopilotServiceDep
) -> CopilotActionOut:
    return CopilotActionOut(**await service.propose_action(principal, payload))


@router.get(
    "/assistant/actions/{action_id}",
    response_model=CopilotActionOut,
    dependencies=[Depends(require_capability(CAP_COPILOT_ACTIONS_READ))],
)
async def get_action(
    action_id: int, principal: PrincipalDep, service: CopilotServiceDep
) -> CopilotActionOut:
    return CopilotActionOut(**await service.get_action(principal, action_id))


@router.post(
    "/assistant/actions/{action_id}/approve",
    response_model=CopilotActionOut,
    dependencies=[Depends(require_capability(CAP_COPILOT_ACTIONS_DECIDE))],
)
async def approve_action(
    action_id: int,
    payload: CopilotActionDecision,
    principal: PrincipalDep,
    service: CopilotServiceDep,
) -> CopilotActionOut:
    return CopilotActionOut(
        **await service.approve_action(principal, action_id, payload.reason)
    )


@router.post(
    "/assistant/actions/{action_id}/reject",
    response_model=CopilotActionOut,
    dependencies=[Depends(require_capability(CAP_COPILOT_ACTIONS_DECIDE))],
)
async def reject_action(
    action_id: int,
    payload: CopilotActionDecision,
    principal: PrincipalDep,
    service: CopilotServiceDep,
) -> CopilotActionOut:
    return CopilotActionOut(
        **await service.reject_action(principal, action_id, payload.reason)
    )


@router.post(
    "/assistant/actions/{action_id}/execute",
    response_model=CopilotActionOut,
    dependencies=[Depends(require_capability(CAP_COPILOT_ACTIONS_EXECUTE))],
)
async def execute_action(
    action_id: int, principal: PrincipalDep, service: CopilotServiceDep
) -> CopilotActionOut:
    return CopilotActionOut(**await service.execute_action(principal, action_id))
