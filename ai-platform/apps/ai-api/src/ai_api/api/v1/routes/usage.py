from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    PaginationDep,
    PrincipalDep,
    UsageServiceDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.application.services.knowledge_service import require_tenant
from ai_api.schemas.common import Page, PageMeta
from ai_api.schemas.usage import UsageRecordOut, UsageSummaryOut
from ai_api.security.permissions import CAP_USAGE_READ

router = APIRouter(
    tags=["usage"],
    dependencies=[Depends(enforce_rate_limit), Depends(require_capability(CAP_USAGE_READ))],
)


@router.get("/usage", response_model=UsageSummaryOut)
async def usage_summary(
    principal: PrincipalDep,
    service: UsageServiceDep,
    since: datetime | None = Query(default=None),
) -> UsageSummaryOut:
    tenant_id = require_tenant(principal)
    return UsageSummaryOut(**await service.summary(tenant_id, since=since))


@router.get("/usage/records", response_model=Page[UsageRecordOut])
async def usage_records(
    principal: PrincipalDep, service: UsageServiceDep, pagination: PaginationDep
) -> Page[UsageRecordOut]:
    tenant_id = require_tenant(principal)
    items, total = await service.list_records(
        tenant_id, limit=pagination.limit, offset=pagination.offset
    )
    return Page[UsageRecordOut](
        items=[UsageRecordOut(**item) for item in items],
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )
