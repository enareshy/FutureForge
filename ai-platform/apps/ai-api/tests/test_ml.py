from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal, get_tracking_backend
from ai_api.domain.errors import ProviderError
from ai_api.infrastructure.ml.local_backend import LocalTrackingBackend
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
POWER_USER = frozenset({"*:*"})


class _FlakyExternalBackend(LocalTrackingBackend):
    """Simulates an external tracker that reports up but fails every call."""

    backend = "mlflow"

    @property
    def external(self) -> bool:
        return True

    async def status(self) -> dict[str, Any]:
        return {"backend": self.backend, "external": True, "available": True, "detail": "flaky"}

    async def ensure_experiment(self, **_kwargs: Any) -> dict[str, Any]:
        raise ProviderError("tracker down")

    async def start_run(self, **_kwargs: Any) -> dict[str, Any]:
        raise ProviderError("tracker down")


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


@contextmanager
def _client(
    repository: InMemoryAiRepository,
    principal: Principal,
    tracking: LocalTrackingBackend | None = None,
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal
    app.dependency_overrides[get_tracking_backend] = lambda: tracking or LocalTrackingBackend()
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _principal(username: str = "tester", permissions: frozenset[str] = POWER_USER) -> Principal:
    return Principal(
        user_id=username, username=username, tenant_id=TENANT, permissions=permissions
    )


def _create_experiment(client: TestClient, code: str = "anomaly-v1") -> dict[str, Any]:
    response = client.post(
        "/api/v1/ai/ml/experiments",
        json={"code": code, "name": "Anomaly detection", "problem_type": "classification"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_status_reports_backend(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        response = client.get("/api/v1/ai/ml/status")
        assert response.status_code == 200
        body = response.json()
        assert body["backend"] == "local"
        assert body["external"] is False
        assert body["available"] is True


def test_experiment_roundtrip_is_idempotent(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        first = _create_experiment(client)
        second = _create_experiment(client)
        assert first["id"] == second["id"]
        assert first["tracking_backend"] == "local"

        listing = client.get("/api/v1/ai/ml/experiments")
        assert listing.status_code == 200
        assert listing.json()["meta"]["total"] == 1

        fetched = client.get(f"/api/v1/ai/ml/experiments/{first['id']}")
        assert fetched.status_code == 200

        missing = client.get("/api/v1/ai/ml/experiments/999999")
        assert missing.status_code == 404


def test_experiment_code_validation(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        bad = client.post(
            "/api/v1/ai/ml/experiments",
            json={"code": "Bad Code", "name": "x"},
        )
        assert bad.status_code == 422


def test_run_lifecycle(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        experiment = _create_experiment(client)
        created = client.post(
            f"/api/v1/ai/ml/experiments/{experiment['id']}/runs",
            json={
                "run_name": "baseline",
                "params": {"n_estimators": 100},
                "metrics": {"accuracy": 0.9},
                "dataset_ref": {"name": "telemetry", "rows": 5000},
            },
        )
        assert created.status_code == 200, created.text
        run = created.json()
        assert run["status"] == "running"
        assert run["external_run_id"] is None

        finished = client.post(
            f"/api/v1/ai/ml/runs/{run['id']}/finish",
            json={"status": "finished", "metrics": {"accuracy": 0.93}},
        )
        assert finished.status_code == 200
        body = finished.json()
        assert body["status"] == "finished"
        assert body["metrics"]["accuracy"] == 0.93
        assert body["finished_at"] is not None

        unknown = client.post("/api/v1/ai/ml/runs/999999/finish", json={"status": "finished"})
        assert unknown.status_code == 404


def test_model_registry_and_version_promotion(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        model = client.post(
            "/api/v1/ai/ml/models",
            json={"code": "telemetry-anomaly", "name": "Telemetry anomaly", "framework": "xgboost"},
        )
        assert model.status_code == 200, model.text
        model_id = model.json()["id"]
        assert model.json()["stage"] == "none"

        version = client.post(
            f"/api/v1/ai/ml/models/{model_id}/versions",
            json={
                "artifact_uri": "s3://models/telemetry-anomaly/1",
                "metrics": {"f1": 0.88},
                "validation": {"holdout_f1": 0.86},
            },
        )
        assert version.status_code == 200, version.text
        assert version.json()["version"] == 1
        assert version.json()["status"] == "staging"
        assert version.json()["external_model_version"] is None

        second = client.post(
            f"/api/v1/ai/ml/models/{model_id}/versions", json={}
        )
        assert second.json()["version"] == 2

        versions = client.get(f"/api/v1/ai/ml/models/{model_id}/versions")
        assert versions.status_code == 200
        assert [v["version"] for v in versions.json()] == [2, 1]

        promoted = client.post(
            f"/api/v1/ai/ml/models/{model_id}/versions/1/status",
            json={"status": "production"},
        )
        assert promoted.status_code == 200
        assert promoted.json()["status"] == "production"

        refreshed = client.get(f"/api/v1/ai/ml/models/{model_id}")
        assert refreshed.json()["stage"] == "production"

        invalid = client.post(
            f"/api/v1/ai/ml/models/{model_id}/versions/1/status",
            json={"status": "banana"},
        )
        assert invalid.status_code == 422

        unknown = client.post(
            f"/api/v1/ai/ml/models/{model_id}/versions/99/status",
            json={"status": "production"},
        )
        assert unknown.status_code == 404


def test_evaluation_results(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        evaluation = client.post(
            "/api/v1/ai/ml/evaluations",
            json={"code": "rag-golden", "name": "RAG golden set", "kind": "answer"},
        )
        assert evaluation.status_code == 200, evaluation.text
        evaluation_id = evaluation.json()["id"]

        result = client.post(
            f"/api/v1/ai/ml/evaluations/{evaluation_id}/results",
            json={"case_id": "case-1", "metrics": {"faithfulness": 0.8}, "passed": True},
        )
        assert result.status_code == 200
        assert result.json()["passed"] is True

        listed = client.get(f"/api/v1/ai/ml/evaluations/{evaluation_id}/results")
        assert listed.status_code == 200
        assert listed.json()["meta"]["total"] == 1

        unknown = client.post(
            "/api/v1/ai/ml/evaluations/999999/results",
            json={"case_id": "case-x"},
        )
        assert unknown.status_code == 404


def test_external_tracker_failure_degrades(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal(), tracking=_FlakyExternalBackend()) as client:
        status = client.get("/api/v1/ai/ml/status").json()
        assert status["external"] is True

        created = client.post(
            "/api/v1/ai/ml/experiments",
            json={"code": "degrade-v1", "name": "Degrade"},
        )
        assert created.status_code == 200
        experiment = created.json()
        assert experiment["external_experiment_id"] is None
        assert experiment["tracking_backend"] == "mlflow"

        run = client.post(
            f"/api/v1/ai/ml/experiments/{experiment['id']}/runs",
            json={"params": {"x": 1}},
        )
        assert run.status_code == 200
        assert run.json()["external_run_id"] is None


def test_capability_enforcement(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("viewer", frozenset({"ai.usage:read"}))) as viewer:
        denied_read = viewer.get("/api/v1/ai/ml/experiments")
        denied_write = viewer.post(
            "/api/v1/ai/ml/experiments", json={"code": "x", "name": "X"}
        )
    assert denied_read.status_code == 403
    assert denied_write.status_code == 403

    with _client(
        repository, _principal("reader", frozenset({"ai.ml:read"}))
    ) as reader:
        allowed = reader.get("/api/v1/ai/ml/experiments")
        denied = reader.post("/api/v1/ai/ml/experiments", json={"code": "y", "name": "Y"})
    assert allowed.status_code == 200
    assert denied.status_code == 403
