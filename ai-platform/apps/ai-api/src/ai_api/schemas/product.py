"""Product & BOM Intelligence request/response schemas (Stage 8 / Step 6)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ItemType = Literal["product", "part", "assembly", "component", "material"]
BomType = Literal["EBOM", "MBOM", "BOP", "OTHER"]
Direction = Literal["up", "down", "both"]


# --- Items ----------------------------------------------------------------
class ProductItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_type: ItemType = "part"
    item_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    unit_of_measure: str = Field(default="EA", max_length=32)
    lifecycle_status: str = Field(default="active", max_length=32)
    configuration: dict[str, Any] = Field(default_factory=dict)
    variants: list[dict[str, Any]] = Field(default_factory=list, max_length=200)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class ProductItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    unit_of_measure: str | None = Field(default=None, max_length=32)
    lifecycle_status: str | None = Field(default=None, max_length=32)
    configuration: dict[str, Any] | None = None
    variants: list[dict[str, Any]] | None = Field(default=None, max_length=200)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class ProductItemOut(BaseModel):
    id: int
    item_type: str
    item_key: str
    name: str | None = None
    description: str | None = None
    unit_of_measure: str = "EA"
    lifecycle_status: str = "active"
    configuration: dict[str, Any] = Field(default_factory=dict)
    variants: list[dict[str, Any]] = Field(default_factory=list)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    external_id: str | None = None
    source_system: str | None = None
    source_ref: str | None = None
    classification: str = "internal"
    acl: dict[str, Any] = Field(default_factory=dict)
    graph_entity_id: int | None = None
    version: int = 1
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ProductItemPage(BaseModel):
    items: list[ProductItemOut]
    total: int
    limit: int
    offset: int


# --- Revisions ------------------------------------------------------------
class ProductRevisionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: str = Field(min_length=1, max_length=64)
    lifecycle_status: str = Field(default="draft", max_length=32)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    configuration: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class ProductRevisionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lifecycle_status: str | None = Field(default=None, max_length=32)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    configuration: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class ProductRevisionOut(BaseModel):
    id: int
    item_id: int
    revision: str
    lifecycle_status: str = "draft"
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    configuration: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = None
    source_system: str | None = None
    source_ref: str | None = None
    classification: str = "internal"
    acl: dict[str, Any] = Field(default_factory=dict)
    graph_entity_id: int | None = None
    version: int = 1
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


# --- BOM headers ----------------------------------------------------------
class BomHeaderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bom_type: BomType = "EBOM"
    bom_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    root_item_id: int | None = Field(default=None, ge=1)
    root_revision_id: int | None = Field(default=None, ge=1)
    plant: str | None = Field(default=None, max_length=128)
    configuration: dict[str, Any] = Field(default_factory=dict)
    lifecycle_status: str = Field(default="draft", max_length=32)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class BomHeaderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    root_item_id: int | None = Field(default=None, ge=1)
    root_revision_id: int | None = Field(default=None, ge=1)
    plant: str | None = Field(default=None, max_length=128)
    configuration: dict[str, Any] | None = None
    lifecycle_status: str | None = Field(default=None, max_length=32)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class BomHeaderOut(BaseModel):
    id: int
    bom_type: str
    bom_key: str
    name: str | None = None
    description: str | None = None
    root_item_id: int | None = None
    root_revision_id: int | None = None
    plant: str | None = None
    configuration: dict[str, Any] = Field(default_factory=dict)
    lifecycle_status: str = "draft"
    external_id: str | None = None
    source_system: str | None = None
    source_ref: str | None = None
    classification: str = "internal"
    acl: dict[str, Any] = Field(default_factory=dict)
    graph_entity_id: int | None = None
    version: int = 1
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BomHeaderPage(BaseModel):
    items: list[BomHeaderOut]
    total: int
    limit: int
    offset: int


# --- BOM lines ------------------------------------------------------------
class BomLineCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parent_revision_id: int = Field(ge=1)
    child_item_id: int = Field(ge=1)
    child_revision_id: int | None = Field(default=None, ge=1)
    line_key: str | None = Field(default=None, max_length=256)
    quantity: float = Field(default=1.0, gt=0)
    unit_of_measure: str = Field(default="EA", max_length=32)
    find_number: str | None = Field(default=None, max_length=64)
    sequence: int = Field(default=0, ge=0)
    reference_designators: list[str] = Field(default_factory=list, max_length=500)
    usage: str = Field(default="DESIGN", max_length=32)
    line_status: str = Field(default="active", max_length=32)
    is_phantom: bool = False
    is_reference: bool = False
    alternate_of_line_id: int | None = Field(default=None, ge=1)
    substitute_for_item_id: int | None = Field(default=None, ge=1)
    plant: str | None = Field(default=None, max_length=128)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    configuration: dict[str, Any] = Field(default_factory=dict)
    attributes: dict[str, Any] = Field(default_factory=dict)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    external_id: str | None = Field(default=None, max_length=256)


class BomLineUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    child_revision_id: int | None = Field(default=None, ge=1)
    quantity: float | None = Field(default=None, gt=0)
    unit_of_measure: str | None = Field(default=None, max_length=32)
    find_number: str | None = Field(default=None, max_length=64)
    sequence: int | None = Field(default=None, ge=0)
    reference_designators: list[str] | None = Field(default=None, max_length=500)
    usage: str | None = Field(default=None, max_length=32)
    line_status: str | None = Field(default=None, max_length=32)
    is_phantom: bool | None = None
    is_reference: bool | None = None
    substitute_for_item_id: int | None = Field(default=None, ge=1)
    plant: str | None = Field(default=None, max_length=128)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    configuration: dict[str, Any] | None = None
    attributes: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class BomLineOut(BaseModel):
    id: int
    bom_header_id: int
    parent_revision_id: int
    child_item_id: int
    child_revision_id: int | None = None
    line_key: str
    quantity: float = 1.0
    unit_of_measure: str = "EA"
    find_number: str | None = None
    sequence: int = 0
    reference_designators: list[str] = Field(default_factory=list)
    usage: str = "DESIGN"
    line_status: str = "active"
    is_phantom: bool = False
    is_reference: bool = False
    alternate_of_line_id: int | None = None
    substitute_for_item_id: int | None = None
    plant: str | None = None
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    configuration: dict[str, Any] = Field(default_factory=dict)
    attributes: dict[str, Any] = Field(default_factory=dict)
    version: int = 1
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BomLinePage(BaseModel):
    items: list[BomLineOut]
    total: int
    limit: int
    offset: int


# --- Structure / explosion ------------------------------------------------
class BomTreeRow(BaseModel):
    line_id: int
    line_key: str
    child_item_id: int
    child_item_key: str | None = None
    child_name: str | None = None
    child_revision_id: int | None = None
    child_revision: str | None = None
    quantity: float = 1.0
    unit_of_measure: str = "EA"
    find_number: str | None = None
    sequence: int = 0
    depth: int = 1
    path: list[int] = Field(default_factory=list)
    cumulative_quantity: float = 1.0
    is_phantom: bool = False
    is_reference: bool = False
    has_children: bool = False


class BomStructureResponse(BaseModel):
    header: BomHeaderOut
    root_item: ProductItemOut | None = None
    rows: list[BomTreeRow] = Field(default_factory=list)
    total: int = 0
    max_depth_reached: int = 0
    truncated: bool = False
    cycle_detected: bool = False
    cycles: list[list[int]] = Field(default_factory=list)


# --- Comparison -----------------------------------------------------------
class BomCompareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    left_header_id: int = Field(ge=1)
    right_header_id: int = Field(ge=1)
    scope: Literal["line", "recursive"] = "line"


class BomLineDiff(BaseModel):
    change_type: str
    line_key: str | None = None
    child_item_id: int | None = None
    left_line_id: int | None = None
    right_line_id: int | None = None
    parent_revision_id: int | None = None
    changes: list[str] = Field(default_factory=list)
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None


class BomCompareResponse(BaseModel):
    left_header_id: int
    right_header_id: int
    scope: str
    summary: dict[str, int] = Field(default_factory=dict)
    diffs: list[BomLineDiff] = Field(default_factory=list)
    truncated: bool = False


# --- Transformation / reconciliation -------------------------------------
class BomTransformRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_header_id: int = Field(ge=1)
    target_header_id: int | None = Field(default=None, ge=1)
    mode: Literal["DRY_RUN", "EXECUTE"] = "DRY_RUN"


class BomTransformationEntryOut(BaseModel):
    id: int | None = None
    source_line_id: int | None = None
    target_line_id: int | None = None
    mapping_type: str = "UNMATCHED"
    quantity: float | None = None
    unit_of_measure: str | None = None
    notes: str | None = None


class BomTransformationRunOut(BaseModel):
    id: int | None = None
    source_header_id: int
    target_header_id: int | None = None
    mode: str = "DRY_RUN"
    status: str = "completed"
    summary: dict[str, Any] = Field(default_factory=dict)
    entries: list[BomTransformationEntryOut] = Field(default_factory=list)
    created_by: str | None = None
    created_at: datetime | None = None


class BomReconcileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_header_id: int = Field(ge=1)
    target_header_id: int = Field(ge=1)


class BomReconciliationException(BaseModel):
    type: str
    source_line_id: int | None = None
    target_line_id: int | None = None
    child_item_id: int | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class BomReconciliationOut(BaseModel):
    id: int
    source_header_id: int
    target_header_id: int | None = None
    run_id: int | None = None
    status: str = "open"
    exceptions: list[BomReconciliationException] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None


# --- Product intelligence -------------------------------------------------
class BomIntelligenceRow(BaseModel):
    item_id: int | None = None
    item_key: str | None = None
    name: str | None = None
    reason: str | None = None
    score: float = 0.0
    kind: str = "similar"
    occurrences: int = 0
    detail: dict[str, Any] = Field(default_factory=dict)


class BomIntelligenceResponse(BaseModel):
    kind: str
    rows: list[BomIntelligenceRow] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False
    summary: dict[str, Any] = Field(default_factory=dict)


class BomQualityIssue(BaseModel):
    rule: str
    severity: str = "warning"
    line_id: int | None = None
    child_item_id: int | None = None
    message: str
    detail: dict[str, Any] = Field(default_factory=dict)


class BomQualityResponse(BaseModel):
    header_id: int
    status: str = "pass"
    score: float = 1.0
    issues: list[BomQualityIssue] = Field(default_factory=list)
    summary: dict[str, int] = Field(default_factory=dict)
    truncated: bool = False


class ProductIntelligenceStats(BaseModel):
    items: int = 0
    products: int = 0
    parts: int = 0
    assemblies: int = 0
    revisions: int = 0
    eboms: int = 0
    mboms: int = 0
    bom_lines: int = 0
    orphan_parts: int = 0
    obsolete_items: int = 0
    status: str = "ok"


class ChangeImpactRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    change_entity_id: int = Field(ge=1)
    max_depth: int = Field(default=3, ge=1, le=6)


class ChangeImpactResponse(BaseModel):
    change_entity_id: int
    affected_items: list[BomIntelligenceRow] = Field(default_factory=list)
    affected_boms: list[BomIntelligenceRow] = Field(default_factory=list)
    inferred: bool = False
    paths: list[dict[str, Any]] = Field(default_factory=list)
    truncated: bool = False
