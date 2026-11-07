"""Predictive Intelligence request/response schemas (Stage 10 / Step 8)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PredictionMethod = Literal["rule_based", "statistical", "ml", "llm_explanation"]
RiskCategory = Literal["unknown", "low", "medium", "high", "critical"]
PredictionStatus = Literal["active", "stale", "superseded", "insufficient_data"]
FeatureDataType = Literal["number", "boolean", "string", "json"]
FeatureLifecycle = Literal["active", "deprecated", "archived"]
DatasetLifecycle = Literal["draft", "ready", "archived"]
DatasetSplit = Literal["train", "eval", "holdout"]
ModelLifecycle = Literal["draft", "active", "deprecated", "retired"]
RecommendationStatus = Literal[
    "new",
    "under_review",
    "accepted",
    "rejected",
    "deferred",
    "completed",
    "cancelled",
]
RecommendationSeverity = Literal["unknown", "low", "medium", "high", "critical"]
FeedbackDecision = Literal["accept", "reject", "defer", "complete", "comment"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- Feature definitions --------------------------------------------------
class FeatureDefinitionCreate(_Strict):
    feature_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    entity_type: str = Field(default="any", max_length=64)
    data_type: FeatureDataType = "number"
    source_system: str | None = Field(default=None, max_length=128)
    extraction_spec: dict[str, Any] = Field(default_factory=dict)
    freshness_ttl_hours: int = Field(default=168, ge=1, le=8760)
    lifecycle_status: FeatureLifecycle = "active"
    attributes: dict[str, Any] = Field(default_factory=dict)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class FeatureDefinitionUpdate(_Strict):
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    entity_type: str | None = Field(default=None, max_length=64)
    data_type: FeatureDataType | None = None
    source_system: str | None = Field(default=None, max_length=128)
    extraction_spec: dict[str, Any] | None = None
    freshness_ttl_hours: int | None = Field(default=None, ge=1, le=8760)
    lifecycle_status: FeatureLifecycle | None = None
    attributes: dict[str, Any] | None = None
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None


class FeatureDefinitionOut(BaseModel):
    id: int
    feature_key: str
    name: str | None = None
    description: str | None = None
    entity_type: str = "any"
    data_type: str = "number"
    source_system: str | None = None
    extraction_spec: dict[str, Any] = Field(default_factory=dict)
    freshness_ttl_hours: int = 168
    lifecycle_status: str = "active"
    attributes: dict[str, Any] = Field(default_factory=dict)
    classification: str = "internal"
    acl: dict[str, Any] = Field(default_factory=dict)
    version: int = 1
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class FeatureDefinitionPage(BaseModel):
    items: list[FeatureDefinitionOut]
    total: int
    limit: int
    offset: int


# --- Feature values -------------------------------------------------------
class FeatureValueCreate(_Strict):
    feature_key: str = Field(min_length=1, max_length=256)
    entity_type: str = Field(min_length=1, max_length=64)
    entity_id: int = Field(ge=1)
    entity_key: str | None = Field(default=None, max_length=256)
    value: Any = None
    observed_at: datetime | None = None
    source_system: str | None = Field(default=None, max_length=128)
    source_ref: str | None = Field(default=None, max_length=512)
    lineage: list[dict[str, Any]] = Field(default_factory=list, max_length=100)


class FeatureValueOut(BaseModel):
    id: int
    feature_key: str
    entity_type: str
    entity_id: int
    entity_key: str | None = None
    value: Any = None
    observed_at: datetime | None = None
    source_system: str | None = None
    source_ref: str | None = None
    lineage: list[dict[str, Any]] = Field(default_factory=list)
    freshness_expires_at: datetime | None = None
    stale: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


class FeatureValuePage(BaseModel):
    items: list[FeatureValueOut]
    total: int
    limit: int
    offset: int


class FeatureStatusResponse(BaseModel):
    feature_key: str
    defined: bool = False
    value_count: int = 0
    stale_count: int = 0
    latest_observed_at: datetime | None = None
    freshness_ttl_hours: int | None = None
    status: str = "unknown"


# --- Datasets -------------------------------------------------------------
class DatasetCreate(_Strict):
    dataset_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    prediction_type: str | None = Field(default=None, max_length=64)
    feature_keys: list[str] = Field(default_factory=list, max_length=200)
    source_window: dict[str, Any] = Field(default_factory=dict)
    lifecycle_status: DatasetLifecycle = "draft"
    attributes: dict[str, Any] = Field(default_factory=dict)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class DatasetUpdate(_Strict):
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    prediction_type: str | None = Field(default=None, max_length=64)
    feature_keys: list[str] | None = Field(default=None, max_length=200)
    source_window: dict[str, Any] | None = None
    lifecycle_status: DatasetLifecycle | None = None
    attributes: dict[str, Any] | None = None
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None


class DatasetOut(BaseModel):
    id: int
    dataset_key: str
    name: str | None = None
    description: str | None = None
    prediction_type: str | None = None
    feature_keys: list[str] = Field(default_factory=list)
    source_window: dict[str, Any] = Field(default_factory=dict)
    lifecycle_status: str = "draft"
    attributes: dict[str, Any] = Field(default_factory=dict)
    classification: str = "internal"
    acl: dict[str, Any] = Field(default_factory=dict)
    version: int = 1
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class DatasetPage(BaseModel):
    items: list[DatasetOut]
    total: int
    limit: int
    offset: int


class DatasetVersionCreate(_Strict):
    version: int = Field(default=1, ge=1)
    split: DatasetSplit = "train"
    row_count: int = Field(default=0, ge=0)
    class_balance: dict[str, Any] = Field(default_factory=dict)
    filters: dict[str, Any] = Field(default_factory=dict)
    lifecycle_status: DatasetLifecycle = "draft"
    checksum: str | None = Field(default=None, max_length=128)


class DatasetVersionOut(BaseModel):
    id: int
    dataset_id: int
    version: int = 1
    split: str = "train"
    row_count: int = 0
    class_balance: dict[str, Any] = Field(default_factory=dict)
    filters: dict[str, Any] = Field(default_factory=dict)
    lifecycle_status: str = "draft"
    checksum: str | None = None
    created_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


# --- Models / strategies --------------------------------------------------
class PredictionModelCreate(_Strict):
    model_key: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    prediction_type: str = Field(min_length=1, max_length=64)
    method: PredictionMethod = "rule_based"
    lifecycle_status: ModelLifecycle = "draft"
    attributes: dict[str, Any] = Field(default_factory=dict)
    classification: str = Field(default="internal", max_length=32)
    acl: dict[str, Any] = Field(default_factory=dict)


class PredictionModelUpdate(_Strict):
    name: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    prediction_type: str | None = Field(default=None, max_length=64)
    method: PredictionMethod | None = None
    lifecycle_status: ModelLifecycle | None = None
    attributes: dict[str, Any] | None = None
    classification: str | None = Field(default=None, max_length=32)
    acl: dict[str, Any] | None = None


class PredictionModelOut(BaseModel):
    id: int
    model_key: str
    name: str | None = None
    description: str | None = None
    prediction_type: str
    method: str = "rule_based"
    lifecycle_status: str = "draft"
    attributes: dict[str, Any] = Field(default_factory=dict)
    classification: str = "internal"
    acl: dict[str, Any] = Field(default_factory=dict)
    version: int = 1
    created_by: str | None = None
    updated_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PredictionModelPage(BaseModel):
    items: list[PredictionModelOut]
    total: int
    limit: int
    offset: int


class ModelVersionCreate(_Strict):
    version: str = Field(min_length=1, max_length=64)
    method: PredictionMethod = "rule_based"
    ruleset_version: str = Field(default="", max_length=128)
    config: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)
    dataset_version_id: int | None = Field(default=None, ge=1)
    lifecycle_status: ModelLifecycle = "draft"
    trained_at: datetime | None = None


class ModelVersionOut(BaseModel):
    id: int
    model_id: int
    version: str
    method: str = "rule_based"
    ruleset_version: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)
    dataset_version_id: int | None = None
    lifecycle_status: str = "draft"
    trained_at: datetime | None = None
    created_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


# --- Predictions ----------------------------------------------------------
class PredictionRequest(_Strict):
    prediction_type: str = Field(min_length=1, max_length=64)
    subject_type: str = Field(min_length=1, max_length=64)
    subject_id: int = Field(ge=1)
    subject_key: str | None = Field(default=None, max_length=256)
    model_key: str | None = Field(default=None, max_length=256)
    observation_window_days: int = Field(default=90, ge=1, le=3650)
    parameters: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, max_length=256)


class PredictionFactor(BaseModel):
    factor: str
    value: Any = None
    contribution: float | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class PredictionEvidence(BaseModel):
    source_type: str | None = None
    source_id: str | int | None = None
    label: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class PredictionOut(BaseModel):
    id: int
    prediction_key: str
    prediction_type: str
    subject_type: str
    subject_id: int | None = None
    subject_key: str | None = None
    risk_category: str = "unknown"
    score: float | None = None
    severity: str = "unknown"
    method: str = "rule_based"
    model_version: str = ""
    ruleset_version: str = ""
    confidence: float | None = None
    uncertainty: dict[str, Any] = Field(default_factory=dict)
    contributing_factors: list[dict[str, Any]] = Field(default_factory=list)
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    explanation: str = ""
    data_freshness: dict[str, Any] = Field(default_factory=dict)
    limitations: list[str] = Field(default_factory=list)
    observation_window: dict[str, Any] = Field(default_factory=dict)
    status: str = "active"
    stale: bool = False
    freshness_expires_at: datetime | None = None
    idempotency_key: str | None = None
    generated_at: datetime | None = None
    classification: str = "internal"
    acl: dict[str, Any] = Field(default_factory=dict)
    graph_entity_id: int | None = None
    version: int = 1
    created_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PredictionPage(BaseModel):
    items: list[PredictionOut]
    total: int
    limit: int
    offset: int


class PredictionExplanationResponse(BaseModel):
    prediction: PredictionOut
    summary: str = ""
    contributing_factors: list[dict[str, Any]] = Field(default_factory=list)
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    data_freshness: dict[str, Any] = Field(default_factory=dict)
    method_label: str = ""


class PredictionAnalyticsRow(BaseModel):
    key: str
    label: str | None = None
    count: int = 0
    risk_category: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)


class PredictionAnalyticsResponse(BaseModel):
    kind: str
    rows: list[PredictionAnalyticsRow] = Field(default_factory=list)
    total: int = 0
    truncated: bool = False
    summary: dict[str, Any] = Field(default_factory=dict)


class ModelPerformanceResponse(BaseModel):
    model_key: str | None = None
    prediction_type: str | None = None
    prediction_count: int = 0
    active_count: int = 0
    stale_count: int = 0
    insufficient_data_count: int = 0
    risk_distribution: dict[str, int] = Field(default_factory=dict)
    latest_generated_at: datetime | None = None
    versions: list[dict[str, Any]] = Field(default_factory=list)
    monitored_metrics: bool = False
    note: str = ""


# --- Recommendations ------------------------------------------------------
class RecommendationFeedbackCreate(_Strict):
    decision: FeedbackDecision = "comment"
    comment: str = Field(default="", max_length=4000)
    outcome: str | None = Field(default=None, max_length=64)
    risk_before: float | None = Field(default=None, ge=0, le=100)
    risk_after: float | None = Field(default=None, ge=0, le=100)


class RecommendationCreate(_Strict):
    prediction_id: int | None = Field(default=None, ge=1)
    title: str = Field(min_length=1, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    rationale: str = Field(default="", max_length=8000)
    category: str | None = Field(default=None, max_length=64)
    severity: RecommendationSeverity = "medium"
    priority: RecommendationSeverity = "medium"
    suggested_action: str | None = Field(default=None, max_length=2000)
    owner_role: str | None = Field(default=None, max_length=256)
    affected_entity_type: str | None = Field(default=None, max_length=64)
    affected_entity_id: int | None = Field(default=None, ge=1)
    affected_entity_key: str | None = Field(default=None, max_length=256)
    evidence: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    due_at: datetime | None = None
    idempotency_key: str | None = Field(default=None, max_length=256)


class RecommendationUpdate(_Strict):
    status: RecommendationStatus | None = None
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None, max_length=8000)
    rationale: str | None = Field(default=None, max_length=8000)
    severity: RecommendationSeverity | None = None
    priority: RecommendationSeverity | None = None
    suggested_action: str | None = Field(default=None, max_length=2000)
    owner_role: str | None = Field(default=None, max_length=256)
    due_at: datetime | None = None
    outcome: str | None = Field(default=None, max_length=64)
    risk_before: float | None = Field(default=None, ge=0, le=100)
    risk_after: float | None = Field(default=None, ge=0, le=100)


class RecommendationGenerateRequest(_Strict):
    prediction_ids: list[int] = Field(default_factory=list, max_length=100)
    prediction_type: str | None = Field(default=None, max_length=64)
    subject_type: str | None = Field(default=None, max_length=64)
    max_recommendations: int = Field(default=10, ge=1, le=100)


class RecommendationFeedbackOut(BaseModel):
    id: int
    recommendation_id: int
    reviewer: str | None = None
    decision: str = "comment"
    comment: str = ""
    outcome: str | None = None
    risk_before: float | None = None
    risk_after: float | None = None
    created_at: datetime | None = None


class RecommendationOut(BaseModel):
    id: int
    recommendation_key: str
    prediction_id: int | None = None
    title: str = ""
    description: str | None = None
    rationale: str = ""
    category: str | None = None
    severity: str = "medium"
    priority: str = "medium"
    status: str = "new"
    suggested_action: str | None = None
    owner_role: str | None = None
    affected_entity_type: str | None = None
    affected_entity_id: int | None = None
    affected_entity_key: str | None = None
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    due_at: datetime | None = None
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    outcome: str | None = None
    risk_before: float | None = None
    risk_after: float | None = None
    risk_reduced: bool | None = None
    idempotency_key: str | None = None
    classification: str = "internal"
    acl: dict[str, Any] = Field(default_factory=dict)
    graph_entity_id: int | None = None
    version: int = 1
    created_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class RecommendationPage(BaseModel):
    items: list[RecommendationOut]
    total: int
    limit: int
    offset: int


# --- Schedules ------------------------------------------------------------
class ScheduleCreate(_Strict):
    schedule_key: str = Field(min_length=1, max_length=256)
    prediction_type: str = Field(min_length=1, max_length=64)
    subject_type: str = Field(min_length=1, max_length=64)
    subject_scope: dict[str, Any] = Field(default_factory=dict)
    interval_seconds: int = Field(default=86400, ge=60, le=31536000)
    enabled: bool = True


class ScheduleUpdate(_Strict):
    prediction_type: str | None = Field(default=None, max_length=64)
    subject_type: str | None = Field(default=None, max_length=64)
    subject_scope: dict[str, Any] | None = None
    interval_seconds: int | None = Field(default=None, ge=60, le=31536000)
    enabled: bool | None = None


class ScheduleOut(BaseModel):
    id: int
    schedule_key: str
    prediction_type: str
    subject_type: str
    subject_scope: dict[str, Any] = Field(default_factory=dict)
    interval_seconds: int = 86400
    enabled: bool = True
    next_run_at: datetime | None = None
    last_run_at: datetime | None = None
    last_prediction_id: int | None = None
    created_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SchedulePage(BaseModel):
    items: list[ScheduleOut]
    total: int
    limit: int
    offset: int


# --- Aggregate ------------------------------------------------------------
class PredictiveStats(BaseModel):
    feature_definitions: int = 0
    feature_values: int = 0
    stale_feature_values: int = 0
    datasets: int = 0
    models: int = 0
    predictions: int = 0
    active_predictions: int = 0
    insufficient_data_predictions: int = 0
    recommendations: int = 0
    open_recommendations: int = 0
    accepted_recommendations: int = 0
    reduced_risk_recommendations: int = 0
    schedules: int = 0
    status: str = "ok"
