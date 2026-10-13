from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status

from ai_api.api.deps import (
    AssistantServiceDep,
    PaginationDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.assistant import (
    AssistantFeedbackCreate,
    ConversationCreate,
    ConversationDetailOut,
    ConversationOut,
    MessageCreate,
    MessageOut,
)
from ai_api.schemas.common import Page, PageMeta
from ai_api.schemas.feedback import FeedbackOut
from ai_api.security.permissions import CAP_FEEDBACK_WRITE, CAP_RETRIEVAL_RAG

router = APIRouter(tags=["assistant"], dependencies=[Depends(enforce_rate_limit)])


@router.post(
    "/assistant/conversations",
    response_model=ConversationOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_RAG))],
)
async def create_conversation(
    payload: ConversationCreate, principal: PrincipalDep, service: AssistantServiceDep
) -> ConversationOut:
    return ConversationOut(**await service.create_conversation(principal, payload))


@router.get(
    "/assistant/conversations",
    response_model=Page[ConversationOut],
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_RAG))],
)
async def list_conversations(
    principal: PrincipalDep,
    service: AssistantServiceDep,
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
    "/assistant/conversations/{conversation_id}",
    response_model=ConversationDetailOut,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_RAG))],
)
async def get_conversation(
    conversation_id: int, principal: PrincipalDep, service: AssistantServiceDep
) -> ConversationDetailOut:
    detail = await service.get_conversation(principal, conversation_id)
    return ConversationDetailOut(**detail)


@router.delete(
    "/assistant/conversations/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_RAG))],
)
async def delete_conversation(
    conversation_id: int, principal: PrincipalDep, service: AssistantServiceDep
) -> None:
    await service.delete_conversation(principal, conversation_id)


@router.post(
    "/assistant/conversations/{conversation_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_RAG))],
)
async def create_message(
    conversation_id: int,
    payload: MessageCreate,
    principal: PrincipalDep,
    service: AssistantServiceDep,
) -> MessageOut:
    return MessageOut(**await service.ask(principal, conversation_id, payload))


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
