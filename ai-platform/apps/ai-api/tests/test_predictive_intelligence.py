"""Stage 10 / Step 8: predictive intelligence & recommendations tests."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
OTHER_TENANT = 2
POWER_USER = frozenset({"*:*"})
READER = frozenset({"iam.predictive-intelligence.predictions:read"})
WRITER = READER | {"iam.predictive-intelligence.predictions:create"}
API = "/api/v1/ai"
PREFIX = f"{API}/predictive-intelligence"


def _principal(
    username: str = "tester",
    permissions: frozenset[str] = POWER_USER,
    tenant_id: int = TENANT,
    actor_id: int | None = 7,
) -> Principal:
    return Principal(
        user_id=username,
        username=username,
        tenant_id=tenant_id,
        permissions=permissions,
        actor_id=actor_id,
    )


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


@contextmanager
def _client(
    repository: InMemoryAiRepository, principal: Principal
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


# --- Fixtures ------------------------------------------------------------
def _item(client: TestClient, key: str, item_type: str = "part", **overrides) -> dict:
    payload = {"item_type": item_type, "item_key": key, "name": key, **overrides}
    response = client.post(f"{API}/products/items", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _issue(client: TestClient, key: str, **overrides) -> dict:
    payload = {"issue_key": key, "title": key, **overrides}
    response = client.post(f"{API}/quality/issues", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _feature(client: TestClient, key: str, **overrides) -> dict:
    payload = {"feature_key": key, "name": key, **overrides}
    response = client.post(f"{PREFIX}/features", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# --- Feature definitions & values ---------------------------------------
def test_feature_definition_lifecycle(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        feature = _feature(
            client, "defect_rate", data_type="number", freshness_ttl_hours=48
        )
        assert feature["feature_key"] == "defect_rate"
        assert feature["freshness_ttl_hours"] == 48

        listed = client.get(f"{PREFIX}/features")
        assert listed.status_code == 200
        assert listed.json()["total"] == 1

        updated = client.patch(
            f"{PREFIX}/features/{feature['id']}",
            json={"lifecycle_status": "deprecated"},
        )
        assert updated.status_code == 200
        assert updated.json()["lifecycle_status"] == "deprecated"

        fetched = client.get(f"{PREFIX}/features/{feature['id']}")
        assert fetched.status_code == 200


def test_feature_value_validation_and_freshness(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _feature(client, "defect_rate", data_type="number")
        item = _item(client, "PN-1")

        ok = client.post(
            f"{PREFIX}/feature-values",
            json={
                "feature_key": "defect_rate",
                "entity_type": "product_item",
                "entity_id": item["id"],
                "value": 3.5,
            },
        )
        assert ok.status_code == 201, ok.text
        assert ok.json()["stale"] is False

        bad = client.post(
            f"{PREFIX}/feature-values",
            json={
                "feature_key": "defect_rate",
                "entity_type": "product_item",
                "entity_id": item["id"],
                "value": "not-a-number",
            },
        )
        assert bad.status_code == 422, bad.text

        status = client.get(f"{PREFIX}/features/defect_rate/status")
        assert status.status_code == 200, status.text
        body = status.json()
        assert body["defined"] is True
        assert body["value_count"] == 1
        assert body["status"] == "fresh"


def test_feature_status_without_definition(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        status = client.get(f"{PREFIX}/features/missing/status")
        assert status.status_code == 200, status.text
        assert status.json()["defined"] is False
        assert status.json()["status"] == "undefined"


# --- Datasets & models ---------------------------------------------------
def test_dataset_versions(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        dataset = client.post(
            f"{PREFIX}/datasets",
            json={"dataset_key": "quality-ds", "prediction_type": "defect_risk"},
        )
        assert dataset.status_code == 201, dataset.text
        dataset_id = dataset.json()["id"]

        version = client.post(
            f"{PREFIX}/datasets/{dataset_id}/versions",
            json={"version": 1, "split": "train", "row_count": 120},
        )
        assert version.status_code == 201, version.text
        assert version.json()["split"] == "train"

        versions = client.get(f"{PREFIX}/datasets/{dataset_id}/versions")
        assert versions.status_code == 200
        assert len(versions.json()) == 1

        bad_split = client.post(
            f"{PREFIX}/datasets/{dataset_id}/versions",
            json={"version": 2, "split": "invalid", "row_count": 10},
        )
        assert bad_split.status_code == 422


def test_model_registry_lifecycle_and_versions(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        model = client.post(
            f"{PREFIX}/models",
            json={
                "model_key": "quality-rules",
                "prediction_type": "defect_risk",
                "method": "rule_based",
            },
        )
        assert model.status_code == 201, model.text
        model_id = model.json()["id"]

        activated = client.patch(
            f"{PREFIX}/models/{model_id}", json={"lifecycle_status": "active"}
        )
        assert activated.status_code == 200, activated.text

        version = client.post(
            f"{PREFIX}/models/{model_id}/versions",
            json={
                "version": "1.0.0",
                "method": "rule_based",
                "ruleset_version": "rules-2026.1",
                "lifecycle_status": "active",
            },
        )
        assert version.status_code == 201, version.text
        assert version.json()["ruleset_version"] == "rules-2026.1"

        retired = client.patch(
            f"{PREFIX}/models/{model_id}", json={"lifecycle_status": "retired"}
        )
        assert retired.status_code == 200, retired.text
        assert retired.json()["lifecycle_status"] == "retired"

        # retired is terminal and hidden from reads, so reactivating is refused.
        reactivated = client.patch(
            f"{PREFIX}/models/{model_id}", json={"lifecycle_status": "active"}
        )
        assert reactivated.status_code == 404, reactivated.text


# --- Prediction execution ------------------------------------------------
def test_rule_based_prediction_and_insufficient_data(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-RISK")
        empty = client.post(
            f"{PREFIX}/predictions",
            json={
                "prediction_type": "defect_risk",
                "subject_type": "product_item",
                "subject_id": item["id"],
            },
        )
        assert empty.status_code == 201, empty.text
        body = empty.json()
        assert body["status"] == "insufficient_data"
        assert body["risk_category"] == "unknown"
        assert body["score"] is None
        assert body["uncertainty"]["kind"] == "NOT_EVALUATED"
        assert body["limitations"]

        _issue(client, "QI-1", severity="critical", product_item_id=item["id"])
        _issue(client, "QI-2", severity="high", product_item_id=item["id"])
        predicted = client.post(
            f"{PREFIX}/predictions",
            json={
                "prediction_type": "defect_risk",
                "subject_type": "product_item",
                "subject_id": item["id"],
            },
        )
        assert predicted.status_code == 201, predicted.text
        body = predicted.json()
        assert body["status"] == "active"
        assert body["method"] == "rule_based"
        assert body["score"] is not None
        assert body["uncertainty"]["kind"] == "RULE_BASED_SCORE"
        assert body["evidence"]
        assert body["limitations"] is not None


def test_prediction_idempotency(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-IDEM")
        _issue(client, "QI-IDEM", product_item_id=item["id"])
        payload = {
            "prediction_type": "defect_risk",
            "subject_type": "product_item",
            "subject_id": item["id"],
            "idempotency_key": "run-1",
        }
        first = client.post(f"{PREFIX}/predictions", json=payload)
        assert first.status_code == 201, first.text
        second = client.post(f"{PREFIX}/predictions", json=payload)
        assert second.status_code == 201, second.text
        assert second.json()["id"] == first.json()["id"]

        listed = client.get(f"{PREFIX}/predictions")
        assert listed.json()["total"] == 1


def test_ml_method_is_explicitly_insufficient(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-ML")
        client.post(
            f"{PREFIX}/models",
            json={
                "model_key": "ml-defect",
                "prediction_type": "defect_risk",
                "method": "ml",
                "lifecycle_status": "active",
            },
        )
        result = client.post(
            f"{PREFIX}/predictions",
            json={
                "prediction_type": "defect_risk",
                "subject_type": "product_item",
                "subject_id": item["id"],
                "model_key": "ml-defect",
            },
        )
        assert result.status_code == 201, result.text
        body = result.json()
        assert body["status"] == "insufficient_data"
        assert body["method"] == "ml"


def test_prediction_explanation_provenance(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-EXPLAIN")
        _issue(client, "QI-E", product_item_id=item["id"], severity="high")
        predicted = client.post(
            f"{PREFIX}/predictions",
            json={
                "prediction_type": "defect_risk",
                "subject_type": "product_item",
                "subject_id": item["id"],
            },
        )
        prediction_id = predicted.json()["id"]
        explanation = client.get(
            f"{PREFIX}/predictions/{prediction_id}/explanation"
        )
        assert explanation.status_code == 200, explanation.text
        body = explanation.json()
        assert body["prediction"]["id"] == prediction_id
        assert body["method_label"]
        assert "data_freshness" in body
        assert "limitations" in body


# --- Recommendations -----------------------------------------------------
def test_recommendation_generation_and_lifecycle(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-REC")
        _issue(client, "QI-R1", product_item_id=item["id"], severity="critical")
        _issue(client, "QI-R2", product_item_id=item["id"], severity="critical")
        predicted = client.post(
            f"{PREFIX}/predictions",
            json={
                "prediction_type": "defect_risk",
                "subject_type": "product_item",
                "subject_id": item["id"],
            },
        )
        prediction = predicted.json()
        assert prediction["status"] == "active"

        generated = client.post(
            f"{PREFIX}/recommendations/generate",
            json={"prediction_ids": [prediction["id"]]},
        )
        assert generated.status_code == 200, generated.text
        rows = generated.json()
        assert len(rows) == 1
        recommendation = rows[0]
        assert recommendation["status"] == "new"
        assert recommendation["prediction_id"] == prediction["id"]

        # Generating twice must be idempotent per prediction.
        again = client.post(
            f"{PREFIX}/recommendations/generate",
            json={"prediction_ids": [prediction["id"]]},
        )
        assert again.json()[0]["id"] == recommendation["id"]

        accepted = client.patch(
            f"{PREFIX}/recommendations/{recommendation['id']}",
            json={"status": "under_review"},
        )
        assert accepted.status_code == 200, accepted.text

        feedback = client.post(
            f"{PREFIX}/recommendations/{recommendation['id']}/feedback",
            json={
                "decision": "accept",
                "comment": "Acting on it",
                "outcome": "issue closed",
                "risk_after": 10,
            },
        )
        assert feedback.status_code == 201, feedback.text
        assert feedback.json()["decision"] == "accept"

        refreshed = client.get(
            f"{PREFIX}/recommendations/{recommendation['id']}"
        )
        assert refreshed.json()["status"] == "accepted"
        assert refreshed.json()["risk_reduced"] is True

        history = client.get(
            f"{PREFIX}/recommendations/{recommendation['id']}/feedback"
        )
        assert len(history.json()) == 1


def test_recommendation_illegal_transition(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        created = client.post(
            f"{PREFIX}/recommendations",
            json={"title": "Manual recommendation", "severity": "medium"},
        )
        assert created.status_code == 201, created.text
        recommendation_id = created.json()["id"]

        completed = client.patch(
            f"{PREFIX}/recommendations/{recommendation_id}",
            json={"status": "completed"},
        )
        assert completed.status_code == 422, completed.text


# --- Schedules -----------------------------------------------------------
def test_schedule_upsert_interval_validation(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-SCHED")
        created = client.post(
            f"{PREFIX}/schedules",
            json={
                "schedule_key": "daily-defect",
                "prediction_type": "defect_risk",
                "subject_type": "product_item",
                "subject_scope": {"subject_ids": [item["id"]]},
                "interval_seconds": 3600,
            },
        )
        assert created.status_code == 201, created.text
        assert created.json()["enabled"] is True

        too_short = client.post(
            f"{PREFIX}/schedules",
            json={
                "schedule_key": "too-fast",
                "prediction_type": "defect_risk",
                "subject_type": "product_item",
                "interval_seconds": 5,
            },
        )
        assert too_short.status_code == 422

        listed = client.get(f"{PREFIX}/schedules")
        assert listed.json()["total"] == 1

        disabled = client.patch(
            f"{PREFIX}/schedules/{created.json()['id']}",
            json={"enabled": False},
        )
        assert disabled.status_code == 200
        assert disabled.json()["enabled"] is False


# --- Analytics / stats ---------------------------------------------------
def test_analytics_and_stats(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-STATS")
        _issue(client, "QI-S", product_item_id=item["id"], severity="high")
        client.post(
            f"{PREFIX}/predictions",
            json={
                "prediction_type": "defect_risk",
                "subject_type": "product_item",
                "subject_id": item["id"],
            },
        )
        stats = client.get(f"{PREFIX}/stats")
        assert stats.status_code == 200, stats.text
        assert stats.json()["predictions"] == 1

        analytics = client.get(f"{PREFIX}/analytics/risk_by_type")
        assert analytics.status_code == 200, analytics.text
        assert analytics.json()["rows"]

        unknown = client.get(f"{PREFIX}/analytics/not-a-kind")
        assert unknown.status_code == 422

        performance = client.get(f"{PREFIX}/models/performance")
        assert performance.status_code == 200, performance.text
        assert "note" in performance.json()


# --- Authorization / tenant isolation -----------------------------------
def test_reader_cannot_write(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal(permissions=READER)) as client:
        response = client.post(
            f"{PREFIX}/features",
            json={"feature_key": "blocked"},
        )
        assert response.status_code == 403, response.text
        listing = client.get(f"{PREFIX}/features")
        assert listing.status_code == 200


def test_tenant_isolation(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        _feature(client, "tenant-one")

    with _client(
        repository, _principal(tenant_id=OTHER_TENANT, username="other")
    ) as client:
        listed = client.get(f"{PREFIX}/features")
        assert listed.status_code == 200
        assert listed.json()["total"] == 0


# --- AI tool integration -------------------------------------------------
def test_predictive_tools_registered() -> None:
    from ai_api.application.services.enterprise_tools import build_enterprise_tool_client

    class _Settings:
        ai_copilot_tool_result_limit = 10
        enterprise_api_base_url = "http://localhost:8080"
        ai_copilot_tool_timeout_seconds = 5

    class _Policy:
        def require(self, *args, **kwargs) -> None:
            return None

    client = build_enterprise_tool_client(_Settings(), _Policy())
    names = set(client.names())
    assert "predictive.risk_lookup" in names
    assert "predictive.explain" in names
    assert "predictive.recommendations" in names
    assert "predictive.recommendation_feedback" in names
