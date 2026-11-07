"""Enterprise knowledge graph and digital thread API (Stage 7)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    GraphQueryServiceDep,
    GraphServiceDep,
    PaginationDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.graph import (
    DigitalThreadResponse,
    GraphBulkIngestRequest,
    GraphBulkIngestResult,
    GraphEntityCreate,
    GraphEntityOut,
    GraphEntityPage,
    GraphEntityUpdate,
    GraphEntityVersionOut,
    GraphNeighborhoodResponse,
    GraphPathRequest,
    GraphPathResponse,
    GraphRelationshipCreate,
    GraphRelationshipOut,
    GraphRelationshipPage,
    GraphRelationshipUpdate,
    GraphSearchResponse,
    GraphStatsResponse,
    GraphTraceabilityRequest,
    GraphTraversalResponse,
    GraphTraverseRequest,
    GraphTypeOut,
    GraphTypesResponse,
    GraphTypeUpsert,
    ImpactResponse,
    TraceabilityResponse,
    WhereUsedResponse,
)
from ai_api.security.permissions import (
    CAP_GRAPH_QUERY,
    CAP_GRAPH_READ,
    CAP_GRAPH_WRITE,
)

router = APIRouter(tags=["graph"], dependencies=[Depends(enforce_rate_limit)])


def _split_csv(value: str | None) -> list[str] | None:
    if not value:
        return None
    items = [part.strip() for part in value.split(",") if part.strip()]
    return items or None


# --- Types ---------------------------------------------------------------


@router.get(
    "/graph/types",
    response_model=GraphTypesResponse,
    dependencies=[Depends(require_capability(CAP_GRAPH_READ))],
)
async def list_graph_types(
    principal: PrincipalDep, service: GraphServiceDep
) -> GraphTypesResponse:
    return GraphTypesResponse(**await service.list_types(principal))


@router.post(
    "/graph/entity-types",
    response_model=GraphTypeOut,
    dependencies=[Depends(require_capability(CAP_GRAPH_WRITE))],
)
async def upsert_graph_entity_type(
    payload: GraphTypeUpsert, principal: PrincipalDep, service: GraphServiceDep
) -> GraphTypeOut:
    return GraphTypeOut(**await service.upsert_entity_type(principal, payload))


@router.post(
    "/graph/relationship-types",
    response_model=GraphTypeOut,
    dependencies=[Depends(require_capability(CAP_GRAPH_WRITE))],
)
async def upsert_graph_relationship_type(
    payload: GraphTypeUpsert, principal: PrincipalDep, service: GraphServiceDep
) -> GraphTypeOut:
    return GraphTypeOut(**await service.upsert_relationship_type(principal, payload))


# --- Statistics ----------------------------------------------------------


@router.get(
    "/graph/stats",
    response_model=GraphStatsResponse,
    dependencies=[Depends(require_capability(CAP_GRAPH_READ))],
)
async def graph_stats(
    principal: PrincipalDep, service: GraphServiceDep
) -> GraphStatsResponse:
    return GraphStatsResponse(**await service.stats(principal))


# --- Entities ------------------------------------------------------------


@router.get(
    "/graph/entities",
    response_model=GraphEntityPage,
    dependencies=[Depends(require_capability(CAP_GRAPH_READ))],
)
async def list_graph_entities(
    principal: PrincipalDep,
    service: GraphServiceDep,
    pagination: PaginationDep,
    query: str | None = Query(default=None, max_length=200),
    entity_types: str | None = Query(default=None, max_length=600),
    lifecycle_status: str | None = Query(default=None, max_length=32),
    source_system: str | None = Query(default=None, max_length=128),
) -> GraphEntityPage:
    items, total = await service.list_entities(
        principal,
        entity_types=_split_csv(entity_types),
        query=query,
        lifecycle_status=lifecycle_status,
        source_system=source_system,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return GraphEntityPage(
        items=[GraphEntityOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.get(
    "/graph/search",
    response_model=GraphSearchResponse,
    dependencies=[Depends(require_capability(CAP_GRAPH_QUERY))],
)
async def search_graph_entities(
    principal: PrincipalDep,
    service: GraphServiceDep,
    q: str = Query(min_length=1, max_length=200),
    entity_types: str | None = Query(default=None, max_length=600),
    limit: int = Query(default=20, ge=1, le=100),
) -> GraphSearchResponse:
    items, total = await service.list_entities(
        principal,
        entity_types=_split_csv(entity_types),
        query=q,
        lifecycle_status=None,
        source_system=None,
        limit=limit,
        offset=0,
    )
    return GraphSearchResponse(
        items=[GraphEntityOut(**item) for item in items], total=total
    )


@router.post(
    "/graph/entities",
    response_model=GraphEntityOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_GRAPH_WRITE))],
)
async def create_graph_entity(
    payload: GraphEntityCreate, principal: PrincipalDep, service: GraphServiceDep
) -> GraphEntityOut:
    return GraphEntityOut(**await service.create_or_update_entity(principal, payload))


@router.get(
    "/graph/entities/{entity_id}",
    response_model=GraphEntityOut,
    dependencies=[Depends(require_capability(CAP_GRAPH_READ))],
)
async def get_graph_entity(
    entity_id: int, principal: PrincipalDep, service: GraphServiceDep
) -> GraphEntityOut:
    return GraphEntityOut(**await service.get_entity(principal, entity_id))


@router.patch(
    "/graph/entities/{entity_id}",
    response_model=GraphEntityOut,
    dependencies=[Depends(require_capability(CAP_GRAPH_WRITE))],
)
async def update_graph_entity(
    entity_id: int,
    payload: GraphEntityUpdate,
    principal: PrincipalDep,
    service: GraphServiceDep,
) -> GraphEntityOut:
    return GraphEntityOut(
        **await service.update_entity(principal, entity_id, payload)
    )


@router.delete(
    "/graph/entities/{entity_id}",
    response_model=GraphEntityOut,
    dependencies=[Depends(require_capability(CAP_GRAPH_WRITE))],
)
async def delete_graph_entity(
    entity_id: int, principal: PrincipalDep, service: GraphServiceDep
) -> GraphEntityOut:
    return GraphEntityOut(**await service.delete_entity(principal, entity_id))


@router.get(
    "/graph/entities/{entity_id}/versions",
    response_model=list[GraphEntityVersionOut],
    dependencies=[Depends(require_capability(CAP_GRAPH_READ))],
)
async def list_graph_entity_versions(
    entity_id: int, principal: PrincipalDep, service: GraphServiceDep
) -> list[GraphEntityVersionOut]:
    return [
        GraphEntityVersionOut(**row)
        for row in await service.entity_versions(principal, entity_id)
    ]


@router.get(
    "/graph/entities/{entity_id}/neighborhood",
    response_model=GraphNeighborhoodResponse,
    dependencies=[Depends(require_capability(CAP_GRAPH_QUERY))],
)
async def graph_neighborhood(
    entity_id: int,
    principal: PrincipalDep,
    service: GraphQueryServiceDep,
    direction: str = Query(default="both", pattern=r"^(outgoing|incoming|both)$"),
    relationship_types: str | None = Query(default=None, max_length=600),
    limit: int = Query(default=50, ge=1, le=500),
) -> GraphNeighborhoodResponse:
    return GraphNeighborhoodResponse(
        **await service.neighbors(
            principal,
            entity_id,
            direction=direction,
            relationship_types=_split_csv(relationship_types),
            limit=limit,
        )
    )


@router.post(
    "/graph/entities/{entity_id}/traverse",
    response_model=GraphTraversalResponse,
    dependencies=[Depends(require_capability(CAP_GRAPH_QUERY))],
)
async def graph_traverse(
    entity_id: int,
    payload: GraphTraverseRequest,
    principal: PrincipalDep,
    service: GraphQueryServiceDep,
) -> GraphTraversalResponse:
    return GraphTraversalResponse(
        **await service.traverse(
            principal,
            entity_id,
            direction=payload.direction,
            relationship_types=payload.relationship_types or None,
            entity_types=payload.entity_types or None,
            max_depth=payload.max_depth,
            limit=payload.limit,
        )
    )


@router.post(
    "/graph/entities/{entity_id}/paths",
    response_model=GraphPathResponse,
    dependencies=[Depends(require_capability(CAP_GRAPH_QUERY))],
)
async def graph_paths(
    entity_id: int,
    payload: GraphPathRequest,
    principal: PrincipalDep,
    service: GraphQueryServiceDep,
) -> GraphPathResponse:
    return GraphPathResponse(
        **await service.find_paths(
            principal,
            entity_id,
            target_id=payload.target_entity_id,
            direction=payload.direction,
            relationship_types=payload.relationship_types or None,
            max_depth=payload.max_depth,
            max_paths=payload.max_paths,
        )
    )


# --- Relationships -------------------------------------------------------


@router.get(
    "/graph/relationships",
    response_model=GraphRelationshipPage,
    dependencies=[Depends(require_capability(CAP_GRAPH_READ))],
)
async def list_graph_relationships(
    principal: PrincipalDep,
    service: GraphServiceDep,
    pagination: PaginationDep,
    entity_ids: str | None = Query(default=None, max_length=600),
    relationship_types: str | None = Query(default=None, max_length=600),
    direction: str = Query(default="both", pattern=r"^(outgoing|incoming|both)$"),
    include_inactive: bool = Query(default=False),
) -> GraphRelationshipPage:
    ids = None
    if entity_ids:
        try:
            ids = [int(part.strip()) for part in entity_ids.split(",") if part.strip()]
        except ValueError:
            ids = None
    items, total = await service.list_relationships(
        principal,
        entity_ids=ids,
        relationship_types=_split_csv(relationship_types),
        direction=direction,
        include_inactive=include_inactive,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return GraphRelationshipPage(
        items=[GraphRelationshipOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    "/graph/relationships",
    response_model=GraphRelationshipOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_GRAPH_WRITE))],
)
async def create_graph_relationship(
    payload: GraphRelationshipCreate,
    principal: PrincipalDep,
    service: GraphServiceDep,
) -> GraphRelationshipOut:
    return GraphRelationshipOut(
        **await service.create_relationship(principal, payload)
    )


@router.get(
    "/graph/relationships/{relationship_id}",
    response_model=GraphRelationshipOut,
    dependencies=[Depends(require_capability(CAP_GRAPH_READ))],
)
async def get_graph_relationship(
    relationship_id: int, principal: PrincipalDep, service: GraphServiceDep
) -> GraphRelationshipOut:
    return GraphRelationshipOut(
        **await service.get_relationship(principal, relationship_id)
    )


@router.patch(
    "/graph/relationships/{relationship_id}",
    response_model=GraphRelationshipOut,
    dependencies=[Depends(require_capability(CAP_GRAPH_WRITE))],
)
async def update_graph_relationship(
    relationship_id: int,
    payload: GraphRelationshipUpdate,
    principal: PrincipalDep,
    service: GraphServiceDep,
) -> GraphRelationshipOut:
    return GraphRelationshipOut(
        **await service.update_relationship(principal, relationship_id, payload)
    )


@router.delete(
    "/graph/relationships/{relationship_id}",
    response_model=GraphRelationshipOut,
    dependencies=[Depends(require_capability(CAP_GRAPH_WRITE))],
)
async def delete_graph_relationship(
    relationship_id: int, principal: PrincipalDep, service: GraphServiceDep
) -> GraphRelationshipOut:
    return GraphRelationshipOut(
        **await service.delete_relationship(principal, relationship_id)
    )


# --- Bulk ingestion ------------------------------------------------------


@router.post(
    "/graph/ingest",
    response_model=GraphBulkIngestResult,
    dependencies=[Depends(require_capability(CAP_GRAPH_WRITE))],
)
async def bulk_ingest_graph(
    payload: GraphBulkIngestRequest,
    principal: PrincipalDep,
    service: GraphServiceDep,
) -> GraphBulkIngestResult:
    return GraphBulkIngestResult(**await service.bulk_ingest(principal, payload))


@router.post(
    "/graph/reconcile",
    dependencies=[Depends(require_capability(CAP_GRAPH_WRITE))],
)
async def reconcile_graph(
    principal: PrincipalDep,
    service: GraphServiceDep,
    source_system: str = Query(min_length=1, max_length=128),
) -> dict:
    return await service.reconcile(principal, source_system)


# --- Enterprise intelligence --------------------------------------------


@router.get(
    "/graph/products/{product_id}/digital-thread",
    response_model=DigitalThreadResponse,
    dependencies=[Depends(require_capability(CAP_GRAPH_QUERY))],
)
async def digital_thread(
    product_id: int, principal: PrincipalDep, service: GraphQueryServiceDep
) -> DigitalThreadResponse:
    return DigitalThreadResponse(
        **await service.digital_thread(principal, product_id)
    )


@router.get(
    "/graph/parts/{part_id}/where-used",
    response_model=WhereUsedResponse,
    dependencies=[Depends(require_capability(CAP_GRAPH_QUERY))],
)
async def where_used(
    part_id: int,
    principal: PrincipalDep,
    service: GraphQueryServiceDep,
    max_depth: int = Query(default=3, ge=1, le=6),
) -> WhereUsedResponse:
    return WhereUsedResponse(
        **await service.where_used(principal, part_id, max_depth=max_depth)
    )


@router.get(
    "/graph/changes/{change_id}/impact",
    response_model=ImpactResponse,
    dependencies=[Depends(require_capability(CAP_GRAPH_QUERY))],
)
async def change_impact(
    change_id: int,
    principal: PrincipalDep,
    service: GraphQueryServiceDep,
    max_depth: int = Query(default=3, ge=1, le=6),
) -> ImpactResponse:
    return ImpactResponse(
        **await service.change_impact(principal, change_id, max_depth=max_depth)
    )


@router.post(
    "/graph/entities/{entity_id}/traceability",
    response_model=TraceabilityResponse,
    dependencies=[Depends(require_capability(CAP_GRAPH_QUERY))],
)
async def traceability(
    entity_id: int,
    payload: GraphTraceabilityRequest,
    principal: PrincipalDep,
    service: GraphQueryServiceDep,
) -> TraceabilityResponse:
    return TraceabilityResponse(
        **await service.traceability(
            principal, entity_id, max_depth=payload.max_depth
        )
    )
