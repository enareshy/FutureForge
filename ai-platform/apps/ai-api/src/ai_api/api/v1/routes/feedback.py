from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    FeedbackServiceDep,
    PaginationDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.common import Page, PageMeta
from ai_api.schemas.feedback import FeedbackCreate, FeedbackOut
from ai_api.security.permissions import CAP_FEEDBACK_READ, CAP_FEEDBACK_WRITE

router = APIRouter(tags=["feedback"], dependencies=[Depends(enforce_rate_limit)])


@router.post(
    "/feedback",
    response_model=FeedbackOut,
    dependencies=[Depends(require_capability(CAP_FEEDBACK_WRITE))],
)
async def create_feedback(
    payload: FeedbackCreate, principal: PrincipalDep, service: FeedbackServiceDep
) -> FeedbackOut:
    return FeedbackOut(**await service.create(principal, payload))


@router.get(
    "/feedback",
    response_model=Page[FeedbackOut],
    dependencies=[Depends(require_capability(CAP_FEEDBACK_READ))],
)
async def list_feedback(
    principal: PrincipalDep,
    service: FeedbackServiceDep,
    pagination: PaginationDep,
    execution_id: int | None = Query(default=None),
) -> Page[FeedbackOut]:
    items, total = await service.list(
        principal,
        execution_id=execution_id,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return Page[FeedbackOut](
        items=[FeedbackOut(**item) for item in items],
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )
