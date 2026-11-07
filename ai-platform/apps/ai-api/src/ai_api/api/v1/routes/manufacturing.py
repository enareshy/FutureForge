"""Manufacturing Intelligence API (Stage 9 / Step 7).

Routes only adapt HTTP to the manufacturing service; authorization, lifecycle
validation, recursion limits and provenance handling live in the service.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    ManufacturingServiceDep,
    PaginationDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.manufacturing import (
    ManufacturingAnalyticsResponse,
    ManufacturingImpactRequest,
    ManufacturingImpactResponse,
    ManufacturingStats,
    OperationConsumptionCreate,
    OperationConsumptionOut,
    OperationCreate,
    OperationDependencyCreate,
    OperationDependencyOut,
    OperationOut,
    OperationPage,
    OperationUpdate,
    PlantCreate,
    PlantOut,
    PlantPage,
    PlantUpdate,
    ProcessCheck,
    ProcessCompareRequest,
    ProcessCompareResponse,
    ProcessCreate,
    ProcessDiff,
    ProcessOperationRow,
    ProcessOut,
    ProcessPage,
    ProcessRevisionCreate,
    ProcessRevisionOut,
    ProcessRevisionUpdate,
    ProcessStructureResponse,
    ProcessUpdate,
    ProcessValidationResponse,
    ProductionLineCreate,
    ProductionLineOut,
    ProductionLinePage,
    ProductionLineUpdate,
    ProductionVersionCreate,
    ProductionVersionOut,
    ProductionVersionUpdate,
    ResourceCreate,
    ResourceOut,
    ResourcePage,
    ResourceUpdate,
    WorkCentreCreate,
    WorkCentreOut,
    WorkCentrePage,
    WorkCentreUpdate,
    WorkInstructionCreate,
    WorkInstructionOut,
    WorkInstructionPage,
    WorkInstructionUpdate,
)
from ai_api.security.permissions import (
    CAP_MANUFACTURING_ANALYZE,
    CAP_MANUFACTURING_READ,
    CAP_MANUFACTURING_WRITE,
)

router = APIRouter(tags=["manufacturing"], dependencies=[Depends(enforce_rate_limit)])


# --- Statistics ----------------------------------------------------------
@router.get(
    "/manufacturing/stats",
    response_model=ManufacturingStats,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def manufacturing_stats(
    principal: PrincipalDep, service: ManufacturingServiceDep
) -> ManufacturingStats:
    return ManufacturingStats(**await service.stats(principal))


# --- Plants --------------------------------------------------------------
@router.get(
    "/manufacturing/plants",
    response_model=PlantPage,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_plants(
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    pagination: PaginationDep,
    query: str | None = Query(default=None, max_length=200),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> PlantPage:
    items, total = await service.list_plants(
        principal,
        query=query,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return PlantPage(
        items=[PlantOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/manufacturing/plants",
    response_model=PlantOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def upsert_plant(
    payload: PlantCreate, principal: PrincipalDep, service: ManufacturingServiceDep
) -> PlantOut:
    return PlantOut(**await service.upsert_plant(principal, payload))


@router.get(
    "/manufacturing/plants/{plant_id}",
    response_model=PlantOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def get_plant(
    plant_id: int, principal: PrincipalDep, service: ManufacturingServiceDep
) -> PlantOut:
    return PlantOut(**await service.get_plant(principal, plant_id))


@router.patch(
    "/manufacturing/plants/{plant_id}",
    response_model=PlantOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def update_plant(
    plant_id: int,
    payload: PlantUpdate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> PlantOut:
    return PlantOut(**await service.update_plant(principal, plant_id, payload))


# --- Production lines ----------------------------------------------------
@router.get(
    "/manufacturing/lines",
    response_model=ProductionLinePage,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_lines(
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    pagination: PaginationDep,
    plant_id: int | None = Query(default=None, ge=1),
    query: str | None = Query(default=None, max_length=200),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> ProductionLinePage:
    items, total = await service.list_lines(
        principal,
        plant_id=plant_id,
        query=query,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return ProductionLinePage(
        items=[ProductionLineOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/manufacturing/lines",
    response_model=ProductionLineOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def upsert_line(
    payload: ProductionLineCreate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> ProductionLineOut:
    return ProductionLineOut(**await service.upsert_line(principal, payload))


@router.patch(
    "/manufacturing/lines/{line_id}",
    response_model=ProductionLineOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def update_line(
    line_id: int,
    payload: ProductionLineUpdate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> ProductionLineOut:
    return ProductionLineOut(**await service.update_line(principal, line_id, payload))


# --- Work centres --------------------------------------------------------
@router.get(
    "/manufacturing/work-centres",
    response_model=WorkCentrePage,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_work_centres(
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    pagination: PaginationDep,
    plant_id: int | None = Query(default=None, ge=1),
    line_id: int | None = Query(default=None, ge=1),
    query: str | None = Query(default=None, max_length=200),
) -> WorkCentrePage:
    items, total = await service.list_work_centres(
        principal,
        plant_id=plant_id,
        line_id=line_id,
        query=query,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return WorkCentrePage(
        items=[WorkCentreOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/manufacturing/work-centres",
    response_model=WorkCentreOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def upsert_work_centre(
    payload: WorkCentreCreate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> WorkCentreOut:
    return WorkCentreOut(**await service.upsert_work_centre(principal, payload))


@router.get(
    "/manufacturing/work-centres/{work_centre_id}",
    response_model=WorkCentreOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def get_work_centre(
    work_centre_id: int,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> WorkCentreOut:
    return WorkCentreOut(**await service.get_work_centre(principal, work_centre_id))


@router.patch(
    "/manufacturing/work-centres/{work_centre_id}",
    response_model=WorkCentreOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def update_work_centre(
    work_centre_id: int,
    payload: WorkCentreUpdate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> WorkCentreOut:
    return WorkCentreOut(
        **await service.update_work_centre(principal, work_centre_id, payload)
    )


# --- Processes -----------------------------------------------------------
@router.get(
    "/manufacturing/processes",
    response_model=ProcessPage,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_processes(
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    pagination: PaginationDep,
    process_type: str | None = Query(default=None, max_length=32),
    root_item_id: int | None = Query(default=None, ge=1),
    mbom_header_id: int | None = Query(default=None, ge=1),
    query: str | None = Query(default=None, max_length=200),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> ProcessPage:
    items, total = await service.list_processes(
        principal,
        process_type=process_type,
        root_item_id=root_item_id,
        mbom_header_id=mbom_header_id,
        query=query,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return ProcessPage(
        items=[ProcessOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/manufacturing/processes",
    response_model=ProcessOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def upsert_process(
    payload: ProcessCreate, principal: PrincipalDep, service: ManufacturingServiceDep
) -> ProcessOut:
    return ProcessOut(**await service.upsert_process(principal, payload))


@router.get(
    "/manufacturing/processes/{process_id}",
    response_model=ProcessOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def get_process(
    process_id: int, principal: PrincipalDep, service: ManufacturingServiceDep
) -> ProcessOut:
    return ProcessOut(**await service.get_process(principal, process_id))


@router.patch(
    "/manufacturing/processes/{process_id}",
    response_model=ProcessOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def update_process(
    process_id: int,
    payload: ProcessUpdate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> ProcessOut:
    return ProcessOut(**await service.update_process(principal, process_id, payload))


@router.get(
    "/manufacturing/processes/{process_id}/structure",
    response_model=ProcessStructureResponse,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def process_structure(
    process_id: int,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    max_depth: int = Query(default=5, ge=1, le=20),
    limit: int = Query(default=500, ge=1, le=5000),
) -> ProcessStructureResponse:
    result = await service.structure(
        principal, process_id, max_depth=max_depth, limit=limit
    )
    return ProcessStructureResponse(
        process=ProcessOut(**result["process"]),
        operations=[ProcessOperationRow(**row) for row in result["operations"]],
        total=result["total"],
        truncated=result["truncated"],
        cycle_detected=result["cycle_detected"],
    )


@router.get(
    "/manufacturing/processes/{process_id}/validate",
    response_model=ProcessValidationResponse,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_ANALYZE))],
)
async def validate_process(
    process_id: int, principal: PrincipalDep, service: ManufacturingServiceDep
) -> ProcessValidationResponse:
    result = await service.validate(principal, process_id)
    return ProcessValidationResponse(
        **{**result, "checks": [ProcessCheck(**check) for check in result["checks"]]}
    )


@router.post(
    "/manufacturing/processes/compare",
    response_model=ProcessCompareResponse,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_ANALYZE))],
)
async def compare_processes(
    payload: ProcessCompareRequest,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> ProcessCompareResponse:
    result = await service.compare(
        principal, payload.left_process_id, payload.right_process_id
    )
    return ProcessCompareResponse(
        **{**result, "diffs": [ProcessDiff(**diff) for diff in result["diffs"]]}
    )


# --- Process revisions ---------------------------------------------------
@router.get(
    "/manufacturing/process-revisions",
    response_model=list[ProcessRevisionOut],
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_process_revisions(
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    pagination: PaginationDep,
    process_id: int | None = Query(default=None, ge=1),
) -> list[ProcessRevisionOut]:
    items, _ = await service.list_process_revisions(
        principal,
        process_id=process_id,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return [ProcessRevisionOut(**item) for item in items]


@router.post(
    "/manufacturing/processes/{process_id}/revisions",
    response_model=ProcessRevisionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def create_process_revision(
    process_id: int,
    payload: ProcessRevisionCreate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> ProcessRevisionOut:
    return ProcessRevisionOut(
        **await service.upsert_process_revision(principal, process_id, payload)
    )


@router.patch(
    "/manufacturing/process-revisions/{revision_id}",
    response_model=ProcessRevisionOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def update_process_revision(
    revision_id: int,
    payload: ProcessRevisionUpdate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> ProcessRevisionOut:
    return ProcessRevisionOut(
        **await service.update_process_revision(principal, revision_id, payload)
    )


# --- Operations ----------------------------------------------------------
@router.get(
    "/manufacturing/operations",
    response_model=OperationPage,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_operations(
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    pagination: PaginationDep,
    process_id: int | None = Query(default=None, ge=1),
    work_centre_id: int | None = Query(default=None, ge=1),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> OperationPage:
    items, total = await service.list_operations(
        principal,
        process_id=process_id,
        work_centre_id=work_centre_id,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return OperationPage(
        items=[OperationOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/manufacturing/processes/{process_id}/operations",
    response_model=OperationOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def upsert_operation(
    process_id: int,
    payload: OperationCreate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> OperationOut:
    return OperationOut(**await service.upsert_operation(principal, process_id, payload))


@router.get(
    "/manufacturing/operations/{operation_id}",
    response_model=OperationOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def get_operation(
    operation_id: int, principal: PrincipalDep, service: ManufacturingServiceDep
) -> OperationOut:
    return OperationOut(**await service.get_operation(principal, operation_id))


@router.patch(
    "/manufacturing/operations/{operation_id}",
    response_model=OperationOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def update_operation(
    operation_id: int,
    payload: OperationUpdate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> OperationOut:
    return OperationOut(
        **await service.update_operation(principal, operation_id, payload)
    )


# --- Operation dependencies / consumption --------------------------------
@router.get(
    "/manufacturing/processes/{process_id}/dependencies",
    response_model=list[OperationDependencyOut],
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_dependencies(
    process_id: int, principal: PrincipalDep, service: ManufacturingServiceDep
) -> list[OperationDependencyOut]:
    rows = await service.list_dependencies(principal, process_id)
    return [OperationDependencyOut(**row) for row in rows]


@router.post(
    "/manufacturing/processes/{process_id}/dependencies",
    response_model=OperationDependencyOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def add_dependency(
    process_id: int,
    payload: OperationDependencyCreate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> OperationDependencyOut:
    return OperationDependencyOut(
        **await service.add_dependency(principal, process_id, payload)
    )


@router.delete(
    "/manufacturing/dependencies/{dependency_id}",
    status_code=204,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def delete_dependency(
    dependency_id: int, principal: PrincipalDep, service: ManufacturingServiceDep
) -> None:
    await service.delete_dependency(principal, dependency_id)


@router.get(
    "/manufacturing/consumptions",
    response_model=list[OperationConsumptionOut],
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_consumptions(
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    operation_id: int | None = Query(default=None, ge=1),
    child_item_id: int | None = Query(default=None, ge=1),
    limit: int = Query(default=200, ge=1, le=2000),
) -> list[OperationConsumptionOut]:
    rows = await service.list_consumptions(
        principal,
        operation_id=operation_id,
        child_item_id=child_item_id,
        limit=limit,
    )
    return [OperationConsumptionOut(**row) for row in rows]


@router.post(
    "/manufacturing/operations/{operation_id}/consumptions",
    response_model=OperationConsumptionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def add_consumption(
    operation_id: int,
    payload: OperationConsumptionCreate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> OperationConsumptionOut:
    return OperationConsumptionOut(
        **await service.add_consumption(principal, operation_id, payload)
    )


@router.delete(
    "/manufacturing/consumptions/{consumption_id}",
    status_code=204,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def delete_consumption(
    consumption_id: int, principal: PrincipalDep, service: ManufacturingServiceDep
) -> None:
    await service.delete_consumption(principal, consumption_id)


# --- Work instructions ---------------------------------------------------
@router.get(
    "/manufacturing/work-instructions",
    response_model=WorkInstructionPage,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_instructions(
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    pagination: PaginationDep,
    process_id: int | None = Query(default=None, ge=1),
    operation_id: int | None = Query(default=None, ge=1),
    query: str | None = Query(default=None, max_length=200),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> WorkInstructionPage:
    items, total = await service.list_instructions(
        principal,
        process_id=process_id,
        operation_id=operation_id,
        query=query,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return WorkInstructionPage(
        items=[WorkInstructionOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/manufacturing/work-instructions",
    response_model=WorkInstructionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def upsert_instruction(
    payload: WorkInstructionCreate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> WorkInstructionOut:
    return WorkInstructionOut(**await service.upsert_instruction(principal, payload))


@router.get(
    "/manufacturing/work-instructions/{instruction_id}",
    response_model=WorkInstructionOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def get_instruction(
    instruction_id: int,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> WorkInstructionOut:
    return WorkInstructionOut(
        **await service.get_instruction(principal, instruction_id)
    )


@router.patch(
    "/manufacturing/work-instructions/{instruction_id}",
    response_model=WorkInstructionOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def update_instruction(
    instruction_id: int,
    payload: WorkInstructionUpdate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> WorkInstructionOut:
    return WorkInstructionOut(
        **await service.update_instruction(principal, instruction_id, payload)
    )


# --- Resources -----------------------------------------------------------
@router.get(
    "/manufacturing/resources",
    response_model=ResourcePage,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_resources(
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    pagination: PaginationDep,
    resource_kind: str | None = Query(default=None, max_length=32),
    plant_id: int | None = Query(default=None, ge=1),
    query: str | None = Query(default=None, max_length=200),
) -> ResourcePage:
    items, total = await service.list_resources(
        principal,
        resource_kind=resource_kind,
        plant_id=plant_id,
        query=query,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return ResourcePage(
        items=[ResourceOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/manufacturing/resources",
    response_model=ResourceOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def upsert_resource(
    payload: ResourceCreate, principal: PrincipalDep, service: ManufacturingServiceDep
) -> ResourceOut:
    return ResourceOut(**await service.upsert_resource(principal, payload))


@router.patch(
    "/manufacturing/resources/{resource_id}",
    response_model=ResourceOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def update_resource(
    resource_id: int,
    payload: ResourceUpdate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> ResourceOut:
    return ResourceOut(
        **await service.update_resource(principal, resource_id, payload)
    )


# --- Production versions -------------------------------------------------
@router.get(
    "/manufacturing/production-versions",
    response_model=list[ProductionVersionOut],
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_READ))],
)
async def list_production_versions(
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
    pagination: PaginationDep,
    item_id: int | None = Query(default=None, ge=1),
    process_id: int | None = Query(default=None, ge=1),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> list[ProductionVersionOut]:
    items, _ = await service.list_production_versions(
        principal,
        item_id=item_id,
        process_id=process_id,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return [ProductionVersionOut(**item) for item in items]


@router.post(
    "/manufacturing/production-versions",
    response_model=ProductionVersionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def upsert_production_version(
    payload: ProductionVersionCreate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> ProductionVersionOut:
    return ProductionVersionOut(
        **await service.upsert_production_version(principal, payload)
    )


@router.patch(
    "/manufacturing/production-versions/{production_version_id}",
    response_model=ProductionVersionOut,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_WRITE))],
)
async def update_production_version(
    production_version_id: int,
    payload: ProductionVersionUpdate,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> ProductionVersionOut:
    return ProductionVersionOut(
        **await service.update_production_version(
            principal, production_version_id, payload
        )
    )


# --- Analytics / impact --------------------------------------------------
@router.get(
    "/manufacturing/analytics/{kind}",
    response_model=ManufacturingAnalyticsResponse,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_ANALYZE))],
)
async def manufacturing_analytics(
    kind: str, principal: PrincipalDep, service: ManufacturingServiceDep
) -> ManufacturingAnalyticsResponse:
    return ManufacturingAnalyticsResponse(**await service.analytics(principal, kind))


@router.post(
    "/manufacturing/impact",
    response_model=ManufacturingImpactResponse,
    dependencies=[Depends(require_capability(CAP_MANUFACTURING_ANALYZE))],
)
async def manufacturing_impact(
    payload: ManufacturingImpactRequest,
    principal: PrincipalDep,
    service: ManufacturingServiceDep,
) -> ManufacturingImpactResponse:
    return ManufacturingImpactResponse(
        **await service.impact(principal, payload.entity_id, max_depth=payload.max_depth)
    )
