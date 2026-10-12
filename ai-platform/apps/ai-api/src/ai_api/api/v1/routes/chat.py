from __future__ import annotations

from fastapi import APIRouter, Depends

from ai_api.api.deps import (
    ChatServiceDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.chat import (
    ChatRequestIn,
    ChatResponseOut,
    SummarizeRequestIn,
    SummarizeResponseOut,
)
from ai_api.security.permissions import CAP_CHAT_EXECUTE

router = APIRouter(
    tags=["chat"],
    dependencies=[Depends(enforce_rate_limit), Depends(require_capability(CAP_CHAT_EXECUTE))],
)


@router.post("/chat", response_model=ChatResponseOut)
async def chat(
    payload: ChatRequestIn, principal: PrincipalDep, service: ChatServiceDep
) -> ChatResponseOut:
    return ChatResponseOut(**await service.chat(principal, payload))


@router.post("/summarize", response_model=SummarizeResponseOut)
async def summarize(
    payload: SummarizeRequestIn, principal: PrincipalDep, service: ChatServiceDep
) -> SummarizeResponseOut:
    return SummarizeResponseOut(**await service.summarize(principal, payload))
