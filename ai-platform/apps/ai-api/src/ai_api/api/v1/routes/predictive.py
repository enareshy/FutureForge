"""Predictive Intelligence API (Stage 10 / Step 8).

Routes only adapt HTTP to the predictive service; authorization, lifecycle
validation, idempotency, provenance handling and the never-present-a-prediction
-as-fact rules live in the service.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    PaginationDep,
    PredictiveServiceDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.predictive import (
    DatasetCreate,
    DatasetOut,
    DatasetPage,
    DatasetUpdate,
    DatasetVersionCreate,
    DatasetVersionOut,
    FeatureDefinitionCreate,
    FeatureDefinitionOut,
    FeatureDefinitionPage,
    FeatureDefinitionUpdate,
    FeatureStatusResponse,
    FeatureValueCreate,
    FeatureValueOut,
    FeatureValuePage,
    ModelPerformanceResponse,
    ModelVersionCreate,
    ModelVersionOut,
    PredictionAnalyticsResponse,
    PredictionExplanationResponse,
    PredictionModelCreate,
    PredictionModelOut,
    PredictionModelPage,
    PredictionModelUpdate,
    PredictionOut,
    PredictionPage,
    PredictionRequest,
    PredictiveStats,
    RecommendationCreate,
    RecommendationFeedbackCreate,
    RecommendationFeedbackOut,
    RecommendationGenerateRequest,
    RecommendationOut,
    RecommendationPage,
    RecommendationUpdate,
    ScheduleCreate,
    ScheduleOut,
    SchedulePage,
    ScheduleUpdate,
)
from ai_api.security.permissions import (
    CAP_PREDICTIVE_ANALYZE,
    CAP_PREDICTIVE_READ,
    CAP_PREDICTIVE_WRITE,
)

router = APIRouter(tags=["predictive"], dependencies=[Depends(enforce_rate_limit)])

PREFIX = "/predictive-intelligence"


# --- Statistics -----------------------------------------------------------
@router.get(
    f"{PREFIX}/stats",
    response_model=PredictiveStats,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def predictive_stats(
    principal: PrincipalDep, service: PredictiveServiceDep
) -> PredictiveStats:
    return PredictiveStats(**await service.stats(principal))


# --- Feature definitions --------------------------------------------------
@router.get(
    f"{PREFIX}/features",
    response_model=FeatureDefinitionPage,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def list_feature_definitions(
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    pagination: PaginationDep,
    entity_type: str | None = Query(default=None, max_length=64),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> FeatureDefinitionPage:
    items, total = await service.list_feature_definitions(
        principal,
        entity_type=entity_type,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return FeatureDefinitionPage(
        items=[FeatureDefinitionOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    f"{PREFIX}/features",
    response_model=FeatureDefinitionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def upsert_feature_definition(
    payload: FeatureDefinitionCreate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> FeatureDefinitionOut:
    return FeatureDefinitionOut(
        **await service.upsert_feature_definition(principal, payload)
    )


@router.get(
    f"{PREFIX}/features/{{feature_id}}",
    response_model=FeatureDefinitionOut,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def get_feature_definition(
    feature_id: int, principal: PrincipalDep, service: PredictiveServiceDep
) -> FeatureDefinitionOut:
    return FeatureDefinitionOut(
        **await service.get_feature_definition(principal, feature_id)
    )


@router.patch(
    f"{PREFIX}/features/{{feature_id}}",
    response_model=FeatureDefinitionOut,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def update_feature_definition(
    feature_id: int,
    payload: FeatureDefinitionUpdate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> FeatureDefinitionOut:
    return FeatureDefinitionOut(
        **await service.update_feature_definition(principal, feature_id, payload)
    )


# --- Feature values -------------------------------------------------------
@router.get(
    f"{PREFIX}/feature-values",
    response_model=FeatureValuePage,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def list_feature_values(
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    pagination: PaginationDep,
    feature_key: str | None = Query(default=None, max_length=256),
    entity_type: str | None = Query(default=None, max_length=64),
    entity_id: int | None = Query(default=None, ge=1),
) -> FeatureValuePage:
    items, total = await service.list_feature_values(
        principal,
        feature_key=feature_key,
        entity_type=entity_type,
        entity_id=entity_id,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return FeatureValuePage(
        items=[FeatureValueOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    f"{PREFIX}/feature-values",
    response_model=FeatureValueOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def record_feature_value(
    payload: FeatureValueCreate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> FeatureValueOut:
    return FeatureValueOut(**await service.record_feature_value(principal, payload))


@router.get(
    f"{PREFIX}/features/{{feature_key}}/status",
    response_model=FeatureStatusResponse,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def feature_status(
    feature_key: str, principal: PrincipalDep, service: PredictiveServiceDep
) -> FeatureStatusResponse:
    return FeatureStatusResponse(
        **await service.feature_status(principal, feature_key)
    )


# --- Datasets -------------------------------------------------------------
@router.get(
    f"{PREFIX}/datasets",
    response_model=DatasetPage,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def list_datasets(
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    pagination: PaginationDep,
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> DatasetPage:
    items, total = await service.list_datasets(
        principal,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return DatasetPage(
        items=[DatasetOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    f"{PREFIX}/datasets",
    response_model=DatasetOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def upsert_dataset(
    payload: DatasetCreate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> DatasetOut:
    return DatasetOut(**await service.upsert_dataset(principal, payload))


@router.get(
    f"{PREFIX}/datasets/{{dataset_id}}",
    response_model=DatasetOut,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def get_dataset(
    dataset_id: int, principal: PrincipalDep, service: PredictiveServiceDep
) -> DatasetOut:
    return DatasetOut(**await service.get_dataset(principal, dataset_id))


@router.patch(
    f"{PREFIX}/datasets/{{dataset_id}}",
    response_model=DatasetOut,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def update_dataset(
    dataset_id: int,
    payload: DatasetUpdate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> DatasetOut:
    return DatasetOut(**await service.update_dataset(principal, dataset_id, payload))


@router.get(
    f"{PREFIX}/datasets/{{dataset_id}}/versions",
    response_model=list[DatasetVersionOut],
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def list_dataset_versions(
    dataset_id: int,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    limit: int = Query(default=100, ge=1, le=500),
) -> list[DatasetVersionOut]:
    rows = await service.list_dataset_versions(principal, dataset_id, limit=limit)
    return [DatasetVersionOut(**row) for row in rows]


@router.post(
    f"{PREFIX}/datasets/{{dataset_id}}/versions",
    response_model=DatasetVersionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def add_dataset_version(
    dataset_id: int,
    payload: DatasetVersionCreate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> DatasetVersionOut:
    return DatasetVersionOut(
        **await service.add_dataset_version(principal, dataset_id, payload)
    )


# --- Models ---------------------------------------------------------------
@router.get(
    f"{PREFIX}/models",
    response_model=PredictionModelPage,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def list_models(
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    pagination: PaginationDep,
    prediction_type: str | None = Query(default=None, max_length=64),
    lifecycle_status: str | None = Query(default=None, max_length=32),
) -> PredictionModelPage:
    items, total = await service.list_models(
        principal,
        prediction_type=prediction_type,
        lifecycle_status=lifecycle_status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return PredictionModelPage(
        items=[PredictionModelOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    f"{PREFIX}/models",
    response_model=PredictionModelOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def upsert_model(
    payload: PredictionModelCreate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> PredictionModelOut:
    return PredictionModelOut(**await service.upsert_model(principal, payload))


@router.get(
    f"{PREFIX}/models/performance",
    response_model=ModelPerformanceResponse,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_ANALYZE))],
)
async def model_performance(
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    model_key: str | None = Query(default=None, max_length=256),
    prediction_type: str | None = Query(default=None, max_length=64),
) -> ModelPerformanceResponse:
    return ModelPerformanceResponse(
        **await service.model_performance(
            principal, model_key=model_key, prediction_type=prediction_type
        )
    )


@router.get(
    f"{PREFIX}/models/{{model_id}}",
    response_model=PredictionModelOut,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def get_model(
    model_id: int, principal: PrincipalDep, service: PredictiveServiceDep
) -> PredictionModelOut:
    return PredictionModelOut(**await service.get_model(principal, model_id))


@router.patch(
    f"{PREFIX}/models/{{model_id}}",
    response_model=PredictionModelOut,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def update_model(
    model_id: int,
    payload: PredictionModelUpdate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> PredictionModelOut:
    return PredictionModelOut(**await service.update_model(principal, model_id, payload))


@router.get(
    f"{PREFIX}/models/{{model_id}}/versions",
    response_model=list[ModelVersionOut],
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def list_model_versions(
    model_id: int,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    limit: int = Query(default=100, ge=1, le=500),
) -> list[ModelVersionOut]:
    rows = await service.list_model_versions(principal, model_id, limit=limit)
    return [ModelVersionOut(**row) for row in rows]


@router.post(
    f"{PREFIX}/models/{{model_id}}/versions",
    response_model=ModelVersionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def add_model_version(
    model_id: int,
    payload: ModelVersionCreate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> ModelVersionOut:
    return ModelVersionOut(
        **await service.add_model_version(principal, model_id, payload)
    )


# --- Predictions ----------------------------------------------------------
@router.get(
    f"{PREFIX}/predictions",
    response_model=PredictionPage,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def list_predictions(
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    pagination: PaginationDep,
    prediction_type: str | None = Query(default=None, max_length=64),
    subject_type: str | None = Query(default=None, max_length=64),
    subject_id: int | None = Query(default=None, ge=1),
    risk_category: str | None = Query(default=None, max_length=32),
    status: str | None = Query(default=None, max_length=32),
) -> PredictionPage:
    items, total = await service.list_predictions(
        principal,
        prediction_type=prediction_type,
        subject_type=subject_type,
        subject_id=subject_id,
        risk_category=risk_category,
        status=status,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return PredictionPage(
        items=[PredictionOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    f"{PREFIX}/predictions",
    response_model=PredictionOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def run_prediction(
    payload: PredictionRequest,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> PredictionOut:
    return PredictionOut(**await service.predict(principal, payload))


@router.get(
    f"{PREFIX}/predictions/{{prediction_id}}",
    response_model=PredictionOut,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def get_prediction(
    prediction_id: int, principal: PrincipalDep, service: PredictiveServiceDep
) -> PredictionOut:
    return PredictionOut(**await service.get_prediction(principal, prediction_id))


@router.get(
    f"{PREFIX}/predictions/{{prediction_id}}/explanation",
    response_model=PredictionExplanationResponse,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_ANALYZE))],
)
async def explain_prediction(
    prediction_id: int, principal: PrincipalDep, service: PredictiveServiceDep
) -> PredictionExplanationResponse:
    return PredictionExplanationResponse(
        **await service.explain_prediction(principal, prediction_id)
    )


@router.get(
    f"{PREFIX}/analytics/{{kind}}",
    response_model=PredictionAnalyticsResponse,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_ANALYZE))],
)
async def prediction_analytics(
    kind: str, principal: PrincipalDep, service: PredictiveServiceDep
) -> PredictionAnalyticsResponse:
    return PredictionAnalyticsResponse(
        **await service.prediction_analytics(principal, kind)
    )


@router.post(
    f"{PREFIX}/predictions/mark-stale",
    response_model=dict,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def mark_stale(
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    limit: int = Query(default=200, ge=1, le=2000),
) -> dict:
    marked = await service.mark_stale(principal, limit=limit)
    return {"marked": marked}


# --- Recommendations ------------------------------------------------------
@router.get(
    f"{PREFIX}/recommendations",
    response_model=RecommendationPage,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def list_recommendations(
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    pagination: PaginationDep,
    status: str | None = Query(default=None, max_length=32),
    severity: str | None = Query(default=None, max_length=32),
    priority: str | None = Query(default=None, max_length=32),
    prediction_id: int | None = Query(default=None, ge=1),
    owner_role: str | None = Query(default=None, max_length=256),
    overdue_only: bool = Query(default=False),
) -> RecommendationPage:
    items, total = await service.list_recommendations(
        principal,
        status=status,
        severity=severity,
        priority=priority,
        prediction_id=prediction_id,
        owner_role=owner_role,
        overdue_only=overdue_only,
        limit=pagination.limit,
        offset=pagination.offset,
    )
    return RecommendationPage(
        items=[RecommendationOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    f"{PREFIX}/recommendations",
    response_model=RecommendationOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def create_recommendation(
    payload: RecommendationCreate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> RecommendationOut:
    return RecommendationOut(
        **await service.create_recommendation(principal, payload)
    )


@router.post(
    f"{PREFIX}/recommendations/generate",
    response_model=list[RecommendationOut],
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def generate_recommendations(
    payload: RecommendationGenerateRequest,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> list[RecommendationOut]:
    rows = await service.generate_recommendations(principal, payload)
    return [RecommendationOut(**row) for row in rows]


@router.get(
    f"{PREFIX}/recommendations/{{recommendation_id}}",
    response_model=RecommendationOut,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def get_recommendation(
    recommendation_id: int, principal: PrincipalDep, service: PredictiveServiceDep
) -> RecommendationOut:
    return RecommendationOut(
        **await service.get_recommendation(principal, recommendation_id)
    )


@router.patch(
    f"{PREFIX}/recommendations/{{recommendation_id}}",
    response_model=RecommendationOut,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def update_recommendation(
    recommendation_id: int,
    payload: RecommendationUpdate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> RecommendationOut:
    return RecommendationOut(
        **await service.update_recommendation(
            principal, recommendation_id, payload
        )
    )


@router.get(
    f"{PREFIX}/recommendations/{{recommendation_id}}/feedback",
    response_model=list[RecommendationFeedbackOut],
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def list_recommendation_feedback(
    recommendation_id: int,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    limit: int = Query(default=100, ge=1, le=500),
) -> list[RecommendationFeedbackOut]:
    rows = await service.list_recommendation_feedback(
        principal, recommendation_id, limit=limit
    )
    return [RecommendationFeedbackOut(**row) for row in rows]


@router.post(
    f"{PREFIX}/recommendations/{{recommendation_id}}/feedback",
    response_model=RecommendationFeedbackOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def add_recommendation_feedback(
    recommendation_id: int,
    payload: RecommendationFeedbackCreate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> RecommendationFeedbackOut:
    return RecommendationFeedbackOut(
        **await service.add_recommendation_feedback(
            principal, recommendation_id, payload
        )
    )


# --- Schedules ------------------------------------------------------------
@router.get(
    f"{PREFIX}/schedules",
    response_model=SchedulePage,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_READ))],
)
async def list_schedules(
    principal: PrincipalDep,
    service: PredictiveServiceDep,
    pagination: PaginationDep,
    enabled: bool | None = Query(default=None),
) -> SchedulePage:
    items, total = await service.list_schedules(
        principal, enabled=enabled, limit=pagination.limit, offset=pagination.offset
    )
    return SchedulePage(
        items=[ScheduleOut(**item) for item in items],
        total=total,
        limit=pagination.limit,
        offset=pagination.offset,
    )


@router.post(
    f"{PREFIX}/schedules",
    response_model=ScheduleOut,
    status_code=201,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def upsert_schedule(
    payload: ScheduleCreate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> ScheduleOut:
    return ScheduleOut(**await service.upsert_schedule(principal, payload))


@router.patch(
    f"{PREFIX}/schedules/{{schedule_id}}",
    response_model=ScheduleOut,
    dependencies=[Depends(require_capability(CAP_PREDICTIVE_WRITE))],
)
async def update_schedule(
    schedule_id: int,
    payload: ScheduleUpdate,
    principal: PrincipalDep,
    service: PredictiveServiceDep,
) -> ScheduleOut:
    fields = payload.model_dump(exclude_unset=True)
    return ScheduleOut(
        **await service.update_schedule(principal, schedule_id, fields)
    )
