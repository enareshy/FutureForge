from __future__ import annotations

from fastapi import APIRouter, Depends

from ai_api.api.deps import (
    AuditServiceDep,
    PaginationDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.application.services.knowledge_service import require_tenant
from ai_api.schemas.audit import AuditEventOut
from ai_api.schemas.common import Page, PageMeta
from ai_api.security.permissions import CAP_AUDIT_READ

router = APIRouter(
    tags=["audit"],
    dependencies=[Depends(enforce_rate_limit), Depends(require_capability(CAP_AUDIT_READ))],
)


@router.get("/audit", response_model=Page[AuditEventOut])
async def list_audit(
    principal: PrincipalDep, service: AuditServiceDep, pagination: PaginationDep
) -> Page[AuditEventOut]:
    tenant_id = require_tenant(principal)
    items, total = await service.list_events(
        tenant_id, limit=pagination.limit, offset=pagination.offset
    )
    return Page[AuditEventOut](
        items=[AuditEventOut(**item) for item in items],
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )
