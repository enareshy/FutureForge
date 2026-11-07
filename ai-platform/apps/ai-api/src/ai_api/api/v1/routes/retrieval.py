from __future__ import annotations

from fastapi import APIRouter, Depends

from ai_api.api.deps import (
    PrincipalDep,
    RetrievalServiceDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.retrieval import RagQueryRequest
from ai_api.security.permissions import CAP_RETRIEVAL_RAG

router = APIRouter(tags=["retrieval"], dependencies=[Depends(enforce_rate_limit)])


@router.post(
    "/rag/query",
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_RAG))],
)
async def rag_query(
    payload: RagQueryRequest, principal: PrincipalDep, service: RetrievalServiceDep
) -> dict:
    return await service.rag_query(principal, payload)
