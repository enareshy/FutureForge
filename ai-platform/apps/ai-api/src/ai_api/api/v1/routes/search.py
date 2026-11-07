from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from ai_api.api.deps import (
    PaginationDep,
    PrincipalDep,
    SearchServiceDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.domain.errors import ValidationError
from ai_api.schemas.common import Page, PageMeta
from ai_api.schemas.search import (
    FacetsResponse,
    SavedSearchCreate,
    SavedSearchOut,
    SearchFilter,
    SearchHealthResponse,
    SearchHistoryOut,
    SearchMode,
    SearchRequest,
    SuggestionsResponse,
)
from ai_api.security.permissions import CAP_RETRIEVAL_SEARCH

router = APIRouter(tags=["search"], dependencies=[Depends(enforce_rate_limit)])

_FILTERS_HELP = "JSON array of {field, op, value} objects; values are validated server-side."


def _parse_filters(raw: str | None) -> list[SearchFilter]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValidationError("filters must be valid JSON") from exc
    if not isinstance(data, list):
        raise ValidationError("filters must be a JSON array")
    try:
        return [SearchFilter(**item) for item in data]
    except (TypeError, ValueError) as exc:
        raise ValidationError("invalid filter shape", details={"error": str(exc)}) from exc


@router.post(
    "/search",
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def search(
    payload: SearchRequest, principal: PrincipalDep, service: SearchServiceDep
) -> dict:
    return await service.search(principal, payload)


@router.get(
    "/search/health",
    response_model=SearchHealthResponse,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def search_health(
    principal: PrincipalDep, service: SearchServiceDep
) -> SearchHealthResponse:
    return SearchHealthResponse(**await service.health(principal))


@router.get(
    "/search/facets",
    response_model=FacetsResponse,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def facets(
    principal: PrincipalDep,
    service: SearchServiceDep,
    q: Annotated[str, Query(min_length=1, max_length=4000)],
    mode: SearchMode = "hybrid",
    limit: int = Query(default=50, ge=1, le=200),
    filters: str | None = Query(default=None, description=_FILTERS_HELP),
) -> FacetsResponse:
    result = await service.facets(
        principal,
        query=q,
        mode=mode,
        filters=_parse_filters(filters),
        limit=limit,
    )
    return FacetsResponse(**result)


@router.get(
    "/search/suggestions",
    response_model=SuggestionsResponse,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def suggestions(
    principal: PrincipalDep,
    service: SearchServiceDep,
    q: str = Query(default="", max_length=4000),
    limit: int = Query(default=10, ge=1, le=20),
) -> SuggestionsResponse:
    items = await service.suggestions(principal, query=q, limit=limit)
    return SuggestionsResponse(query=q, suggestions=items)


@router.get(
    "/search/history",
    response_model=Page[SearchHistoryOut],
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def list_history(
    principal: PrincipalDep, service: SearchServiceDep, pagination: PaginationDep
) -> Page[SearchHistoryOut]:
    items, total = await service.list_history(
        principal, limit=pagination.limit, offset=pagination.offset
    )
    return Page[SearchHistoryOut](
        items=[SearchHistoryOut(**item) for item in items],
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )


@router.delete(
    "/search/history",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def clear_history(principal: PrincipalDep, service: SearchServiceDep) -> None:
    await service.clear_history(principal)


@router.delete(
    "/search/history/{history_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def delete_history(
    history_id: int, principal: PrincipalDep, service: SearchServiceDep
) -> None:
    await service.delete_history(principal, history_id)


@router.get(
    "/search/saved",
    response_model=Page[SavedSearchOut],
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def list_saved(
    principal: PrincipalDep, service: SearchServiceDep, pagination: PaginationDep
) -> Page[SavedSearchOut]:
    items, total = await service.list_saved(
        principal, limit=pagination.limit, offset=pagination.offset
    )
    return Page[SavedSearchOut](
        items=[SavedSearchOut(**item) for item in items],
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )


@router.post(
    "/search/saved",
    response_model=SavedSearchOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def create_saved(
    payload: SavedSearchCreate, principal: PrincipalDep, service: SearchServiceDep
) -> SavedSearchOut:
    return SavedSearchOut(**await service.create_saved(principal, payload))


@router.get(
    "/search/saved/{saved_id}",
    response_model=SavedSearchOut,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def get_saved(
    saved_id: int, principal: PrincipalDep, service: SearchServiceDep
) -> SavedSearchOut:
    return SavedSearchOut(**await service.get_saved(principal, saved_id))


@router.delete(
    "/search/saved/{saved_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_capability(CAP_RETRIEVAL_SEARCH))],
)
async def delete_saved(
    saved_id: int, principal: PrincipalDep, service: SearchServiceDep
) -> None:
    await service.delete_saved(principal, saved_id)
