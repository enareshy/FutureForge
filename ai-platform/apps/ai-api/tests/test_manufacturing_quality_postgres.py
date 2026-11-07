"""Real PostgreSQL coverage for Stage 9 manufacturing & quality (0025).

Exercises the actual SQL repositories for manufacturing structure, process
operations/instructions, quality issues/inspections/CAPA and the analytics
queries, plus RLS-scoped tenant isolation.

    AI_TEST_POSTGRES=1 \\
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 \\
    POSTGRES_USER=postgres POSTGRES_PASSWORD=test POSTGRES_DB=helix \\
    pytest -o addopts="" tests/test_manufacturing_quality_postgres.py
"""

from __future__ import annotations

import asyncio
import os
import socket

import pytest

from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.graph_service import GraphService
from ai_api.application.services.manufacturing_service import ManufacturingService
from ai_api.application.services.product_service import ProductService
from ai_api.application.services.quality_service import QualityService
from ai_api.config.settings import get_settings
from ai_api.domain.errors import NotFoundError
from ai_api.infrastructure.db import PostgresDatabase, system_scope, tenant_scope
from ai_api.infrastructure.repositories.postgres_ai_repository import (
    PostgresAiRepository,
)
from ai_api.schemas.manufacturing import (
    OperationCreate,
    OperationDependencyCreate,
    PlantCreate,
    ProcessCreate,
    ProcessRevisionCreate,
    ProductionLineCreate,
    WorkCentreCreate,
    WorkInstructionCreate,
)
from ai_api.schemas.product import ProductItemCreate
from ai_api.schemas.quality import (
    InspectionCreate,
    InspectionResultCreate,
    QualityActionCreate,
    QualityActionUpdate,
    QualityIssueCreate,
    RootCauseCreate,
    RootCauseUpdate,
    SupplierIssueCreate,
)
from ai_api.security.access_control import AccessControl
from ai_api.security.policies import Principal

pytestmark = pytest.mark.integration

TENANT = 990901
OTHER_TENANT = 990902
POWER_USER = frozenset({"*:*"})


def _principal(tenant_id: int = TENANT) -> Principal:
    return Principal(
        user_id="pg-mq",
        username="pg-mq",
        tenant_id=tenant_id,
        permissions=POWER_USER,
        actor_id=7,
    )


def _requires_postgres() -> None:
    if os.environ.get("AI_TEST_POSTGRES", "") != "1":
        pytest.skip("set AI_TEST_POSTGRES=1 to run PostgreSQL manufacturing tests")
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
                "quality_supplier_issues",
                "quality_root_causes",
                "quality_inspection_results",
                "quality_actions",
                "quality_inspections",
                "quality_issues",
                "mfg_production_versions",
                "mfg_resources",
                "mfg_work_instructions",
                "mfg_operation_consumptions",
                "mfg_operation_dependencies",
                "mfg_operations",
                "mfg_process_revisions",
                "mfg_processes",
                "mfg_work_centres",
                "mfg_production_lines",
                "mfg_plants",
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
    graph = GraphService(
        repository=repository,
        audit=audit,
        access=AccessControl(),
        governance=GovernanceService(repository),
        events=EventPublisher(sinks=()),
    )
    products = ProductService(
        repository=repository,
        audit=audit,
        access=AccessControl(),
        governance=GovernanceService(repository),
        graph=graph,
        events=EventPublisher(sinks=()),
    )
    manufacturing = ManufacturingService(
        repository=repository,
        products=products,
        audit=audit,
        access=AccessControl(),
        governance=GovernanceService(repository),
        graph=graph,
        events=EventPublisher(sinks=()),
    )
    quality = QualityService(
        repository=repository,
        products=products,
        manufacturing=manufacturing,
        audit=audit,
        access=AccessControl(),
        governance=GovernanceService(repository),
        graph=graph,
        events=EventPublisher(sinks=()),
    )
    return products, manufacturing, quality


def _run(scenario) -> None:
    _requires_postgres()

    async def wrapper() -> None:
        db = await _db()
        try:
            await _cleanup(db)
            repository = PostgresAiRepository(db)
            with tenant_scope(TENANT):
                products, manufacturing, quality = _services(repository)
                await scenario(products, manufacturing, quality, repository)
        finally:
            await _cleanup(db)
            await db.close()

    asyncio.run(wrapper())


async def _item(products, principal, key, item_type="part"):
    return await products.create_or_update_item(
        principal,
        ProductItemCreate(item_type=item_type, item_key=key, name=key),
    )


async def _basics(manufacturing, products, principal):
    item = await _item(products, principal, "PG-MFG-ASM", "assembly")
    plant = await manufacturing.upsert_plant(
        principal, PlantCreate(plant_key="PG-PLANT")
    )
    line = await manufacturing.upsert_line(
        principal,
        ProductionLineCreate(plant_id=plant["id"], line_key="PG-LINE"),
    )
    centre = await manufacturing.upsert_work_centre(
        principal,
        WorkCentreCreate(plant_id=plant["id"], work_centre_key="PG-WC"),
    )
    process = await manufacturing.upsert_process(
        principal,
        ProcessCreate(
            process_key="PG-PROC",
            root_item_id=item["id"],
            plant_id=plant["id"],
            line_id=line["id"],
        ),
    )
    return item, plant, line, centre, process


def test_manufacturing_structure_round_trip() -> None:
    async def scenario(products, manufacturing, quality, repository) -> None:
        principal = _principal()
        item, plant, _, centre, process = await _basics(
            manufacturing, products, principal
        )
        revision = await manufacturing.upsert_process_revision(
            principal, process["id"], ProcessRevisionCreate(revision="B")
        )
        assert revision["revision"] == "B"

        op1 = await manufacturing.upsert_operation(
            principal,
            process["id"],
            OperationCreate(
                operation_key="OP-10",
                sequence=10,
                work_centre_id=centre["id"],
                process_revision_id=revision["id"],
            ),
        )
        op2 = await manufacturing.upsert_operation(
            principal,
            process["id"],
            OperationCreate(
                operation_key="OP-20", sequence=20, work_centre_id=centre["id"]
            ),
        )
        dependency = await manufacturing.add_dependency(
            principal,
            process["id"],
            OperationDependencyCreate(
                operation_id=op2["id"],
                depends_on_operation_id=op1["id"],
            ),
        )
        assert dependency["operation_id"] == op2["id"]

        instruction = await manufacturing.upsert_instruction(
            principal,
            WorkInstructionCreate(
                process_id=process["id"],
                operation_id=op1["id"],
                instruction_key="PG-WI",
                title="PG-WI",
            ),
        )
        assert instruction["operation_id"] == op1["id"]

        structure = await manufacturing.structure(principal, process["id"])
        assert structure["total"] == 2
        rows = {row["operation_key"]: row for row in structure["operations"]}
        assert rows["OP-10"]["has_instruction"] is True
        assert rows["OP-20"]["has_instruction"] is False

        again = await manufacturing.upsert_process(
            principal,
            ProcessCreate(
                process_key="PG-PROC",
                root_item_id=item["id"],
                plant_id=plant["id"],
            ),
        )
        assert again["id"] == process["id"]
        assert again["version"] >= 2

    _run(scenario)


def test_manufacturing_validation_and_stats() -> None:
    async def scenario(products, manufacturing, quality, repository) -> None:
        principal = _principal()
        _, _, _, centre, process = await _basics(manufacturing, products, principal)
        await manufacturing.upsert_operation(
            principal,
            process["id"],
            OperationCreate(
                operation_key="OP-10", sequence=10, work_centre_id=centre["id"]
            ),
        )
        validation = await manufacturing.validate(principal, process["id"])
        rules = {check["rule"] for check in validation["checks"]}
        assert "missing_work_instruction" in rules
        stats = await manufacturing.stats(principal)
        assert stats["processes"] == 1
        analytics = await manufacturing.analytics(
            principal, "parts_without_instructions"
        )
        assert analytics["summary"]["uncovered"] == 1

    _run(scenario)


def test_quality_issue_inspection_capa_round_trip() -> None:
    async def scenario(products, manufacturing, quality, repository) -> None:
        principal = _principal()
        item, plant, _, centre, process = await _basics(
            manufacturing, products, principal
        )
        operation = await manufacturing.upsert_operation(
            principal,
            process["id"],
            OperationCreate(operation_key="OP-10", sequence=10),
        )
        issue = await quality.upsert_issue(
            principal,
            QualityIssueCreate(
                issue_key="PG-QI-1",
                title="PG-QI-1",
                component_item_id=item["id"],
                plant_id=plant["id"],
                work_centre_id=centre["id"],
                operation_id=operation["id"],
                supplier_ref="acme",
                failure_code="CRACK",
            ),
        )
        assert issue["issue_key"] == "PG-QI-1"

        root = await quality.add_root_cause(
            principal,
            issue["id"],
            RootCauseCreate(
                classification="process", description="tool wear", confidence=0.3
            ),
        )
        assert root["confirmed"] is False
        confirmed = await quality.update_root_cause(
            principal,
            issue["id"],
            root["id"],
            RootCauseUpdate(confirm=True),
        )
        assert confirmed["confirmed"] is True

        inspection = await quality.upsert_inspection(
            principal,
            InspectionCreate(
                inspection_key="PG-INSP",
                inspection_type="in_process",
                quality_issue_id=issue["id"],
            ),
        )
        result = await quality.add_inspection_result(
            principal,
            inspection["id"],
            InspectionResultCreate(characteristic="diameter", result="fail"),
        )
        assert result["result"] == "fail"

        action = await quality.upsert_action(
            principal,
            QualityActionCreate(
                quality_issue_id=issue["id"],
                action_key="PG-CA",
                action_type="corrective",
            ),
        )
        implemented = await quality.update_action(
            principal,
            action["id"],
            QualityActionUpdate(status="implemented"),
        )
        assert implemented["implemented_at"] is not None

        trace = await quality.traceability(principal, issue["id"])
        assert trace["component"]["id"] == item["id"]
        assert trace["operation"]["id"] == operation["id"]

    _run(scenario)


def test_quality_analytics_and_supplier_quality() -> None:
    async def scenario(products, manufacturing, quality, repository) -> None:
        principal = _principal()
        item = await _item(products, principal, "PG-Q-ITEM")
        first = await quality.upsert_issue(
            principal,
            QualityIssueCreate(
                issue_key="PG-Q1",
                component_item_id=item["id"],
                supplier_ref="acme",
                failure_code="CRACK",
                severity="high",
            ),
        )
        await quality.upsert_issue(
            principal,
            QualityIssueCreate(
                issue_key="PG-Q2",
                component_item_id=item["id"],
                supplier_ref="acme",
                failure_code="CRACK",
                severity="critical",
            ),
        )
        await quality.add_supplier_issue(
            principal,
            first["id"],
            SupplierIssueCreate(
                supplier_ref="acme", supplier_name="Acme", component_item_id=item["id"]
            ),
        )
        supplier = await quality.supplier_quality(principal)
        assert supplier["rows"][0]["supplier_ref"] == "acme"
        assert supplier["rows"][0]["issue_count"] == 2

        repeat = await quality.repeat_issues(principal)
        assert repeat["total"] == 1
        assert repeat["groups"][0]["occurrences"] == 2

        by_part = await quality.analytics(principal, "issues_by_part")
        assert by_part["rows"][0]["count"] == 2
        stats = await quality.stats(principal)
        assert stats["issues"] == 2

    _run(scenario)


def test_tenant_isolation_manufacturing_quality() -> None:
    async def scenario(products, manufacturing, quality, repository) -> None:
        principal = _principal()
        issue = await quality.upsert_issue(
            principal, QualityIssueCreate(issue_key="PG-ISO-QI")
        )
        plant = await manufacturing.upsert_plant(
            principal, PlantCreate(plant_key="PG-ISO-PLANT")
        )
        other = _principal(OTHER_TENANT)
        with pytest.raises(NotFoundError):
            await quality.get_issue(other, issue["id"])
        with pytest.raises(NotFoundError):
            await manufacturing.get_plant(other, plant["id"])

        rows, _ = await repository.list_quality_issues(
            OTHER_TENANT,
            status=None,
            severity=None,
            issue_type=None,
            component_item_id=None,
            product_item_id=None,
            supplier_ref=None,
            plant_id=None,
            operation_id=None,
            query=None,
            limit=50,
            offset=0,
        )
        assert all(row["id"] != issue["id"] for row in rows)
        plants, _ = await repository.list_mfg_plants(
            OTHER_TENANT, query=None, lifecycle_status=None, limit=50, offset=0
        )
        assert all(row["id"] != plant["id"] for row in plants)

    _run(scenario)
