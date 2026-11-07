"""Real PostgreSQL coverage for Stage 10 predictive intelligence (0026).

Exercises the SQL repositories for feature definitions/values, dataset & model
versions, prediction idempotency, recommendations/feedback and schedules, plus
RLS-scoped tenant isolation.

    AI_TEST_POSTGRES=1 \\
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 \\
    POSTGRES_USER=postgres POSTGRES_PASSWORD=test POSTGRES_DB=helix \\
    pytest -o addopts="" tests/test_predictive_intelligence_postgres.py
"""

from __future__ import annotations

import asyncio
import os
import socket
from datetime import UTC, datetime, timedelta

import pytest

from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.bom_service import BomService
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.graph_query_service import GraphQueryService
from ai_api.application.services.graph_service import GraphService
from ai_api.application.services.manufacturing_service import ManufacturingService
from ai_api.application.services.predictive_service import PredictiveService
from ai_api.application.services.product_service import ProductService
from ai_api.application.services.quality_service import QualityService
from ai_api.config.settings import get_settings
from ai_api.infrastructure.db import PostgresDatabase, system_scope, tenant_scope
from ai_api.infrastructure.repositories.postgres_ai_repository import (
    PostgresAiRepository,
)
from ai_api.schemas.predictive import (
    DatasetCreate,
    DatasetVersionCreate,
    FeatureDefinitionCreate,
    FeatureValueCreate,
    ModelVersionCreate,
    PredictionModelCreate,
    PredictionRequest,
)
from ai_api.schemas.product import ProductItemCreate
from ai_api.security.access_control import AccessControl
from ai_api.security.policies import Principal

pytestmark = pytest.mark.integration

TENANT = 990911
OTHER_TENANT = 990912
POWER_USER = frozenset({"*:*"})


def _principal(tenant_id: int = TENANT, username: str = "pg-pred") -> Principal:
    return Principal(
        user_id=username,
        username=username,
        tenant_id=tenant_id,
        permissions=POWER_USER,
        actor_id=7,
    )


def _requires_postgres() -> None:
    if os.environ.get("AI_TEST_POSTGRES", "") != "1":
        pytest.skip("set AI_TEST_POSTGRES=1 to run PostgreSQL predictive tests")
    settings = get_settings()
    try:
        with socket.create_connection(
            (settings.postgres_host, settings.postgres_port), timeout=1
        ):
            pass
    except OSError:
        pytest.skip("PostgreSQL is not reachable")


async def _db() -> PostgresDatabase:
    db = PostgresDatabase(get_settings())
    await db.connect()
    return db


async def _cleanup(db: PostgresDatabase) -> None:
    with system_scope():
        for tenant in (TENANT, OTHER_TENANT):
            for table in (
                "predictive_recommendation_feedback",
                "predictive_recommendations",
                "predictive_predictions",
                "predictive_model_versions",
                "predictive_models",
                "predictive_dataset_versions",
                "predictive_datasets",
                "predictive_feature_values",
                "predictive_feature_definitions",
                "predictive_schedules",
                "graph_relationship_versions",
                "graph_relationships",
                "graph_entity_versions",
                "graph_entities",
                "product_revisions",
                "product_items",
            ):
                await db.execute(
                    f"DELETE FROM ai.{table} WHERE tenant_id = $1", tenant
                )


def _services(repository):
    audit = AuditService(repository)
    access = AccessControl()
    governance = GovernanceService(repository)
    events = EventPublisher(sinks=())
    graph = GraphService(
        repository=repository,
        audit=audit,
        access=access,
        governance=governance,
        events=events,
    )
    graph_query = GraphQueryService(repository=repository, graph=graph, audit=audit)
    products = ProductService(
        repository=repository,
        audit=audit,
        access=access,
        governance=governance,
        graph=graph,
        events=events,
    )
    boms = BomService(
        repository=repository,
        products=products,
        audit=audit,
        graph=graph,
        graph_query=graph_query,
        events=events,
    )
    manufacturing = ManufacturingService(
        repository=repository,
        products=products,
        audit=audit,
        access=access,
        governance=governance,
        graph=graph,
        events=events,
    )
    quality = QualityService(
        repository=repository,
        products=products,
        manufacturing=manufacturing,
        audit=audit,
        access=access,
        governance=governance,
        graph=graph,
        events=events,
    )
    predictive = PredictiveService(
        repository=repository,
        products=products,
        boms=boms,
        manufacturing=manufacturing,
        quality=quality,
        audit=audit,
        access=access,
        governance=governance,
        graph=graph,
        events=events,
        graph_query=graph_query,
        gateway=None,
        settings=None,
    )
    return products, quality, predictive


def _run(scenario) -> None:
    _requires_postgres()

    async def wrapper() -> None:
        db = await _db()
        try:
            await _cleanup(db)
            repository = PostgresAiRepository(db)
            with tenant_scope(TENANT):
                products, quality, predictive = _services(repository)
                await scenario(products, quality, predictive, repository)
        finally:
            await _cleanup(db)
            await db.close()

    asyncio.run(wrapper())


async def _item(products, principal, key):
    return await products.create_or_update_item(
        principal,
        ProductItemCreate(item_type="part", item_key=key, name=key),
    )


def test_feature_and_dataset_round_trip() -> None:
    async def scenario(products, quality, predictive, repository) -> None:
        principal = _principal()
        feature = await predictive.upsert_feature_definition(
            principal,
            FeatureDefinitionCreate(
                feature_key="defect_rate",
                data_type="number",
                freshness_ttl_hours=24,
            ),
        )
        assert feature["freshness_ttl_hours"] == 24

        item = await _item(products, principal, "PG-PRED-ITEM")
        value = await predictive.record_feature_value(
            principal,
            FeatureValueCreate(
                feature_key="defect_rate",
                entity_type="product_item",
                entity_id=item["id"],
                value=2.5,
            ),
        )
        assert value["stale"] is False

        status = await predictive.feature_status(principal, "defect_rate")
        assert status["defined"] is True
        assert status["value_count"] == 1
        assert status["status"] == "fresh"

        dataset = await predictive.upsert_dataset(
            principal,
            DatasetCreate(
                dataset_key="pg-ds",
                prediction_type="defect_risk",
            ),
        )
        version = await predictive.add_dataset_version(
            principal,
            dataset["id"],
            DatasetVersionCreate(version=1, split="train", row_count=42),
        )
        assert version["version"] == 1
        assert version["split"] == "train"
        listed = await predictive.list_dataset_versions(
            principal, dataset["id"], limit=10
        )
        assert len(listed) == 1

    _run(scenario)


def test_model_version_and_prediction_idempotency() -> None:
    async def scenario(products, quality, predictive, repository) -> None:
        principal = _principal()
        item = await _item(products, principal, "PG-PRED-RISK")
        model = await predictive.upsert_model(
            principal,
            PredictionModelCreate(
                model_key="quality-rules",
                prediction_type="defect_risk",
                method="rule_based",
                lifecycle_status="active",
            ),
        )
        version = await predictive.add_model_version(
            principal,
            model["id"],
            ModelVersionCreate(
                version="1.0.0",
                method="rule_based",
                ruleset_version="rules-2026.1",
                lifecycle_status="active",
            ),
        )
        assert version["version"] == "1.0.0"

        payload = PredictionRequest(
            prediction_type="defect_risk",
            subject_type="product_item",
            subject_id=item["id"],
            model_key="quality-rules",
            idempotency_key="pg-run-1",
        )
        first = await predictive.predict(principal, payload)
        second = await predictive.predict(principal, payload)
        assert first["id"] == second["id"]
        # No issues recorded, so the result must be explicit insufficient data.
        assert first["status"] == "insufficient_data"
        assert first["risk_category"] == "unknown"
        assert first["model_version"] == "1.0.0"
        assert first["ruleset_version"] == "rules-2026.1"

        rows, total = await predictive.list_predictions(
            principal,
            prediction_type=None,
            subject_type=None,
            subject_id=None,
            risk_category=None,
            status=None,
            limit=50,
            offset=0,
        )
        assert total == 1
        assert rows[0]["prediction_key"] == first["prediction_key"]

    _run(scenario)


def test_recommendation_lifecycle_and_feedback() -> None:
    async def scenario(products, quality, predictive, repository) -> None:
        principal = _principal()
        item = await _item(products, principal, "PG-PRED-REC")
        from ai_api.schemas.quality import QualityIssueCreate

        for index in range(2):
            await quality.upsert_issue(
                principal,
                QualityIssueCreate(
                    issue_key=f"PG-QI-{index}",
                    title="defect",
                    severity="critical",
                    product_item_id=item["id"],
                ),
            )
        prediction = await predictive.predict(
            principal,
            PredictionRequest(
                prediction_type="defect_risk",
                subject_type="product_item",
                subject_id=item["id"],
            ),
        )
        assert prediction["status"] == "active"

        recommendations = await predictive.generate_recommendations(
            principal,
            _GenerateRequest([prediction["id"]]),
        )
        assert len(recommendations) == 1
        recommendation = recommendations[0]

        from ai_api.schemas.predictive import (
            RecommendationFeedbackCreate,
            RecommendationUpdate,
        )

        reviewed = await predictive.update_recommendation(
            principal,
            recommendation["id"],
            RecommendationUpdate(status="under_review"),
        )
        assert reviewed["status"] == "under_review"

        feedback = await predictive.add_recommendation_feedback(
            principal,
            recommendation["id"],
            RecommendationFeedbackCreate(
                decision="accept",
                comment="acted",
                outcome="resolved",
                risk_after=5,
            ),
        )
        assert feedback["decision"] == "accept"
        refreshed = await predictive.get_recommendation(
            principal, recommendation["id"]
        )
        assert refreshed["status"] == "accepted"
        assert refreshed["risk_reduced"] is True

        history = await predictive.list_recommendation_feedback(
            principal, recommendation["id"], limit=10
        )
        assert len(history) == 1

    _run(scenario)


def test_schedule_due_and_tenant_isolation() -> None:
    async def scenario(products, quality, predictive, repository) -> None:
        principal = _principal()
        item = await _item(products, principal, "PG-PRED-SCHED")
        from ai_api.schemas.predictive import ScheduleCreate

        schedule = await predictive.upsert_schedule(
            principal,
            ScheduleCreate(
                schedule_key="pg-daily",
                prediction_type="defect_risk",
                subject_type="product_item",
                subject_scope={"subject_ids": [item["id"]]},
                interval_seconds=60,
            ),
        )
        assert schedule["enabled"] is True

        # Force the schedule due, then run the worker entry point.
        await repository.update_predictive_schedule(
            TENANT,
            schedule["id"],
            {"next_run_at": datetime.now(UTC) - timedelta(minutes=1)},
        )
        executed = await predictive.run_due_schedules(limit=5)
        assert executed == 1

        # A different tenant must not see this tenant's feature data.
        with tenant_scope(OTHER_TENANT):
            other = _principal(OTHER_TENANT, "other")
            other_feature = await predictive.upsert_feature_definition(
                other,
                FeatureDefinitionCreate(
                    feature_key="other_feature", data_type="number"
                ),
            )
            assert other_feature["feature_key"] == "other_feature"
            rows, total = await repository.list_predictive_feature_definitions(
                OTHER_TENANT,
                entity_type=None,
                lifecycle_status=None,
                limit=50,
                offset=0,
            )
            assert total == 1
            assert all(row["feature_key"] != "pg-daily" for row in rows)

    _run(scenario)


class _GenerateRequest:
    def __init__(self, prediction_ids: list[int]) -> None:
        self.prediction_ids = prediction_ids
        self.prediction_type = None
        self.subject_type = None
        self.max_recommendations = 10
