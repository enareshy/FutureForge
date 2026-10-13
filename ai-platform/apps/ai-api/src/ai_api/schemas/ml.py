from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

CODE_PATTERN = r"^[a-z0-9][a-z0-9._-]*$"
ProblemType = Literal["classification", "regression", "ranking"]
ModelStage = Literal["none", "staging", "production", "archived"]
VersionStatus = Literal["staging", "production", "archived"]
RunStatus = Literal["running", "finished", "failed", "killed"]


class MlStatusOut(BaseModel):
    backend: str
    external: bool
    available: bool
    tracking_uri: str | None = None
    registration_enabled: bool = False
    detail: str | None = None


# --- Experiments --------------------------------------------------------
class ExperimentCreate(BaseModel):
    code: str = Field(min_length=1, max_length=120, pattern=CODE_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    problem_type: ProblemType = "classification"
    tags: dict[str, Any] = Field(default_factory=dict)


class ExperimentOut(BaseModel):
    id: int
    code: str
    name: str
    description: str | None = None
    problem_type: str
    tracking_backend: str
    external_experiment_id: str | None = None
    tags: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


# --- Runs ---------------------------------------------------------------
class RunCreate(BaseModel):
    run_name: str | None = Field(default=None, max_length=200)
    params: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)
    training_config: dict[str, Any] = Field(default_factory=dict)
    dataset_ref: dict[str, Any] = Field(default_factory=dict)
    code_version: str | None = Field(default=None, max_length=200)


class RunFinish(BaseModel):
    status: Literal["finished", "failed", "killed"] = "finished"
    metrics: dict[str, Any] = Field(default_factory=dict)


class RunOut(BaseModel):
    id: int
    experiment_id: int
    run_uuid: str
    run_name: str | None = None
    status: str
    external_run_id: str | None = None
    artifact_uri: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] = Field(default_factory=dict)
    training_config: dict[str, Any] = Field(default_factory=dict)
    dataset_ref: dict[str, Any] = Field(default_factory=dict)
    code_version: str | None = None
    logged_by: int | None = None
    created_at: datetime
    finished_at: datetime | None = None


# --- Model registry -----------------------------------------------------
class ModelCreate(BaseModel):
    code: str = Field(min_length=1, max_length=120, pattern=CODE_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    problem_type: ProblemType = "classification"
    framework: str = Field(default="scikit-learn", max_length=80)
    task: str | None = Field(default=None, max_length=120)


class ModelOut(BaseModel):
    id: int
    code: str
    name: str
    description: str | None = None
    problem_type: str
    framework: str
    task: str | None = None
    stage: str
    created_at: datetime
    updated_at: datetime


class ModelVersionCreate(BaseModel):
    run_id: int | None = None
    framework: str | None = Field(default=None, max_length=80)
    metrics: dict[str, Any] = Field(default_factory=dict)
    parameters: dict[str, Any] = Field(default_factory=dict)
    validation: dict[str, Any] = Field(default_factory=dict)
    artifact_uri: str | None = Field(default=None, max_length=2000)
    source: str | None = Field(default=None, max_length=2000)


class ModelVersionStatusUpdate(BaseModel):
    status: VersionStatus


class ModelVersionOut(BaseModel):
    id: int
    ml_model_id: int
    version: int
    run_id: int | None = None
    status: str
    framework: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    parameters: dict[str, Any] = Field(default_factory=dict)
    validation: dict[str, Any] = Field(default_factory=dict)
    artifact_uri: str | None = None
    external_model_version: str | None = None
    created_at: datetime


# --- Evaluations --------------------------------------------------------
class EvaluationCreate(BaseModel):
    code: str = Field(min_length=1, max_length=120, pattern=CODE_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["retrieval", "answer", "safety"] = "retrieval"
    config: dict[str, Any] = Field(default_factory=dict)


class EvaluationOut(BaseModel):
    id: int
    code: str
    name: str
    kind: str
    config: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class EvaluationResultCreate(BaseModel):
    case_id: str = Field(min_length=1, max_length=200)
    metrics: dict[str, Any] = Field(default_factory=dict)
    passed: bool | None = None


class EvaluationResultOut(BaseModel):
    id: int
    evaluation_id: int
    case_id: str
    metrics: dict[str, Any] = Field(default_factory=dict)
    passed: bool | None = None
    created_at: datetime
