"""Machine-learning tracking, model registry, and evaluation definitions.

Phase 11 resource. The platform repository is the authorization authority for
every experiment, run, model, and evaluation. An optional external tracker
(MLflow) only mirrors runs and model versions; when it is unavailable, records
are still created locally and the request succeeds. Nothing here trains a model
or fabricates metrics: runs, metrics, and validation values are whatever the
caller logged, and evaluation results are recorded verbatim.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ai_api.application.ports import AiRepository, TrackingBackend
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.domain.errors import NotFoundError, ProviderError, ValidationError
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger, request_id_var

logger = get_logger("ml")


@dataclass(slots=True)
class MlService:
    repository: AiRepository
    tracking: TrackingBackend
    audit: AuditService
    registration_enabled: bool = True

    # --- status ---------------------------------------------------------
    async def status(self) -> dict[str, Any]:
        info = await self.tracking.status()
        return {
            "backend": info.get("backend", "local"),
            "external": bool(info.get("external")),
            "available": bool(info.get("available")),
            "tracking_uri": info.get("tracking_uri"),
            "registration_enabled": self.registration_enabled,
            "detail": info.get("detail"),
        }

    async def _external_ready(self) -> bool:
        if not self.tracking.external:
            return False
        status = await self.tracking.status()
        return bool(status.get("available"))

    # --- experiments ----------------------------------------------------
    async def create_experiment(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        status = await self.tracking.status()
        backend = status.get("backend", self.tracking.backend)
        experiment = await self.repository.create_experiment_if_absent(
            tenant_id,
            {
                "code": payload.code,
                "name": payload.name,
                "description": payload.description,
                "problem_type": payload.problem_type,
                "tracking_backend": backend,
                "tags": payload.tags,
            },
        )
        if experiment.get("external_experiment_id") is None and await self._external_ready():
            try:
                registered = await self.tracking.ensure_experiment(
                    code=payload.code,
                    name=payload.name,
                    description=payload.description,
                    tags=dict(payload.tags),
                )
                updated = await self.repository.update_experiment_tracking(
                    tenant_id,
                    experiment["id"],
                    tracking_backend=backend,
                    external_experiment_id=registered.get("external_experiment_id"),
                )
                experiment = updated or experiment
            except ProviderError as exc:
                logger.warning("ml.experiment.track_failed", error=str(exc), code=payload.code)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.ml.experiment.create",
            resource_type="experiment",
            resource_id=str(experiment["id"]),
            request_id=request_id_var.get(),
            detail={"code": payload.code, "backend": backend},
        )
        return experiment

    async def list_experiments(
        self, principal: Principal, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_experiments(tenant_id, limit=limit, offset=offset)

    async def get_experiment(self, principal: Principal, experiment_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        experiment = await self.repository.get_experiment(tenant_id, experiment_id)
        if experiment is None:
            raise NotFoundError("experiment not found", details={"experiment_id": experiment_id})
        return experiment

    # --- runs -----------------------------------------------------------
    async def create_run(
        self, principal: Principal, experiment_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        experiment = await self.repository.get_experiment(tenant_id, experiment_id)
        if experiment is None:
            raise NotFoundError("experiment not found", details={"experiment_id": experiment_id})
        run = await self.repository.create_experiment_run(
            tenant_id,
            {
                "experiment_id": experiment_id,
                "run_name": payload.run_name,
                "status": "running",
                "params": payload.params,
                "metrics": payload.metrics,
                "training_config": payload.training_config,
                "dataset_ref": payload.dataset_ref,
                "code_version": payload.code_version,
                "logged_by": principal.actor_id,
            },
        )
        if await self._external_ready():
            external_id = experiment.get("external_experiment_id")
            if external_id is None:
                try:
                    registered = await self.tracking.ensure_experiment(
                        code=experiment["code"],
                        name=experiment["name"],
                        description=experiment.get("description"),
                        tags=dict(experiment.get("tags") or {}),
                    )
                    external_id = registered.get("external_experiment_id")
                    await self.repository.update_experiment_tracking(
                        tenant_id,
                        experiment_id,
                        tracking_backend=self.tracking.backend,
                        external_experiment_id=external_id,
                    )
                except ProviderError as exc:
                    logger.warning("ml.experiment.track_failed", error=str(exc))
                    external_id = None
            if external_id:
                try:
                    started = await self.tracking.start_run(
                        external_experiment_id=external_id,
                        run_name=payload.run_name,
                        params=dict(payload.params),
                        tags={"ai.run_uuid": run["run_uuid"]},
                    )
                    external_run_id = started.get("external_run_id")
                    if external_run_id:
                        await self.tracking.log_batch(
                            external_run_id=external_run_id,
                            params=dict(payload.params),
                            metrics=dict(payload.metrics),
                            tags={},
                        )
                    updated = await self.repository.update_experiment_run(
                        tenant_id,
                        run["id"],
                        {
                            "external_run_id": external_run_id,
                            "artifact_uri": started.get("artifact_uri"),
                        },
                    )
                    run = updated or run
                except ProviderError as exc:
                    logger.warning("ml.run.track_failed", error=str(exc), run_id=run["id"])
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.ml.run.create",
            resource_type="experiment_run",
            resource_id=str(run["id"]),
            request_id=request_id_var.get(),
            detail={"experiment_id": experiment_id},
        )
        return run

    async def list_runs(
        self,
        principal: Principal,
        *,
        experiment_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_experiment_runs(
            tenant_id, experiment_id=experiment_id, limit=limit, offset=offset
        )

    async def get_run(self, principal: Principal, run_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        run = await self.repository.get_experiment_run(tenant_id, run_id)
        if run is None:
            raise NotFoundError("run not found", details={"run_id": run_id})
        return run

    async def finish_run(
        self, principal: Principal, run_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        run = await self.repository.get_experiment_run(tenant_id, run_id)
        if run is None:
            raise NotFoundError("run not found", details={"run_id": run_id})
        metrics = dict(run.get("metrics") or {})
        metrics.update(payload.metrics or {})
        updated = await self.repository.update_experiment_run(
            tenant_id,
            run_id,
            {
                "status": payload.status,
                "metrics": metrics,
                "finished_at": datetime.now(UTC),
            },
        )
        run = updated or run
        external_run_id = run.get("external_run_id")
        if external_run_id and await self._external_ready():
            try:
                await self.tracking.end_run(external_run_id=external_run_id, status=payload.status)
            except ProviderError as exc:
                logger.warning("ml.run.end_failed", error=str(exc), run_id=run_id)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.ml.run.finish",
            resource_type="experiment_run",
            resource_id=str(run_id),
            request_id=request_id_var.get(),
            detail={"status": payload.status},
        )
        return run

    # --- model registry -------------------------------------------------
    async def register_model(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        model = await self.repository.create_ml_model_if_absent(
            tenant_id,
            {
                "code": payload.code,
                "name": payload.name,
                "description": payload.description,
                "problem_type": payload.problem_type,
                "framework": payload.framework,
                "task": payload.task,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.ml.model.register",
            resource_type="ml_model",
            resource_id=str(model["id"]),
            request_id=request_id_var.get(),
            detail={"code": payload.code},
        )
        return model

    async def list_models(
        self, principal: Principal, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_ml_models(tenant_id, limit=limit, offset=offset)

    async def get_model(self, principal: Principal, model_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        model = await self.repository.get_ml_model(tenant_id, model_id)
        if model is None:
            raise NotFoundError("model not found", details={"model_id": model_id})
        return model

    async def create_model_version(
        self, principal: Principal, model_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        model = await self.repository.get_ml_model(tenant_id, model_id)
        if model is None:
            raise NotFoundError("model not found", details={"model_id": model_id})
        external_run_id: str | None = None
        if payload.run_id is not None:
            source_run = await self.repository.get_experiment_run(tenant_id, payload.run_id)
            if source_run is None:
                raise NotFoundError("run not found", details={"run_id": payload.run_id})
            external_run_id = source_run.get("external_run_id")
        source_uri = payload.source or payload.artifact_uri
        external_model_version = None
        if source_uri and self.registration_enabled and await self._external_ready():
            try:
                registered = await self.tracking.register_model_version(
                    name=model["code"],
                    source_uri=source_uri,
                    external_run_id=external_run_id,
                    tags={"ai.model_id": str(model_id)},
                )
                external_model_version = registered.get("external_model_version")
            except ProviderError as exc:
                logger.warning("ml.model.register_failed", error=str(exc), model_id=model_id)
        version = await self.repository.create_ml_model_version(
            tenant_id,
            model_id,
            {
                "run_id": payload.run_id,
                "status": "staging",
                "framework": payload.framework or model.get("framework"),
                "metrics": payload.metrics,
                "parameters": payload.parameters,
                "validation": payload.validation,
                "artifact_uri": payload.artifact_uri,
                "external_model_version": external_model_version,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.ml.model.version.create",
            resource_type="ml_model_version",
            resource_id=f"{model_id}:{version['version']}",
            request_id=request_id_var.get(),
        )
        return version

    async def list_model_versions(
        self, principal: Principal, model_id: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        model = await self.repository.get_ml_model(tenant_id, model_id)
        if model is None:
            raise NotFoundError("model not found", details={"model_id": model_id})
        return await self.repository.list_ml_model_versions(tenant_id, model_id)

    async def set_model_version_status(
        self, principal: Principal, model_id: int, version: int, status: str
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        record = await self.repository.update_ml_model_version(
            tenant_id, model_id, version, {"status": status}
        )
        if record is None:
            raise NotFoundError(
                "model version not found", details={"model_id": model_id, "version": version}
            )
        if status == "production":
            await self.repository.set_ml_model_stage(tenant_id, model_id, "production")
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.ml.model.version.status",
            resource_type="ml_model_version",
            resource_id=f"{model_id}:{version}",
            request_id=request_id_var.get(),
            detail={"status": status},
        )
        return record

    # --- evaluation definitions ----------------------------------------
    async def create_evaluation(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        evaluation = await self.repository.create_evaluation_if_absent(
            tenant_id,
            {
                "code": payload.code,
                "name": payload.name,
                "kind": payload.kind,
                "config": payload.config,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.ml.evaluation.create",
            resource_type="evaluation",
            resource_id=str(evaluation["id"]),
            request_id=request_id_var.get(),
            detail={"kind": payload.kind},
        )
        return evaluation

    async def list_evaluations(
        self, principal: Principal, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_evaluations(tenant_id, limit=limit, offset=offset)

    async def get_evaluation(self, principal: Principal, evaluation_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        evaluation = await self.repository.get_evaluation(tenant_id, evaluation_id)
        if evaluation is None:
            raise NotFoundError("evaluation not found", details={"evaluation_id": evaluation_id})
        return evaluation

    async def record_evaluation_result(
        self, principal: Principal, evaluation_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        evaluation = await self.repository.get_evaluation(tenant_id, evaluation_id)
        if evaluation is None:
            raise NotFoundError("evaluation not found", details={"evaluation_id": evaluation_id})
        if not payload.case_id.strip():
            raise ValidationError("case_id is required")
        result = await self.repository.record_evaluation_result(
            tenant_id,
            evaluation_id,
            {
                "case_id": payload.case_id,
                "metrics": payload.metrics,
                "passed": payload.passed,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.ml.evaluation.result",
            resource_type="evaluation",
            resource_id=str(evaluation_id),
            request_id=request_id_var.get(),
            detail={"case_id": payload.case_id, "passed": payload.passed},
        )
        return result

    async def list_evaluation_results(
        self, principal: Principal, evaluation_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        evaluation = await self.repository.get_evaluation(tenant_id, evaluation_id)
        if evaluation is None:
            raise NotFoundError("evaluation not found", details={"evaluation_id": evaluation_id})
        return await self.repository.list_evaluation_results(
            tenant_id, evaluation_id, limit=limit, offset=offset
        )
