"""Manufacturing Intelligence request/response schemas (Stage 9 / Step 7)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ProcessType = Literal["assembly", "machining", "fabrication", "test", "packaging", "other"]
WorkCentreType = Literal[
    "assembly", "machining", "fabrication", "test", "packaging", "other"
]
OperationType = Literal[
    "value_add", "setup", "inspection", "transport", "storage", "rework", "other"
]
OperationDependencyType = Literal[
    "finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"
]
ConsumptionType = Literal["component", "material", "consumable", "tooling"]
InstructionType = Literal["text", "visual", "video", "checklist"]
ResourceKind = Literal["tooling", "equipment", "fixture", "gauge", "machine", "other"]
Direction = Literal["up", "down", "both"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- Plants ---------------------------------------------------------------
class PlantCreate(_Strict):
    plant_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    site_code: str | None = Field(default=None, max_length=128)
    country: str | None = Field(default=None, max_length=128)
    timezone: str | None = Field(default=None, max_length=64)
    lifecycle_status: str = Field(default="active", max_length=32)
    attributes: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class PlantUpdate(_Strict):
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    site_code: str | None = Field(default=None, max_length=128)
    country: str | None = Field(default=None, max_length=128)
    timezone: str | None = Field(default=None, max_length=64)
    lifecycle_status: str | None = Field(default=None, max_length=32)
    attributes: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class PlantOut(BaseModel):
    id: int
    plant_key: str
    name: str | None = None
    description: str | None = None
    site_code: str | None = None
    country: str | None = None
    timezone: str | None = None
    lifecycle_status: str = "active"
    attributes: dict[str, Any] = Field(default_factory=dict)
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


class PlantPage(BaseModel):
    items: list[PlantOut]
    total: int
    limit: int
    offset: int


# --- Production lines -----------------------------------------------------
class ProductionLineCreate(_Strict):
    plant_id: int = Field(ge=1)
    line_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    lifecycle_status: str = Field(default="active", max_length=32)
    capacity_per_hour: float | None = Field(default=None, ge=0)
    attributes: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class ProductionLineUpdate(_Strict):
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    lifecycle_status: str | None = Field(default=None, max_length=32)
    capacity_per_hour: float | None = Field(default=None, ge=0)
    attributes: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class ProductionLineOut(BaseModel):
    id: int
    plant_id: int
    line_key: str
    name: str | None = None
    description: str | None = None
    lifecycle_status: str = "active"
    capacity_per_hour: float | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
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


class ProductionLinePage(BaseModel):
    items: list[ProductionLineOut]
    total: int
    limit: int
    offset: int


# --- Work centres ---------------------------------------------------------
class WorkCentreCreate(_Strict):
    plant_id: int = Field(ge=1)
    line_id: int | None = Field(default=None, ge=1)
    work_centre_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    work_centre_type: WorkCentreType = "other"
    lifecycle_status: str = Field(default="active", max_length=32)
    capacity_per_hour: float | None = Field(default=None, ge=0)
    attributes: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class WorkCentreUpdate(_Strict):
    line_id: int | None = Field(default=None, ge=1)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    work_centre_type: WorkCentreType | None = None
    lifecycle_status: str | None = Field(default=None, max_length=32)
    capacity_per_hour: float | None = Field(default=None, ge=0)
    attributes: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class WorkCentreOut(BaseModel):
    id: int
    plant_id: int
    line_id: int | None = None
    work_centre_key: str
    name: str | None = None
    description: str | None = None
    work_centre_type: str = "other"
    lifecycle_status: str = "active"
    capacity_per_hour: float | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
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


class WorkCentrePage(BaseModel):
    items: list[WorkCentreOut]
    total: int
    limit: int
    offset: int


# --- Process / process plan ----------------------------------------------
class ProcessCreate(_Strict):
    process_type: ProcessType = "assembly"
    process_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    root_item_id: int | None = Field(default=None, ge=1)
    root_revision_id: int | None = Field(default=None, ge=1)
    mbom_header_id: int | None = Field(default=None, ge=1)
    plant_id: int | None = Field(default=None, ge=1)
    line_id: int | None = Field(default=None, ge=1)
    revision: str = Field(default="A", min_length=1, max_length=64)
    lifecycle_status: str = Field(default="draft", max_length=32)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    configuration: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class ProcessUpdate(_Strict):
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    root_item_id: int | None = Field(default=None, ge=1)
    root_revision_id: int | None = Field(default=None, ge=1)
    mbom_header_id: int | None = Field(default=None, ge=1)
    plant_id: int | None = Field(default=None, ge=1)
    line_id: int | None = Field(default=None, ge=1)
    lifecycle_status: str | None = Field(default=None, max_length=32)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    configuration: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class ProcessOut(BaseModel):
    id: int
    process_type: str
    process_key: str
    name: str | None = None
    description: str | None = None
    root_item_id: int | None = None
    root_revision_id: int | None = None
    mbom_header_id: int | None = None
    plant_id: int | None = None
    line_id: int | None = None
    revision: str = "A"
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


class ProcessPage(BaseModel):
    items: list[ProcessOut]
    total: int
    limit: int
    offset: int


class ProcessRevisionCreate(_Strict):
    revision: str = Field(min_length=1, max_length=64)
    lifecycle_status: str = Field(default="draft", max_length=32)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    change_reason: str = Field(default="", max_length=500)
    configuration: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class ProcessRevisionUpdate(_Strict):
    lifecycle_status: str | None = Field(default=None, max_length=32)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    configuration: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class ProcessRevisionOut(BaseModel):
    id: int
    process_id: int
    revision: str
    lifecycle_status: str = "draft"
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    change_reason: str = ""
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


# --- Operations -----------------------------------------------------------
class OperationCreate(_Strict):
    operation_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    operation_type: OperationType = "value_add"
    sequence: int = Field(default=0, ge=0)
    process_revision_id: int | None = Field(default=None, ge=1)
    work_centre_id: int | None = Field(default=None, ge=1)
    plant_id: int | None = Field(default=None, ge=1)
    setup_minutes: float | None = Field(default=None, ge=0)
    cycle_minutes: float | None = Field(default=None, ge=0)
    lifecycle_status: str = Field(default="draft", max_length=32)
    attributes: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class OperationUpdate(_Strict):
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    operation_type: OperationType | None = None
    sequence: int | None = Field(default=None, ge=0)
    process_revision_id: int | None = Field(default=None, ge=1)
    work_centre_id: int | None = Field(default=None, ge=1)
    plant_id: int | None = Field(default=None, ge=1)
    setup_minutes: float | None = Field(default=None, ge=0)
    cycle_minutes: float | None = Field(default=None, ge=0)
    lifecycle_status: str | None = Field(default=None, max_length=32)
    attributes: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class OperationOut(BaseModel):
    id: int
    process_id: int
    process_revision_id: int | None = None
    operation_key: str
    name: str | None = None
    description: str | None = None
    operation_type: str = "value_add"
    sequence: int = 0
    work_centre_id: int | None = None
    plant_id: int | None = None
    setup_minutes: float | None = None
    cycle_minutes: float | None = None
    lifecycle_status: str = "draft"
    attributes: dict[str, Any] = Field(default_factory=dict)
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


class OperationPage(BaseModel):
    items: list[OperationOut]
    total: int
    limit: int
    offset: int


class OperationDependencyCreate(_Strict):
    operation_id: int = Field(ge=1)
    depends_on_operation_id: int = Field(ge=1)
    dependency_type: OperationDependencyType = "finish_to_start"
    lag_minutes: float | None = Field(default=None, ge=0)


class OperationDependencyOut(BaseModel):
    id: int
    process_id: int
    operation_id: int
    depends_on_operation_id: int
    dependency_type: str = "finish_to_start"
    lag_minutes: float | None = None
    created_at: datetime | None = None


class OperationConsumptionCreate(_Strict):
    child_item_id: int = Field(ge=1)
    bom_line_id: int | None = Field(default=None, ge=1)
    quantity: float = Field(default=1.0, gt=0)
    unit_of_measure: str = Field(default="EA", max_length=32)
    consumption_type: ConsumptionType = "component"
    notes: str | None = Field(default=None, max_length=2000)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)


class OperationConsumptionOut(BaseModel):
    id: int
    operation_id: int
    child_item_id: int
    bom_line_id: int | None = None
    quantity: float = 1.0
    unit_of_measure: str = "EA"
    consumption_type: str = "component"
    notes: str | None = None
    external_id: str | None = None
    source_system: str | None = None
    source_ref: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


# --- Work instructions ----------------------------------------------------
class WorkInstructionCreate(_Strict):
    process_id: int = Field(ge=1)
    operation_id: int | None = Field(default=None, ge=1)
    instruction_key: str = Field(min_length=1, max_length=256)
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    instruction_type: InstructionType = "text"
    revision: str = Field(default="A", min_length=1, max_length=64)
    lifecycle_status: str = Field(default="draft", max_length=32)
    document_ref: str | None = Field(default=None, max_length=512)
    steps: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class WorkInstructionUpdate(_Strict):
    operation_id: int | None = Field(default=None, ge=1)
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    instruction_type: InstructionType | None = None
    lifecycle_status: str | None = Field(default=None, max_length=32)
    document_ref: str | None = Field(default=None, max_length=512)
    steps: list[dict[str, Any]] | None = Field(default=None, max_length=500)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class WorkInstructionOut(BaseModel):
    id: int
    process_id: int
    operation_id: int | None = None
    instruction_key: str
    title: str | None = None
    description: str | None = None
    instruction_type: str = "text"
    revision: str = "A"
    lifecycle_status: str = "draft"
    document_ref: str | None = None
    steps: list[dict[str, Any]] = Field(default_factory=list)
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


class WorkInstructionPage(BaseModel):
    items: list[WorkInstructionOut]
    total: int
    limit: int
    offset: int


# --- Resources ------------------------------------------------------------
class ResourceCreate(_Strict):
    resource_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    resource_kind: ResourceKind = "tooling"
    plant_id: int | None = Field(default=None, ge=1)
    work_centre_id: int | None = Field(default=None, ge=1)
    lifecycle_status: str = Field(default="active", max_length=32)
    calibration_due: datetime | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class ResourceUpdate(_Strict):
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    resource_kind: ResourceKind | None = None
    plant_id: int | None = Field(default=None, ge=1)
    work_centre_id: int | None = Field(default=None, ge=1)
    lifecycle_status: str | None = Field(default=None, max_length=32)
    calibration_due: datetime | None = None
    attributes: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class ResourceOut(BaseModel):
    id: int
    resource_key: str
    name: str | None = None
    description: str | None = None
    resource_kind: str = "tooling"
    plant_id: int | None = None
    work_centre_id: int | None = None
    lifecycle_status: str = "active"
    calibration_due: datetime | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
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


class ResourcePage(BaseModel):
    items: list[ResourceOut]
    total: int
    limit: int
    offset: int


# --- Production versions --------------------------------------------------
class ProductionVersionCreate(_Strict):
    item_id: int = Field(ge=1)
    process_id: int | None = Field(default=None, ge=1)
    mbom_header_id: int | None = Field(default=None, ge=1)
    version_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    lifecycle_status: str = Field(default="draft", max_length=32)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    plant_id: int | None = Field(default=None, ge=1)
    configuration: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class ProductionVersionUpdate(_Strict):
    process_id: int | None = Field(default=None, ge=1)
    mbom_header_id: int | None = Field(default=None, ge=1)
    name: str | None = Field(default=None, max_length=512)
    lifecycle_status: str | None = Field(default=None, max_length=32)
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    plant_id: int | None = Field(default=None, ge=1)
    configuration: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class ProductionVersionOut(BaseModel):
    id: int
    item_id: int
    process_id: int | None = None
    mbom_header_id: int | None = None
    version_key: str
    name: str | None = None
    lifecycle_status: str = "draft"
    effectivity_from: datetime | None = None
    effectivity_to: datetime | None = None
    plant_id: int | None = None
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


# --- Process intelligence -------------------------------------------------
class ProcessOperationRow(BaseModel):
    operation_id: int
    operation_key: str
    name: str | None = None
    operation_type: str = "value_add"
    sequence: int = 0
    work_centre_id: int | None = None
    plant_id: int | None = None
    depth: int = 0
    path: list[int] = Field(default_factory=list)
    instruction_count: int = 0
    consumption_count: int = 0
    depends_on: list[int] = Field(default_factory=list)
    has_instruction: bool = False


class ProcessStructureResponse(BaseModel):
    process: ProcessOut
    operations: list[ProcessOperationRow] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False
    cycle_detected: bool = False


class ProcessCompareRequest(_Strict):
    left_process_id: int = Field(ge=1)
    right_process_id: int = Field(ge=1)


class ProcessDiff(BaseModel):
    change_type: str
    operation_key: str | None = None
    left_operation_id: int | None = None
    right_operation_id: int | None = None
    changes: list[str] = Field(default_factory=list)
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None


class ProcessCompareResponse(BaseModel):
    left_process_id: int
    right_process_id: int
    summary: dict[str, int] = Field(default_factory=dict)
    diffs: list[ProcessDiff] = Field(default_factory=list)
    truncated: bool = False


class ProcessCheck(BaseModel):
    rule: str
    severity: str = "warning"
    operation_id: int | None = None
    message: str
    detail: dict[str, Any] = Field(default_factory=dict)


class ProcessValidationResponse(BaseModel):
    process_id: int
    status: str = "pass"
    score: float = 1.0
    checks: list[ProcessCheck] = Field(default_factory=list)
    summary: dict[str, int] = Field(default_factory=dict)


class ManufacturingAnalyticsRow(BaseModel):
    key: str
    label: str | None = None
    count: int = 0
    detail: dict[str, Any] = Field(default_factory=dict)


class ManufacturingAnalyticsResponse(BaseModel):
    kind: str
    rows: list[ManufacturingAnalyticsRow] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False
    summary: dict[str, Any] = Field(default_factory=dict)


class ManufacturingImpactRequest(_Strict):
    entity_id: int = Field(ge=1)
    max_depth: int = Field(default=3, ge=1, le=6)


class ManufacturingImpactRow(BaseModel):
    entity_id: int | None = None
    entity_type: str | None = None
    stable_key: str | None = None
    name: str | None = None
    impact: str = "affected"
    confidence: float = 1.0
    reason: str = ""
    source_ref: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class ManufacturingImpactResponse(BaseModel):
    entity_id: int
    subject: dict[str, Any] = Field(default_factory=dict)
    affected: list[ManufacturingImpactRow] = Field(default_factory=list)
    paths: list[dict[str, Any]] = Field(default_factory=list)
    inferred: bool = False
    truncated: bool = False


class ManufacturingStats(BaseModel):
    plants: int = 0
    production_lines: int = 0
    work_centres: int = 0
    processes: int = 0
    operations: int = 0
    work_instructions: int = 0
    resources: int = 0
    production_versions: int = 0
    operations_without_instructions: int = 0
    documented_coverage: float = 0.0
    status: str = "ok"
