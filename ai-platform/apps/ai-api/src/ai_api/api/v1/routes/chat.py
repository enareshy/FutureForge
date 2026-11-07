from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

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


@router.post("/chat/stream")
async def chat_stream(
    payload: ChatRequestIn, principal: PrincipalDep, service: ChatServiceDep
) -> StreamingResponse:
    """Server-Sent Events stream of chat deltas (where the model supports it)."""
    prepared = await service.prepare_stream(principal, payload)
    return StreamingResponse(
        service.stream_events(principal, prepared),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/summarize", response_model=SummarizeResponseOut)
async def summarize(
    payload: SummarizeRequestIn, principal: PrincipalDep, service: ChatServiceDep
) -> SummarizeResponseOut:
    return SummarizeResponseOut(**await service.summarize(principal, payload))
