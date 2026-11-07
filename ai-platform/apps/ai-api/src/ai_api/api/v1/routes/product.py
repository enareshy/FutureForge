"""Product & BOM Intelligence API (Stage 8 / Step 6).

Routes only adapt HTTP to the product/BOM services; all authorization, lifecycle
validation, recursion limits and provenance handling live in the services.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    BomServiceDep,
    PaginationDep,
    PrincipalDep,
    ProductServiceDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.product import (
    BomCompareRequest,
    BomCompareResponse,
    BomHeaderCreate,
    BomHeaderOut,
    BomHeaderPage,
    BomHeaderUpdate,
    BomIntelligenceResponse,
    BomLineCreate,
    BomLineOut,
    BomLinePage,
    BomLineUpdate,
    BomQualityResponse,
    BomReconcileRequest,
    BomReconciliationOut,
    BomStructureResponse,
    BomTransformationRunOut,
    BomTransformRequest,
    ChangeImpactResponse,
    ProductIntelligenceStats,
    ProductItemCreate,
    ProductItemOut,
    ProductItemPage,
    ProductItemUpdate,
    ProductRevisionCreate,
    ProductRevisionOut,
    ProductRevisionUpdate,
)
from ai_api.security.permissions import (
    CAP_BOM_ANALYZE,
    CAP_BOM_READ,
    CAP_BOM_WRITE,
    CAP_PRODUCT_READ,
    CAP_PRODUCT_WRITE,
)

router = APIRouter(tags=["product"], dependencies=[Depends(enforce_rate_limit)])


def _split_csv(value: str | None) -> list[str] | None:
    if not value:
        return None
    items = [part.strip() for part in value.split(",") if part.strip()]
    return items or None


# --- Statistics ----------------------------------------------------------
@router.get(
    "/products/stats",
    response_model=ProductIntelligenceStats,
    dependencies=[Depends(require_capability(CAP_BOM_READ))],
)
async def product_stats(
    principal: PrincipalDep, service: BomServiceDep
) -> ProductIntelligenceStats:
    return ProductIntelligenceStats(**await service.stats(principal))


# --- Items ---------------------------------------------------------------
@router.get(
    "/products/items",
    response_model=ProductItemPage,
    dependencies=[Depends(require_capability(CAP_PRODUCT_READ))],
)
async def list_product_items(
    principal: PrincipalDep,
    service: ProductServiceDep,
    pagination: PaginationDep,
    query: str | None = Query(default=None, max_length=200),
    item_types: str | None = Query(default=None, max_length=200),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> ProductItemPage:
    items, total = await service.list_items(
        principal,
        item_types=_split_csv(item_types),
        query=query,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return ProductItemPage(
        items=[ProductItemOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/products/items",
    response_model=ProductItemOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PRODUCT_WRITE))],
)
async def create_product_item(
    payload: ProductItemCreate,
    principal: PrincipalDep,
    service: ProductServiceDep,
) -> ProductItemOut:
    return ProductItemOut(**await service.create_or_update_item(principal, payload))


@router.get(
    "/products/items/{item_id}",
    response_model=ProductItemOut,
    dependencies=[Depends(require_capability(CAP_PRODUCT_READ))],
)
async def get_product_item(
    item_id: int, principal: PrincipalDep, service: ProductServiceDep
) -> ProductItemOut:
    return ProductItemOut(**await service.get_item(principal, item_id))


@router.patch(
    "/products/items/{item_id}",
    response_model=ProductItemOut,
    dependencies=[Depends(require_capability(CAP_PRODUCT_WRITE))],
)
async def update_product_item(
    item_id: int,
    payload: ProductItemUpdate,
    principal: PrincipalDep,
    service: ProductServiceDep,
) -> ProductItemOut:
    return ProductItemOut(**await service.update_item(principal, item_id, payload))


# --- Revisions -----------------------------------------------------------
@router.get(
    "/products/revisions",
    response_model=list[ProductRevisionOut],
    dependencies=[Depends(require_capability(CAP_PRODUCT_READ))],
)
async def list_product_revisions(
    principal: PrincipalDep,
    service: ProductServiceDep,
    pagination: PaginationDep,
    item_id: int | None = Query(default=None, ge=1),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> list[ProductRevisionOut]:
    items, _ = await service.list_revisions(
        principal,
        item_id=item_id,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return [ProductRevisionOut(**item) for item in items]


@router.post(
    "/products/items/{item_id}/revisions",
    response_model=ProductRevisionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PRODUCT_WRITE))],
)
async def create_product_revision(
    item_id: int,
    payload: ProductRevisionCreate,
    principal: PrincipalDep,
    service: ProductServiceDep,
) -> ProductRevisionOut:
    return ProductRevisionOut(
        **await service.create_or_update_revision(principal, item_id, payload)
    )


@router.get(
    "/products/revisions/{revision_id}",
    response_model=ProductRevisionOut,
    dependencies=[Depends(require_capability(CAP_PRODUCT_READ))],
)
async def get_product_revision(
    revision_id: int, principal: PrincipalDep, service: ProductServiceDep
) -> ProductRevisionOut:
    return ProductRevisionOut(**await service.get_revision(principal, revision_id))


@router.patch(
    "/products/revisions/{revision_id}",
    response_model=ProductRevisionOut,
    dependencies=[Depends(require_capability(CAP_PRODUCT_WRITE))],
)
async def update_product_revision(
    revision_id: int,
    payload: ProductRevisionUpdate,
    principal: PrincipalDep,
    service: ProductServiceDep,
) -> ProductRevisionOut:
    return ProductRevisionOut(**await service.update_revision(principal, revision_id, payload))


# --- BOM headers ---------------------------------------------------------
@router.get(
    "/boms",
    response_model=BomHeaderPage,
    dependencies=[Depends(require_capability(CAP_BOM_READ))],
)
async def list_boms(
    principal: PrincipalDep,
    service: ProductServiceDep,
    pagination: PaginationDep,
    query: str | None = Query(default=None, max_length=200),
    bom_type: str | None = Query(default=None, max_length=16),
    root_item_id: int | None = Query(default=None, ge=1),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> BomHeaderPage:
    items, total = await service.list_headers(
        principal,
        bom_type=bom_type,
        root_item_id=root_item_id,
        query=query,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return BomHeaderPage(
        items=[BomHeaderOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/boms",
    response_model=BomHeaderOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_BOM_WRITE))],
)
async def create_bom(
    payload: BomHeaderCreate,
    principal: PrincipalDep,
    service: ProductServiceDep,
) -> BomHeaderOut:
    return BomHeaderOut(**await service.create_or_update_header(principal, payload))


@router.patch(
    "/boms/{header_id}",
    response_model=BomHeaderOut,
    dependencies=[Depends(require_capability(CAP_BOM_WRITE))],
)
async def update_bom(
    header_id: int,
    payload: BomHeaderUpdate,
    principal: PrincipalDep,
    service: ProductServiceDep,
) -> BomHeaderOut:
    return BomHeaderOut(**await service.update_header(principal, header_id, payload))


@router.delete(
    "/boms/{header_id}",
    response_model=BomHeaderOut,
    dependencies=[Depends(require_capability(CAP_BOM_WRITE))],
)
async def delete_bom(
    header_id: int, principal: PrincipalDep, service: ProductServiceDep
) -> BomHeaderOut:
    return BomHeaderOut(**await service.delete_header(principal, header_id))


# --- BOM lines -----------------------------------------------------------
@router.get(
    "/boms/lines",
    response_model=BomLinePage,
    dependencies=[Depends(require_capability(CAP_BOM_READ))],
)
async def list_bom_lines(
    principal: PrincipalDep,
    service: ProductServiceDep,
    pagination: PaginationDep,
    header_id: int | None = Query(default=None, ge=1),
    parent_revision_id: int | None = Query(default=None, ge=1),
    child_item_id: int | None = Query(default=None, ge=1),
    active_only: bool = Query(default=True),
) -> BomLinePage:
    items, total = await service.list_lines(
        principal,
        header_id=header_id,
        parent_revision_id=parent_revision_id,
        child_item_id=child_item_id,
        active_only=active_only,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return BomLinePage(
        items=[BomLineOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/boms/{header_id}/lines",
    response_model=BomLineOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_BOM_WRITE))],
)
async def create_bom_line(
    header_id: int,
    payload: BomLineCreate,
    principal: PrincipalDep,
    service: ProductServiceDep,
) -> BomLineOut:
    return BomLineOut(**await service.create_line(principal, header_id, payload))


@router.patch(
    "/boms/lines/{line_id}",
    response_model=BomLineOut,
    dependencies=[Depends(require_capability(CAP_BOM_WRITE))],
)
async def update_bom_line(
    line_id: int,
    payload: BomLineUpdate,
    principal: PrincipalDep,
    service: ProductServiceDep,
) -> BomLineOut:
    return BomLineOut(**await service.update_line(principal, line_id, payload))


@router.delete(
    "/boms/lines/{line_id}",
    response_model=BomLineOut,
    dependencies=[Depends(require_capability(CAP_BOM_WRITE))],
)
async def delete_bom_line(
    line_id: int, principal: PrincipalDep, service: ProductServiceDep
) -> BomLineOut:
    return BomLineOut(**await service.delete_line(principal, line_id))


# --- Structure / comparison ---------------------------------------------
@router.get(
    "/boms/{header_id}/structure",
    response_model=BomStructureResponse,
    dependencies=[Depends(require_capability(CAP_BOM_READ))],
)
async def bom_structure(
    header_id: int,
    principal: PrincipalDep,
    service: BomServiceDep,
    max_depth: int = Query(default=5, ge=1, le=20),
    limit: int = Query(default=500, ge=1, le=5000),
    direction: str = Query(default="down", pattern=r"^(up|down|both)$"),
) -> BomStructureResponse:
    return BomStructureResponse(
        **await service.structure(
            principal, header_id, max_depth=max_depth, limit=limit, direction=direction
        )
    )


@router.post(
    "/boms/compare",
    response_model=BomCompareResponse,
    dependencies=[Depends(require_capability(CAP_BOM_ANALYZE))],
)
async def compare_boms(
    payload: BomCompareRequest, principal: PrincipalDep, service: BomServiceDep
) -> BomCompareResponse:
    return BomCompareResponse(
        **await service.compare(
            principal,
            payload.left_header_id,
            payload.right_header_id,
            scope=payload.scope,
        )
    )


# --- Transformation / reconciliation ------------------------------------
@router.post(
    "/boms/transform",
    response_model=BomTransformationRunOut,
    dependencies=[Depends(require_capability(CAP_BOM_ANALYZE))],
)
async def transform_bom(
    payload: BomTransformRequest, principal: PrincipalDep, service: BomServiceDep
) -> BomTransformationRunOut:
    result = await service.transform(
        principal,
        source_header_id=payload.source_header_id,
        target_header_id=payload.target_header_id,
        mode=payload.mode,
    )
    return BomTransformationRunOut(**result)


@router.get(
    "/boms/transformation-runs",
    response_model=list[BomTransformationRunOut],
    dependencies=[Depends(require_capability(CAP_BOM_ANALYZE))],
)
async def list_transformation_runs(
    principal: PrincipalDep,
    service: BomServiceDep,
    source_header_id: int | None = Query(default=None, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[BomTransformationRunOut]:
    from ai_api.application.services.context import require_tenant

    tenant_id = require_tenant(principal)
    runs = await service.repository.list_bom_transformation_runs(
        tenant_id, source_header_id=source_header_id, limit=limit
    )
    return [BomTransformationRunOut(**run) for run in runs]


@router.post(
    "/boms/reconcile",
    response_model=BomReconciliationOut,
    dependencies=[Depends(require_capability(CAP_BOM_ANALYZE))],
)
async def reconcile_bom(
    payload: BomReconcileRequest, principal: PrincipalDep, service: BomServiceDep
) -> BomReconciliationOut:
    return BomReconciliationOut(
        **await service.reconcile(
            principal,
            source_header_id=payload.source_header_id,
            target_header_id=payload.target_header_id,
        )
    )


@router.get(
    "/boms/reconciliations",
    response_model=list[BomReconciliationOut],
    dependencies=[Depends(require_capability(CAP_BOM_ANALYZE))],
)
async def list_reconciliations(
    principal: PrincipalDep,
    service: BomServiceDep,
    source_header_id: int | None = Query(default=None, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[BomReconciliationOut]:
    from ai_api.application.services.context import require_tenant

    tenant_id = require_tenant(principal)
    rows = await service.repository.list_bom_reconciliations(
        tenant_id, source_header_id=source_header_id, limit=limit
    )
    return [BomReconciliationOut(**row) for row in rows]


# --- Intelligence -------------------------------------------------------
@router.get(
    "/boms/{header_id}",
    response_model=BomHeaderOut,
    dependencies=[Depends(require_capability(CAP_BOM_READ))],
)
async def get_bom(
    header_id: int, principal: PrincipalDep, service: ProductServiceDep
) -> BomHeaderOut:
    return BomHeaderOut(**await service.get_header(principal, header_id))


@router.get(
    "/products/items/{item_id}/where-used",
    response_model=BomIntelligenceResponse,
    dependencies=[Depends(require_capability(CAP_BOM_ANALYZE))],
)
async def where_used(
    item_id: int,
    principal: PrincipalDep,
    service: BomServiceDep,
    bom_type: str | None = Query(default=None, max_length=16),
) -> BomIntelligenceResponse:
    result = await service.where_used(principal, item_id, bom_type=bom_type)
    return BomIntelligenceResponse(
        kind="where_used",
        rows=result["rows"],
        total=result["total"],
        truncated=result["truncated"],
        summary={"item_id": item_id},
    )


@router.get(
    "/products/reuse",
    response_model=BomIntelligenceResponse,
    dependencies=[Depends(require_capability(CAP_BOM_ANALYZE))],
)
async def reuse_analysis(
    principal: PrincipalDep, service: BomServiceDep
) -> BomIntelligenceResponse:
    return BomIntelligenceResponse(**await service.reuse_analysis(principal))


@router.get(
    "/products/duplicates",
    response_model=BomIntelligenceResponse,
    dependencies=[Depends(require_capability(CAP_BOM_ANALYZE))],
)
async def duplicate_candidates(
    principal: PrincipalDep, service: BomServiceDep
) -> BomIntelligenceResponse:
    return BomIntelligenceResponse(**await service.duplicate_candidates(principal))


@router.get(
    "/boms/{header_id}/quality",
    response_model=BomQualityResponse,
    dependencies=[Depends(require_capability(CAP_BOM_ANALYZE))],
)
async def bom_quality(
    header_id: int, principal: PrincipalDep, service: BomServiceDep
) -> BomQualityResponse:
    return BomQualityResponse(**await service.quality(principal, header_id))


@router.post(
    "/boms/change-impact",
    response_model=ChangeImpactResponse,
    dependencies=[Depends(require_capability(CAP_BOM_ANALYZE))],
)
async def change_impact(
    principal: PrincipalDep,
    service: BomServiceDep,
    change_entity_id: int = Query(ge=1),
    max_depth: int = Query(default=3, ge=1, le=6),
) -> ChangeImpactResponse:
    return ChangeImpactResponse(
        **await service.change_impact(principal, change_entity_id, max_depth=max_depth)
    )
