from __future__ import annotations

from fastapi import APIRouter, Depends

from ai_api.api.deps import (
    PrincipalDep,
    RetrievalServiceDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.retrieval import RagQueryRequest, SearchRequest
from ai_api.security.permissions import CAP_RETRIEVAL_RAG, CAP_RETRIEVAL_SEARCH

router = APIRouter(tags=["retrieval"], dependencies=[Depends(enforce_rate_limit)])


@router.post(
    "/search",
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def search(
    payload: SearchRequest, principal: PrincipalDep, service: RetrievalServiceDep
) -> dict:
    return await service.search(principal, payload)


@router.post(
    "/rag/query",
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_RAG))],
)
async def rag_query(
    payload: RagQueryRequest, principal: PrincipalDep, service: RetrievalServiceDep
) -> dict:
    return await service.rag_query(principal, payload)
