"""Quality Intelligence API (Stage 9 / Step 7).

Routes only adapt HTTP to the quality service; authorization, lifecycle
validation, root-cause confirmation rules and provenance handling live in the
service.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    PaginationDep,
    PrincipalDep,
    QualityServiceDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.quality import (
    InspectionCreate,
    InspectionOut,
    InspectionPage,
    InspectionResultCreate,
    InspectionResultOut,
    InspectionUpdate,
    QualityActionCreate,
    QualityActionOut,
    QualityActionPage,
    QualityActionUpdate,
    QualityAnalyticsResponse,
    QualityImpactRequest,
    QualityImpactResponse,
    QualityIssueCreate,
    QualityIssueOut,
    QualityIssuePage,
    QualityIssueUpdate,
    QualityStats,
    QualityTraceabilityResponse,
    RepeatIssueResponse,
    RootCauseCreate,
    RootCauseOut,
    RootCauseUpdate,
    SupplierIssueCreate,
    SupplierIssueOut,
    SupplierQualityResponse,
)
from ai_api.security.permissions import (
    CAP_QUALITY_ANALYZE,
    CAP_QUALITY_READ,
    CAP_QUALITY_WRITE,
)

router = APIRouter(tags=["quality"], dependencies=[Depends(enforce_rate_limit)])


# --- Statistics ----------------------------------------------------------
@router.get(
    "/quality/stats",
    response_model=QualityStats,
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def quality_stats(
    principal: PrincipalDep, service: QualityServiceDep
) -> QualityStats:
    return QualityStats(**await service.stats(principal))


# --- Quality issues ------------------------------------------------------
@router.get(
    "/quality/issues",
    response_model=QualityIssuePage,
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def list_issues(
    principal: PrincipalDep,
    service: QualityServiceDep,
    pagination: PaginationDep,
    status: str | None = Query(default=None, max_length=32),
    severity: str | None = Query(default=None, max_length=32),
    issue_type: str | None = Query(default=None, max_length=32),
    component_item_id: int | None = Query(default=None, ge=1),
    product_item_id: int | None = Query(default=None, ge=1),
    supplier_ref: str | None = Query(default=None, max_length=256),
    plant_id: int | None = Query(default=None, ge=1),
    operation_id: int | None = Query(default=None, ge=1),
    query: str | None = Query(default=None, max_length=200),
) -> QualityIssuePage:
    items, total = await service.list_issues(
        principal,
        status=status,
        severity=severity,
        issue_type=issue_type,
        component_item_id=component_item_id,
        product_item_id=product_item_id,
        supplier_ref=supplier_ref,
        plant_id=plant_id,
        operation_id=operation_id,
        query=query,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return QualityIssuePage(
        items=[QualityIssueOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/quality/issues",
    response_model=QualityIssueOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_QUALITY_WRITE))],
)
async def upsert_issue(
    payload: QualityIssueCreate,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> QualityIssueOut:
    return QualityIssueOut(**await service.upsert_issue(principal, payload))


@router.get(
    "/quality/issues/{issue_id}",
    response_model=QualityIssueOut,
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def get_issue(
    issue_id: int, principal: PrincipalDep, service: QualityServiceDep
) -> QualityIssueOut:
    return QualityIssueOut(**await service.get_issue(principal, issue_id))


@router.patch(
    "/quality/issues/{issue_id}",
    response_model=QualityIssueOut,
    dependencies=[Depends(require_capability(CAP_QUALITY_WRITE))],
)
async def update_issue(
    issue_id: int,
    payload: QualityIssueUpdate,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> QualityIssueOut:
    return QualityIssueOut(**await service.update_issue(principal, issue_id, payload))


@router.get(
    "/quality/issues/{issue_id}/traceability",
    response_model=QualityTraceabilityResponse,
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def issue_traceability(
    issue_id: int, principal: PrincipalDep, service: QualityServiceDep
) -> QualityTraceabilityResponse:
    return QualityTraceabilityResponse(
        **await service.traceability(principal, issue_id)
    )


# --- Root causes ---------------------------------------------------------
@router.get(
    "/quality/issues/{issue_id}/root-causes",
    response_model=list[RootCauseOut],
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def list_root_causes(
    issue_id: int,
    principal: PrincipalDep,
    service: QualityServiceDep,
    limit: int = Query(default=200, ge=1, le=2000),
) -> list[RootCauseOut]:
    rows = await service.list_root_causes(principal, issue_id, limit=limit)
    return [RootCauseOut(**row) for row in rows]


@router.post(
    "/quality/issues/{issue_id}/root-causes",
    response_model=RootCauseOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_QUALITY_WRITE))],
)
async def add_root_cause(
    issue_id: int,
    payload: RootCauseCreate,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> RootCauseOut:
    return RootCauseOut(**await service.add_root_cause(principal, issue_id, payload))


@router.patch(
    "/quality/issues/{issue_id}/root-causes/{root_cause_id}",
    response_model=RootCauseOut,
    dependencies=[Depends(require_capability(CAP_QUALITY_WRITE))],
)
async def update_root_cause(
    issue_id: int,
    root_cause_id: int,
    payload: RootCauseUpdate,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> RootCauseOut:
    return RootCauseOut(
        **await service.update_root_cause(
            principal, issue_id, root_cause_id, payload
        )
    )


# --- Inspections ---------------------------------------------------------
@router.get(
    "/quality/inspections",
    response_model=InspectionPage,
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def list_inspections(
    principal: PrincipalDep,
    service: QualityServiceDep,
    pagination: PaginationDep,
    status: str | None = Query(default=None, max_length=32),
    inspection_type: str | None = Query(default=None, max_length=32),
    quality_issue_id: int | None = Query(default=None, ge=1),
    operation_id: int | None = Query(default=None, ge=1),
    query: str | None = Query(default=None, max_length=200),
) -> InspectionPage:
    items, total = await service.list_inspections(
        principal,
        status=status,
        inspection_type=inspection_type,
        quality_issue_id=quality_issue_id,
        operation_id=operation_id,
        query=query,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return InspectionPage(
        items=[InspectionOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/quality/inspections",
    response_model=InspectionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_QUALITY_WRITE))],
)
async def upsert_inspection(
    payload: InspectionCreate,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> InspectionOut:
    return InspectionOut(**await service.upsert_inspection(principal, payload))


@router.get(
    "/quality/inspections/{inspection_id}",
    response_model=InspectionOut,
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def get_inspection(
    inspection_id: int, principal: PrincipalDep, service: QualityServiceDep
) -> InspectionOut:
    return InspectionOut(**await service.get_inspection(principal, inspection_id))


@router.patch(
    "/quality/inspections/{inspection_id}",
    response_model=InspectionOut,
    dependencies=[Depends(require_capability(CAP_QUALITY_WRITE))],
)
async def update_inspection(
    inspection_id: int,
    payload: InspectionUpdate,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> InspectionOut:
    return InspectionOut(
        **await service.update_inspection(principal, inspection_id, payload)
    )


@router.get(
    "/quality/inspections/{inspection_id}/results",
    response_model=list[InspectionResultOut],
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def list_inspection_results(
    inspection_id: int,
    principal: PrincipalDep,
    service: QualityServiceDep,
    limit: int = Query(default=500, ge=1, le=5000),
) -> list[InspectionResultOut]:
    rows = await service.list_inspection_results(
        principal, inspection_id, limit=limit
    )
    return [InspectionResultOut(**row) for row in rows]


@router.post(
    "/quality/inspections/{inspection_id}/results",
    response_model=InspectionResultOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_QUALITY_WRITE))],
)
async def add_inspection_result(
    inspection_id: int,
    payload: InspectionResultCreate,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> InspectionResultOut:
    return InspectionResultOut(
        **await service.add_inspection_result(principal, inspection_id, payload)
    )


# --- Corrective actions (CAPA) ------------------------------------------
@router.get(
    "/quality/actions",
    response_model=QualityActionPage,
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def list_actions(
    principal: PrincipalDep,
    service: QualityServiceDep,
    pagination: PaginationDep,
    quality_issue_id: int | None = Query(default=None, ge=1),
    status: str | None = Query(default=None, max_length=32),
    action_type: str | None = Query(default=None, max_length=32),
    owner_user: str | None = Query(default=None, max_length=256),
) -> QualityActionPage:
    items, total = await service.list_actions(
        principal,
        quality_issue_id=quality_issue_id,
        status=status,
        action_type=action_type,
        owner_user=owner_user,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return QualityActionPage(
        items=[QualityActionOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/quality/actions",
    response_model=QualityActionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_QUALITY_WRITE))],
)
async def upsert_action(
    payload: QualityActionCreate,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> QualityActionOut:
    return QualityActionOut(**await service.upsert_action(principal, payload))


@router.get(
    "/quality/actions/{action_id}",
    response_model=QualityActionOut,
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def get_action(
    action_id: int, principal: PrincipalDep, service: QualityServiceDep
) -> QualityActionOut:
    return QualityActionOut(**await service.get_action(principal, action_id))


@router.patch(
    "/quality/actions/{action_id}",
    response_model=QualityActionOut,
    dependencies=[Depends(require_capability(CAP_QUALITY_WRITE))],
)
async def update_action(
    action_id: int,
    payload: QualityActionUpdate,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> QualityActionOut:
    return QualityActionOut(**await service.update_action(principal, action_id, payload))


# --- Supplier quality ----------------------------------------------------
@router.get(
    "/quality/supplier-issues",
    response_model=list[SupplierIssueOut],
    dependencies=[Depends(require_capability(CAP_QUALITY_READ))],
)
async def list_supplier_issues(
    principal: PrincipalDep,
    service: QualityServiceDep,
    supplier_ref: str | None = Query(default=None, max_length=256),
    limit: int = Query(default=500, ge=1, le=5000),
) -> list[SupplierIssueOut]:
    rows = await service.list_supplier_issues(
        principal, supplier_ref=supplier_ref, limit=limit
    )
    return [SupplierIssueOut(**row) for row in rows]


@router.post(
    "/quality/issues/{issue_id}/supplier-issues",
    response_model=SupplierIssueOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_QUALITY_WRITE))],
)
async def add_supplier_issue(
    issue_id: int,
    payload: SupplierIssueCreate,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> SupplierIssueOut:
    return SupplierIssueOut(
        **await service.add_supplier_issue(principal, issue_id, payload)
    )


@router.get(
    "/quality/supplier-quality",
    response_model=SupplierQualityResponse,
    dependencies=[Depends(require_capability(CAP_QUALITY_ANALYZE))],
)
async def supplier_quality(
    principal: PrincipalDep, service: QualityServiceDep
) -> SupplierQualityResponse:
    return SupplierQualityResponse(**await service.supplier_quality(principal))


# --- Analytics / repeat / impact ----------------------------------------
@router.get(
    "/quality/analytics/{kind}",
    response_model=QualityAnalyticsResponse,
    dependencies=[Depends(require_capability(CAP_QUALITY_ANALYZE))],
)
async def quality_analytics(
    kind: str, principal: PrincipalDep, service: QualityServiceDep
) -> QualityAnalyticsResponse:
    return QualityAnalyticsResponse(**await service.analytics(principal, kind))


@router.get(
    "/quality/repeat-issues",
    response_model=RepeatIssueResponse,
    dependencies=[Depends(require_capability(CAP_QUALITY_ANALYZE))],
)
async def repeat_issues(
    principal: PrincipalDep,
    service: QualityServiceDep,
    window_days: int = Query(default=90, ge=1, le=3650),
) -> RepeatIssueResponse:
    return RepeatIssueResponse(
        **await service.repeat_issues(principal, window_days=window_days)
    )


@router.post(
    "/quality/impact",
    response_model=QualityImpactResponse,
    dependencies=[Depends(require_capability(CAP_QUALITY_ANALYZE))],
)
async def quality_impact(
    payload: QualityImpactRequest,
    principal: PrincipalDep,
    service: QualityServiceDep,
) -> QualityImpactResponse:
    return QualityImpactResponse(
        **await service.impact(principal, payload.entity_id, max_depth=payload.max_depth)
    )
