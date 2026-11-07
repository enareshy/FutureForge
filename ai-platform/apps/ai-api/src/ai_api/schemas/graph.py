"""Knowledge graph request/response schemas (Stage 7)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

LIFECYCLE_STATES = (
    "active",
    "inactive",
    "draft",
    "released",
    "obsolete",
    "stale",
    "archived",
)
RELATIONSHIP_STATES = ("active", "inactive", "stale", "archived")
Direction = Literal["outgoing", "incoming", "both"]


class GraphEntityCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entity_type: str = Field(min_length=1, max_length=64)
    stable_key: str = Field(min_length=1, max_length=256)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)
    lifecycle_status: str = Field(default="active", max_length=32)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    properties: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    valid_from: datetime | None = None
    valid_to: datetime | None = None


class GraphEntityUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    lifecycle_status: str | None = Field(default=None, max_length=32)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    properties: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class GraphEntityOut(BaseModel):
    id: int
    entity_type: str
    stable_key: str
    external_id: str | None = None
    source_system: str | None = None
    source_ref: str | None = None
    name: str | None = None
    description: str | None = None
    classification: str = "internal"
    acl: dict[str, Any] = Field(default_factory=dict)
    lifecycle_status: str = "active"
    confidence: float = 1.0
    properties: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    version: int = 1
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class GraphEntityPage(BaseModel):
    items: list[GraphEntityOut]
    total: int
    limit: int
    offset: int


class GraphEntityVersionOut(BaseModel):
    id: int
    entity_id: int
    version: int
    snapshot: dict[str, Any] = Field(default_factory=dict)
    change_reason: str | None = None
    created_by: str | None = None
    created_at: datetime | None = None


class GraphRelationshipCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    relationship_type: str = Field(min_length=1, max_length=64)
    source_entity_id: int = Field(ge=1)
    target_entity_id: int = Field(ge=1)
    properties: dict[str, Any] = Field(default_factory=dict)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    lifecycle_status: str = Field(default="active", max_length=32)
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class GraphRelationshipUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    properties: dict[str, Any] | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    lifecycle_status: str | None = Field(default=None, max_length=32)
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class GraphRelationshipOut(BaseModel):
    id: int
    relationship_type: str
    source_entity_id: int
    target_entity_id: int
    properties: dict[str, Any] = Field(default_factory=dict)
    confidence: float = 1.0
    source_system: str | None = None
    source_ref: str | None = None
    lifecycle_status: str = "active"
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    version: int = 1
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class GraphRelationshipPage(BaseModel):
    items: list[GraphRelationshipOut]
    total: int
    limit: int
    offset: int


class GraphBulkEntity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entity_type: str = Field(min_length=1, max_length=64)
    stable_key: str = Field(min_length=1, max_length=256)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)
    lifecycle_status: str = Field(default="active", max_length=32)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    properties: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class GraphBulkRelationship(BaseModel):
    model_config = ConfigDict(extra="forbid")

    relationship_type: str = Field(min_length=1, max_length=64)
    source_stable_key: str = Field(min_length=1, max_length=256)
    target_stable_key: str = Field(min_length=1, max_length=256)
    source_entity_type: str | None = Field(default=None, max_length=64)
    target_entity_type: str | None = Field(default=None, max_length=64)
    properties: dict[str, Any] = Field(default_factory=dict)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    lifecycle_status: str = Field(default="active", max_length=32)


class GraphBulkIngestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_system: str | None = Field(default=None, max_length=128)
    entities: list[GraphBulkEntity] = Field(default_factory=list, max_length=500)
    relationships: list[GraphBulkRelationship] = Field(default_factory=list, max_length=1000)
    reconcile: bool = False


class GraphBulkIngestResult(BaseModel):
    entities_created: int = 0
    entities_updated: int = 0
    relationships_created: int = 0
    relationships_updated: int = 0
    relationships_skipped: int = 0
    stale_relationships: int = 0


class GraphNeighborOut(BaseModel):
    entity: GraphEntityOut
    relationship: GraphRelationshipOut
    direction: str
    depth: int


class GraphNeighborhoodResponse(BaseModel):
    root: GraphEntityOut
    nodes: list[GraphEntityOut] = Field(default_factory=list)
    relationships: list[GraphRelationshipOut] = Field(default_factory=list)
    neighbors: list[GraphNeighborOut] = Field(default_factory=list)
    truncated: bool = False


class GraphTraverseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    direction: Direction = "outgoing"
    relationship_types: list[str] = Field(default_factory=list, max_length=50)
    entity_types: list[str] = Field(default_factory=list, max_length=50)
    max_depth: int = Field(default=2, ge=1, le=6)
    limit: int = Field(default=50, ge=1, le=500)


class GraphPathOut(BaseModel):
    nodes: list[GraphEntityOut] = Field(default_factory=list)
    relationships: list[GraphRelationshipOut] = Field(default_factory=list)
    confidence: float = 1.0
    score: float = 1.0


class GraphTraversalResponse(BaseModel):
    root: GraphEntityOut
    nodes: list[GraphEntityOut] = Field(default_factory=list)
    relationships: list[GraphRelationshipOut] = Field(default_factory=list)
    paths: list[GraphPathOut] = Field(default_factory=list)
    depth_reached: int = 0
    truncated: bool = False
    cycle_detected: bool = False


class GraphPathRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_entity_id: int = Field(ge=1)
    direction: Direction = "outgoing"
    relationship_types: list[str] = Field(default_factory=list, max_length=50)
    max_depth: int = Field(default=4, ge=1, le=6)
    max_paths: int = Field(default=5, ge=1, le=20)


class GraphPathResponse(BaseModel):
    source: GraphEntityOut
    target: GraphEntityOut
    paths: list[GraphPathOut] = Field(default_factory=list)
    truncated: bool = False


class DigitalThreadResponse(BaseModel):
    product: GraphEntityOut
    sections: dict[str, list[GraphEntityOut]] = Field(default_factory=dict)
    relationships: list[GraphRelationshipOut] = Field(default_factory=list)
    paths: list[GraphPathOut] = Field(default_factory=list)
    truncated: bool = False


class WhereUsedItem(BaseModel):
    entity: GraphEntityOut
    path: list[GraphEntityOut] = Field(default_factory=list)
    relationships: list[GraphRelationshipOut] = Field(default_factory=list)
    depth: int = 1


class WhereUsedResponse(BaseModel):
    part: GraphEntityOut
    used_by: list[WhereUsedItem] = Field(default_factory=list)
    products: list[GraphEntityOut] = Field(default_factory=list)
    boms: list[GraphEntityOut] = Field(default_factory=list)
    truncated: bool = False


class ImpactItem(BaseModel):
    entity: GraphEntityOut
    impact: str
    confidence: float = 1.0
    path: list[GraphEntityOut] = Field(default_factory=list)
    relationships: list[GraphRelationshipOut] = Field(default_factory=list)
    depth: int = 1


class ImpactResponse(BaseModel):
    change: GraphEntityOut
    affected: list[ImpactItem] = Field(default_factory=list)
    direct_count: int = 0
    indirect_count: int = 0
    truncated: bool = False
    inferred: bool = False


class TraceabilityLink(BaseModel):
    source: GraphEntityOut
    target: GraphEntityOut
    relationship_type: str
    inferred: bool = False
    confidence: float = 1.0
    path: list[GraphEntityOut] = Field(default_factory=list)


class GraphTraceabilityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_depth: int = Field(default=4, ge=1, le=6)


class TraceabilityResponse(BaseModel):
    root: GraphEntityOut
    links: list[TraceabilityLink] = Field(default_factory=list)
    orphaned: list[GraphEntityOut] = Field(default_factory=list)
    truncated: bool = False


class GraphTypeOut(BaseModel):
    code: str
    name: str
    description: str | None = None
    category: str | None = None
    source_types: list[str] = Field(default_factory=list)
    target_types: list[str] = Field(default_factory=list)
    directed: bool = True
    enabled: bool = True
    builtin: bool = False


class GraphTypesResponse(BaseModel):
    entity_types: list[GraphTypeOut] = Field(default_factory=list)
    relationship_types: list[GraphTypeOut] = Field(default_factory=list)


class GraphTypeUpsert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    category: str | None = Field(default=None, max_length=100)
    source_types: list[str] = Field(default_factory=list, max_length=50)
    target_types: list[str] = Field(default_factory=list, max_length=50)
    directed: bool = True
    property_schema: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class GraphStatsResponse(BaseModel):
    entities: int = 0
    relationships: int = 0
    stale_entities: int = 0
    entity_type_counts: list[dict[str, Any]] = Field(default_factory=list)
    last_entity_update: datetime | None = None
    last_relationship_update: datetime | None = None
    status: str = "ok"


class GraphSearchResponse(BaseModel):
    items: list[GraphEntityOut] = Field(default_factory=list)
    total: int = 0
