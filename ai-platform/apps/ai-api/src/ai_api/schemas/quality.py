"""Quality Intelligence request/response schemas (Stage 9 / Step 7)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

IssueType = Literal["nonconformance", "deviation", "complaint", "defect", "observation"]
IssueSeverity = Literal["low", "medium", "high", "critical"]
IssueStatus = Literal[
    "open", "investigating", "contained", "resolved", "closed", "cancelled"
]
IssueDisposition = Literal[
    "none", "use_as_is", "rework", "repair", "scrap", "return_to_supplier", "sort"
]
RootCauseStatus = Literal["not_investigated", "hypothesis", "confirmed"]
RootCauseClassification = Literal[
    "design",
    "material",
    "process",
    "machine",
    "human",
    "measurement",
    "environment",
    "supplier",
    "other",
]
InspectionType = Literal["incoming", "in_process", "final", "audit", "supplier", "periodic"]
InspectionStatus = Literal[
    "planned", "in_progress", "passed", "failed", "waived", "cancelled"
]
ResultStatus = Literal["pass", "fail", "unknown", "waived"]
ActionType = Literal["corrective", "preventive", "containment"]
ActionStatus = Literal[
    "open", "in_progress", "implemented", "verified", "closed", "cancelled"
]
ActionEffectiveness = Literal["pending", "effective", "not_effective"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- Quality issues -------------------------------------------------------
class QualityIssueCreate(_Strict):
    issue_key: str = Field(min_length=1, max_length=256)
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    issue_type: IssueType = "nonconformance"
    severity: IssueSeverity = "medium"
    status: IssueStatus = "open"
    disposition: IssueDisposition = "none"
    product_item_id: int | None = Field(default=None, ge=1)
    component_item_id: int | None = Field(default=None, ge=1)
    process_id: int | None = Field(default=None, ge=1)
    operation_id: int | None = Field(default=None, ge=1)
    plant_id: int | None = Field(default=None, ge=1)
    work_centre_id: int | None = Field(default=None, ge=1)
    supplier_ref: str | None = Field(default=None, max_length=256)
    failure_code: str | None = Field(default=None, max_length=128)
    detected_at: datetime | None = None
    detected_by: str | None = Field(default=None, max_length=256)
    attributes: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class QualityIssueUpdate(_Strict):
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    issue_type: IssueType | None = None
    severity: IssueSeverity | None = None
    status: IssueStatus | None = None
    disposition: IssueDisposition | None = None
    product_item_id: int | None = Field(default=None, ge=1)
    component_item_id: int | None = Field(default=None, ge=1)
    process_id: int | None = Field(default=None, ge=1)
    operation_id: int | None = Field(default=None, ge=1)
    plant_id: int | None = Field(default=None, ge=1)
    work_centre_id: int | None = Field(default=None, ge=1)
    supplier_ref: str | None = Field(default=None, max_length=256)
    failure_code: str | None = Field(default=None, max_length=128)
    detected_at: datetime | None = None
    detected_by: str | None = Field(default=None, max_length=256)
    attributes: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class QualityIssueOut(BaseModel):
    id: int
    issue_key: str
    title: str | None = None
    description: str | None = None
    issue_type: str = "nonconformance"
    severity: str = "medium"
    status: str = "open"
    disposition: str = "none"
    product_item_id: int | None = None
    component_item_id: int | None = None
    process_id: int | None = None
    operation_id: int | None = None
    plant_id: int | None = None
    work_centre_id: int | None = None
    supplier_ref: str | None = None
    failure_code: str | None = None
    detected_at: datetime | None = None
    detected_by: str | None = None
    root_cause_status: str = "not_investigated"
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


class QualityIssuePage(BaseModel):
    items: list[QualityIssueOut]
    total: int
    limit: int
    offset: int


# --- Inspections ----------------------------------------------------------
class InspectionCreate(_Strict):
    inspection_key: str = Field(min_length=1, max_length=256)
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    inspection_type: InspectionType = "incoming"
    status: InspectionStatus = "planned"
    product_item_id: int | None = Field(default=None, ge=1)
    component_item_id: int | None = Field(default=None, ge=1)
    operation_id: int | None = Field(default=None, ge=1)
    plant_id: int | None = Field(default=None, ge=1)
    work_centre_id: int | None = Field(default=None, ge=1)
    quality_issue_id: int | None = Field(default=None, ge=1)
    characteristic: str | None = Field(default=None, max_length=512)
    sample_size: int | None = Field(default=None, ge=0)
    passed_count: int | None = Field(default=None, ge=0)
    failed_count: int | None = Field(default=None, ge=0)
    performed_by: str | None = Field(default=None, max_length=256)
    performed_at: datetime | None = None
    result: dict[str, Any] = Field(default_factory=dict)
    attributes: dict[str, Any] = Field(default_factory=dict)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class InspectionUpdate(_Strict):
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    status: InspectionStatus | None = None
    operation_id: int | None = Field(default=None, ge=1)
    plant_id: int | None = Field(default=None, ge=1)
    work_centre_id: int | None = Field(default=None, ge=1)
    quality_issue_id: int | None = Field(default=None, ge=1)
    characteristic: str | None = Field(default=None, max_length=512)
    sample_size: int | None = Field(default=None, ge=0)
    passed_count: int | None = Field(default=None, ge=0)
    failed_count: int | None = Field(default=None, ge=0)
    performed_by: str | None = Field(default=None, max_length=256)
    performed_at: datetime | None = None
    result: dict[str, Any] | None = None
    attributes: dict[str, Any] | None = None
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class InspectionOut(BaseModel):
    id: int
    inspection_key: str
    title: str | None = None
    description: str | None = None
    inspection_type: str = "incoming"
    status: str = "planned"
    product_item_id: int | None = None
    component_item_id: int | None = None
    operation_id: int | None = None
    plant_id: int | None = None
    work_centre_id: int | None = None
    quality_issue_id: int | None = None
    characteristic: str | None = None
    sample_size: int | None = None
    passed_count: int | None = None
    failed_count: int | None = None
    performed_by: str | None = None
    performed_at: datetime | None = None
    result: dict[str, Any] = Field(default_factory=dict)
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


class InspectionPage(BaseModel):
    items: list[InspectionOut]
    total: int
    limit: int
    offset: int


class InspectionResultCreate(_Strict):
    characteristic: str = Field(min_length=1, max_length=512)
    measured_value: str | None = Field(default=None, max_length=512)
    result: ResultStatus = "unknown"
    defect_code: str | None = Field(default=None, max_length=128)
    defect_category: str | None = Field(default=None, max_length=128)
    notes: str | None = Field(default=None, max_length=4000)


class InspectionResultOut(BaseModel):
    id: int
    inspection_id: int
    characteristic: str
    measured_value: str | None = None
    result: str = "unknown"
    defect_code: str | None = None
    defect_category: str | None = None
    notes: str | None = None
    created_by: str | None = None
    created_at: datetime | None = None


# --- Root causes ----------------------------------------------------------
class RootCauseCreate(_Strict):
    classification: RootCauseClassification = "other"
    description: str = Field(default="", max_length=8000)
    is_hypothesis: bool = True
    confidence: float | None = Field(default=None, ge=0, le=1)
    evidence: list[dict[str, Any]] = Field(default_factory=list, max_length=200)


class RootCauseUpdate(_Strict):
    classification: RootCauseClassification | None = None
    description: str | None = Field(default=None, max_length=8000)
    is_hypothesis: bool | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    evidence: list[dict[str, Any]] | None = Field(default=None, max_length=200)
    confirm: bool = False


class RootCauseOut(BaseModel):
    id: int
    quality_issue_id: int
    classification: str = "other"
    description: str = ""
    is_hypothesis: bool = True
    confirmed: bool = False
    confidence: float | None = None
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


# --- Corrective / preventive actions -------------------------------------
class QualityActionCreate(_Strict):
    quality_issue_id: int = Field(ge=1)
    action_key: str = Field(min_length=1, max_length=256)
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    action_type: ActionType = "corrective"
    status: ActionStatus = "open"
    root_cause_id: int | None = Field(default=None, ge=1)
    owner_user: str | None = Field(default=None, max_length=256)
    due_at: datetime | None = None
    effectiveness: ActionEffectiveness = "pending"
    evidence: list[dict[str, Any]] = Field(default_factory=list, max_length=200)
    external_id: str | None = Field(default=None, max_length=256)
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class QualityActionUpdate(_Strict):
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    action_type: ActionType | None = None
    status: ActionStatus | None = None
    root_cause_id: int | None = Field(default=None, ge=1)
    owner_user: str | None = Field(default=None, max_length=256)
    due_at: datetime | None = None
    effectiveness: ActionEffectiveness | None = None
    evidence: list[dict[str, Any]] | None = Field(default=None, max_length=200)
    source_ref: str | None = Field(default=None, max_length=512)
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None
    change_reason: str | None = Field(default=None, max_length=500)


class QualityActionOut(BaseModel):
    id: int
    quality_issue_id: int
    action_key: str
    title: str | None = None
    description: str | None = None
    action_type: str = "corrective"
    status: str = "open"
    root_cause_id: int | None = None
    owner_user: str | None = None
    due_at: datetime | None = None
    implemented_at: datetime | None = None
    verified_at: datetime | None = None
    verified_by: str | None = None
    effectiveness: str = "pending"
    evidence: list[dict[str, Any]] = Field(default_factory=list)
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


class QualityActionPage(BaseModel):
    items: list[QualityActionOut]
    total: int
    limit: int
    offset: int


# --- Analytics / intelligence --------------------------------------------
class QualityAnalyticsRow(BaseModel):
    key: str
    label: str | None = None
    count: int = 0
    severity: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class QualityAnalyticsResponse(BaseModel):
    kind: str
    rows: list[QualityAnalyticsRow] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False
    summary: dict[str, Any] = Field(default_factory=dict)
    unavailable: list[str] = Field(default_factory=list)


class RepeatIssueGroup(BaseModel):
    signature: str
    occurrences: int = 0
    issue_ids: list[int] = Field(default_factory=list)
    issue_keys: list[str] = Field(default_factory=list)
    component_item_id: int | None = None
    failure_code: str | None = None
    reason: str = ""


class RepeatIssueResponse(BaseModel):
    groups: list[RepeatIssueGroup] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False
    window_days: int = 90


class QualityImpactRequest(_Strict):
    entity_id: int = Field(ge=1)
    max_depth: int = Field(default=3, ge=1, le=6)


class QualityImpactRow(BaseModel):
    entity_id: int | None = None
    entity_type: str | None = None
    stable_key: str | None = None
    name: str | None = None
    impact: str = "affected"
    confidence: float = 1.0
    reason: str = ""
    source_ref: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class QualityImpactResponse(BaseModel):
    entity_id: int
    subject: dict[str, Any] = Field(default_factory=dict)
    affected: list[QualityImpactRow] = Field(default_factory=list)
    paths: list[dict[str, Any]] = Field(default_factory=list)
    inferred: bool = False
    truncated: bool = False


class SupplierQualityRow(BaseModel):
    supplier_ref: str
    supplier_name: str | None = None
    issue_count: int = 0
    defect_count: int = 0
    affected_components: int = 0
    open_issues: int = 0
    detail: dict[str, Any] = Field(default_factory=dict)


class SupplierQualityResponse(BaseModel):
    rows: list[SupplierQualityRow] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False


class SupplierIssueCreate(_Strict):
    supplier_ref: str = Field(min_length=1, max_length=256)
    supplier_name: str | None = Field(default=None, max_length=512)
    component_item_id: int | None = Field(default=None, ge=1)
    defect_category: str | None = Field(default=None, max_length=128)
    quantity_affected: int | None = Field(default=None, ge=0)
    containment_ref: str | None = Field(default=None, max_length=256)


class SupplierIssueOut(BaseModel):
    id: int
    quality_issue_id: int
    supplier_ref: str
    supplier_name: str | None = None
    component_item_id: int | None = None
    defect_category: str | None = None
    quantity_affected: int | None = None
    containment_ref: str | None = None
    created_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class QualityTraceabilityResponse(BaseModel):
    issue: dict[str, Any] = Field(default_factory=dict)
    product: dict[str, Any] | None = None
    component: dict[str, Any] | None = None
    process: dict[str, Any] | None = None
    operation: dict[str, Any] | None = None
    plant: dict[str, Any] | None = None
    work_centre: dict[str, Any] | None = None
    work_instructions: list[dict[str, Any]] = Field(default_factory=list)
    root_causes: list[dict[str, Any]] = Field(default_factory=list)
    actions: list[dict[str, Any]] = Field(default_factory=list)
    inspections: list[dict[str, Any]] = Field(default_factory=list)
    status: str = "ok"


class QualityStats(BaseModel):
    issues: int = 0
    open_issues: int = 0
    critical_issues: int = 0
    inspections: int = 0
    failed_inspections: int = 0
    actions: int = 0
    overdue_actions: int = 0
    effective_actions: int = 0
    supplier_issues: int = 0
    status: str = "ok"
