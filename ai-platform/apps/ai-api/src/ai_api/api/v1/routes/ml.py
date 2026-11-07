from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    MlServiceDep,
    Pagination,
    PaginationDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.common import Page, PageMeta
from ai_api.schemas.ml import (
    EvaluationCreate,
    EvaluationOut,
    EvaluationResultCreate,
    EvaluationResultOut,
    ExperimentCreate,
    ExperimentOut,
    MlStatusOut,
    ModelCreate,
    ModelOut,
    ModelVersionCreate,
    ModelVersionOut,
    ModelVersionStatusUpdate,
    RunCreate,
    RunFinish,
    RunOut,
)
from ai_api.security.permissions import (
    CAP_EVALUATIONS_READ,
    CAP_EVALUATIONS_WRITE,
    CAP_EXPERIMENTS_READ,
    CAP_EXPERIMENTS_WRITE,
    CAP_REGISTRY_READ,
    CAP_REGISTRY_WRITE,
)

router = APIRouter(tags=["ml"], dependencies=[Depends(enforce_rate_limit)])


def _page(items: list[Any], total: int, pagination: Pagination) -> Any:
    return Page(
        items=items,
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )


@router.get(
    "/ml/status",
    response_model=MlStatusOut,
    dependencies=[Depends(require_capability(CAP_EXPERIMENTS_READ))],
)
async def ml_status(principal: PrincipalDep, service: MlServiceDep) -> MlStatusOut:
    return MlStatusOut(**(await service.status()))


# --- Experiments --------------------------------------------------------
@router.post(
    "/ml/experiments",
    response_model=ExperimentOut,
    dependencies=[Depends(require_capability(CAP_EXPERIMENTS_WRITE))],
)
async def create_experiment(
    payload: ExperimentCreate, principal: PrincipalDep, service: MlServiceDep
) -> ExperimentOut:
    return ExperimentOut(**await service.create_experiment(principal, payload))


@router.get(
    "/ml/experiments",
    response_model=Page[ExperimentOut],
    dependencies=[Depends(require_capability(CAP_EXPERIMENTS_READ))],
)
async def list_experiments(
    principal: PrincipalDep, service: MlServiceDep, pagination: PaginationDep
) -> Page[ExperimentOut]:
    items, total = await service.list_experiments(
        principal, limit=pagination.limit, offset=pagination.offset
    )
    return _page([ExperimentOut(**item) for item in items], total, pagination)


@router.get(
    "/ml/experiments/{experiment_id}",
    response_model=ExperimentOut,
    dependencies=[Depends(require_capability(CAP_EXPERIMENTS_READ))],
)
async def get_experiment(
    experiment_id: int, principal: PrincipalDep, service: MlServiceDep
) -> ExperimentOut:
    return ExperimentOut(**await service.get_experiment(principal, experiment_id))


@router.post(
    "/ml/experiments/{experiment_id}/runs",
    response_model=RunOut,
    dependencies=[Depends(require_capability(CAP_EXPERIMENTS_WRITE))],
)
async def create_run(
    experiment_id: int, payload: RunCreate, principal: PrincipalDep, service: MlServiceDep
) -> RunOut:
    return RunOut(**await service.create_run(principal, experiment_id, payload))


# --- Runs ---------------------------------------------------------------
@router.get(
    "/ml/runs",
    response_model=Page[RunOut],
    dependencies=[Depends(require_capability(CAP_EXPERIMENTS_READ))],
)
async def list_runs(
    principal: PrincipalDep,
    service: MlServiceDep,
    pagination: PaginationDep,
    experiment_id: int | None = Query(default=None),
) -> Page[RunOut]:
    items, total = await service.list_runs(
        principal, experiment_id=experiment_id, limit=pagination.limit, offset=pagination.offset
    )
    return _page([RunOut(**item) for item in items], total, pagination)


@router.get(
    "/ml/runs/{run_id}",
    response_model=RunOut,
    dependencies=[Depends(require_capability(CAP_EXPERIMENTS_READ))],
)
async def get_run(run_id: int, principal: PrincipalDep, service: MlServiceDep) -> RunOut:
    return RunOut(**await service.get_run(principal, run_id))


@router.post(
    "/ml/runs/{run_id}/finish",
    response_model=RunOut,
    dependencies=[Depends(require_capability(CAP_EXPERIMENTS_WRITE))],
)
async def finish_run(
    run_id: int, payload: RunFinish, principal: PrincipalDep, service: MlServiceDep
) -> RunOut:
    return RunOut(**await service.finish_run(principal, run_id, payload))


# --- Model registry -----------------------------------------------------
@router.post(
    "/ml/models",
    response_model=ModelOut,
    dependencies=[Depends(require_capability(CAP_REGISTRY_WRITE))],
)
async def register_model(
    payload: ModelCreate, principal: PrincipalDep, service: MlServiceDep
) -> ModelOut:
    return ModelOut(**await service.register_model(principal, payload))


@router.get(
    "/ml/models",
    response_model=Page[ModelOut],
    dependencies=[Depends(require_capability(CAP_REGISTRY_READ))],
)
async def list_models(
    principal: PrincipalDep, service: MlServiceDep, pagination: PaginationDep
) -> Page[ModelOut]:
    items, total = await service.list_models(
        principal, limit=pagination.limit, offset=pagination.offset
    )
    return _page([ModelOut(**item) for item in items], total, pagination)


@router.get(
    "/ml/models/{model_id}",
    response_model=ModelOut,
    dependencies=[Depends(require_capability(CAP_REGISTRY_READ))],
)
async def get_model(
    model_id: int, principal: PrincipalDep, service: MlServiceDep
) -> ModelOut:
    return ModelOut(**await service.get_model(principal, model_id))


@router.get(
    "/ml/models/{model_id}/versions",
    response_model=list[ModelVersionOut],
    dependencies=[Depends(require_capability(CAP_REGISTRY_READ))],
)
async def list_model_versions(
    model_id: int, principal: PrincipalDep, service: MlServiceDep
) -> list[ModelVersionOut]:
    return [
        ModelVersionOut(**item)
        for item in await service.list_model_versions(principal, model_id)
    ]


@router.post(
    "/ml/models/{model_id}/versions",
    response_model=ModelVersionOut,
    dependencies=[Depends(require_capability(CAP_REGISTRY_WRITE))],
)
async def create_model_version(
    model_id: int,
    payload: ModelVersionCreate,
    principal: PrincipalDep,
    service: MlServiceDep,
) -> ModelVersionOut:
    return ModelVersionOut(**await service.create_model_version(principal, model_id, payload))


@router.post(
    "/ml/models/{model_id}/versions/{version}/status",
    response_model=ModelVersionOut,
    dependencies=[Depends(require_capability(CAP_REGISTRY_WRITE))],
)
async def set_model_version_status(
    model_id: int,
    version: int,
    payload: ModelVersionStatusUpdate,
    principal: PrincipalDep,
    service: MlServiceDep,
) -> ModelVersionOut:
    return ModelVersionOut(
        **await service.set_model_version_status(principal, model_id, version, payload.status)
    )


# --- Evaluations --------------------------------------------------------
@router.post(
    "/ml/evaluations",
    response_model=EvaluationOut,
    dependencies=[Depends(require_capability(CAP_EVALUATIONS_WRITE))],
)
async def create_evaluation(
    payload: EvaluationCreate, principal: PrincipalDep, service: MlServiceDep
) -> EvaluationOut:
    return EvaluationOut(**await service.create_evaluation(principal, payload))


@router.get(
    "/ml/evaluations",
    response_model=Page[EvaluationOut],
    dependencies=[Depends(require_capability(CAP_EVALUATIONS_READ))],
)
async def list_evaluations(
    principal: PrincipalDep, service: MlServiceDep, pagination: PaginationDep
) -> Page[EvaluationOut]:
    items, total = await service.list_evaluations(
        principal, limit=pagination.limit, offset=pagination.offset
    )
    return _page([EvaluationOut(**item) for item in items], total, pagination)


@router.get(
    "/ml/evaluations/{evaluation_id}",
    response_model=EvaluationOut,
    dependencies=[Depends(require_capability(CAP_EVALUATIONS_READ))],
)
async def get_evaluation(
    evaluation_id: int, principal: PrincipalDep, service: MlServiceDep
) -> EvaluationOut:
    return EvaluationOut(**await service.get_evaluation(principal, evaluation_id))


@router.post(
    "/ml/evaluations/{evaluation_id}/results",
    response_model=EvaluationResultOut,
    dependencies=[Depends(require_capability(CAP_EVALUATIONS_WRITE))],
)
async def record_evaluation_result(
    evaluation_id: int,
    payload: EvaluationResultCreate,
    principal: PrincipalDep,
    service: MlServiceDep,
) -> EvaluationResultOut:
    return EvaluationResultOut(
        **await service.record_evaluation_result(principal, evaluation_id, payload)
    )


@router.get(
    "/ml/evaluations/{evaluation_id}/results",
    response_model=Page[EvaluationResultOut],
    dependencies=[Depends(require_capability(CAP_EVALUATIONS_READ))],
)
async def list_evaluation_results(
    evaluation_id: int,
    principal: PrincipalDep,
    service: MlServiceDep,
    pagination: PaginationDep,
) -> Page[EvaluationResultOut]:
    items, total = await service.list_evaluation_results(
        principal, evaluation_id, limit=pagination.limit, offset=pagination.offset
    )
    return _page([EvaluationResultOut(**item) for item in items], total, pagination)
