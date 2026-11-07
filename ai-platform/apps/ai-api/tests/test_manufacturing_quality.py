"""Stage 9 / Step 7: manufacturing & quality intelligence tests."""

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
READER = frozenset(
    {
        "iam.manufacturing-quality.manufacturing:read",
        "iam.manufacturing-quality.quality:read",
    }
)
WRITER = READER | {
    "iam.manufacturing-quality.manufacturing:update",
    "iam.manufacturing-quality.quality:update",
}
API = "/api/v1/ai"


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


def _plant(client: TestClient, key: str = "PLANT-1") -> dict:
    response = client.post(f"{API}/manufacturing/plants", json={"plant_key": key})
    assert response.status_code == 201, response.text
    return response.json()


def _line(client: TestClient, plant_id: int, key: str = "LINE-1") -> dict:
    response = client.post(
        f"{API}/manufacturing/lines",
        json={"plant_id": plant_id, "line_key": key},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _work_centre(client: TestClient, plant_id: int, key: str = "WC-1") -> dict:
    response = client.post(
        f"{API}/manufacturing/work-centres",
        json={"plant_id": plant_id, "work_centre_key": key},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _process(client: TestClient, key: str = "PROC-1", **overrides) -> dict:
    payload = {"process_type": "assembly", "process_key": key, **overrides}
    response = client.post(f"{API}/manufacturing/processes", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _operation(client: TestClient, process_id: int, key: str, **overrides) -> dict:
    payload = {"operation_key": key, **overrides}
    response = client.post(
        f"{API}/manufacturing/processes/{process_id}/operations", json=payload
    )
    assert response.status_code == 201, response.text
    return response.json()


def _instruction(client: TestClient, process_id: int, key: str, **overrides) -> dict:
    payload = {
        "process_id": process_id,
        "instruction_key": key,
        "title": key,
        **overrides,
    }
    response = client.post(f"{API}/manufacturing/work-instructions", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _issue(client: TestClient, key: str, **overrides) -> dict:
    payload = {"issue_key": key, "title": key, **overrides}
    response = client.post(f"{API}/quality/issues", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _manufacturing_basics(client: TestClient):
    item = _item(client, "ASM-MFG", item_type="assembly")
    plant = _plant(client)
    line = _line(client, plant["id"])
    centre = _work_centre(client, plant["id"])
    process = _process(
        client,
        "PROC-BASE",
        root_item_id=item["id"],
        plant_id=plant["id"],
        line_id=line["id"],
    )
    return item, plant, line, centre, process


# --- Manufacturing structure --------------------------------------------
def test_plant_line_work_centre_crud(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        plant = _plant(client)
        line = _line(client, plant["id"])
        centre = _work_centre(client, plant["id"])
        assert line["plant_id"] == plant["id"]
        assert centre["plant_id"] == plant["id"]

        listed = client.get(f"{API}/manufacturing/plants")
        assert listed.status_code == 200
        assert listed.json()["total"] == 1

        updated = client.patch(
            f"{API}/manufacturing/plants/{plant['id']}",
            json={"name": "Renamed"},
        )
        assert updated.status_code == 200
        assert updated.json()["name"] == "Renamed"


def test_manufacturing_lifecycle_transition_validated(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        plant = _plant(client)
        ok = client.patch(
            f"{API}/manufacturing/plants/{plant['id']}",
            json={"lifecycle_status": "obsolete"},
        )
        assert ok.status_code == 200
        bad = client.patch(
            f"{API}/manufacturing/plants/{plant['id']}",
            json={"lifecycle_status": "draft"},
        )
        assert bad.status_code == 422, bad.text


def test_process_structure_and_validation(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        _, _, _, centre, process = _manufacturing_basics(client)
        op1 = _operation(
            client, process["id"], "OP-10", sequence=10, work_centre_id=centre["id"]
        )
        _operation(
            client, process["id"], "OP-20", sequence=20, work_centre_id=centre["id"]
        )
        _instruction(client, process["id"], "WI-10", operation_id=op1["id"])

        structure = client.get(
            f"{API}/manufacturing/processes/{process['id']}/structure"
        )
        assert structure.status_code == 200, structure.text
        body = structure.json()
        assert body["total"] == 2
        rows = {row["operation_key"]: row for row in body["operations"]}
        assert rows["OP-10"]["has_instruction"] is True
        assert rows["OP-20"]["has_instruction"] is False

        validated = client.get(
            f"{API}/manufacturing/processes/{process['id']}/validate"
        )
        assert validated.status_code == 200, validated.text
        checks = {check["rule"] for check in validated.json()["checks"]}
        assert "missing_work_instruction" in checks


def test_process_compare_detects_differences(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        left = _process(client, "PROC-L")
        right = _process(client, "PROC-R")
        _operation(client, left["id"], "OP-10", sequence=10)
        _operation(client, right["id"], "OP-10", sequence=10)
        _operation(client, right["id"], "OP-20", sequence=20)
        response = client.post(
            f"{API}/manufacturing/processes/compare",
            json={"left_process_id": left["id"], "right_process_id": right["id"]},
        )
        assert response.status_code == 200, response.text
        summary = response.json()["summary"]
        assert summary["added"] == 1


def test_operation_consumption_and_production_version(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        item, plant, _, _, process = _manufacturing_basics(client)
        child = _item(client, "PN-CONS")
        op = _operation(client, process["id"], "OP-10", sequence=10)
        consumption = client.post(
            f"{API}/manufacturing/operations/{op['id']}/consumptions",
            json={"child_item_id": child["id"], "quantity": 2},
        )
        assert consumption.status_code == 201, consumption.text
        listed = client.get(
            f"{API}/manufacturing/consumptions", params={"operation_id": op["id"]}
        )
        assert listed.status_code == 200
        assert len(listed.json()) == 1

        version = client.post(
            f"{API}/manufacturing/production-versions",
            json={
                "item_id": item["id"],
                "process_id": process["id"],
                "plant_id": plant["id"],
                "version_key": "PV-1",
            },
        )
        assert version.status_code == 201, version.text
        assert version.json()["version_key"] == "pv-1"


def test_manufacturing_analytics_and_stats(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _, _, _, centre, process = _manufacturing_basics(client)
        _operation(
            client, process["id"], "OP-10", sequence=10, work_centre_id=centre["id"]
        )
        analytics = client.get(
            f"{API}/manufacturing/analytics/parts_without_instructions"
        )
        assert analytics.status_code == 200, analytics.text
        assert analytics.json()["summary"]["uncovered"] == 1
        stats = client.get(f"{API}/manufacturing/stats")
        assert stats.status_code == 200, stats.text
        assert stats.json()["processes"] == 1


# --- Quality issues ------------------------------------------------------
def test_quality_issue_lifecycle_and_references(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        item, plant, _, centre, process = _manufacturing_basics(client)
        op = _operation(client, process["id"], "OP-10", sequence=10)
        issue = _issue(
            client,
            "QI-1",
            component_item_id=item["id"],
            plant_id=plant["id"],
            work_centre_id=centre["id"],
            operation_id=op["id"],
            severity="high",
        )
        assert issue["severity"] == "high"

        bad = client.patch(
            f"{API}/quality/issues/{issue['id']}", json={"status": "closed"}
        )
        assert bad.status_code == 422, bad.text

        resolved = client.patch(
            f"{API}/quality/issues/{issue['id']}", json={"status": "resolved"}
        )
        assert resolved.status_code == 200
        assert resolved.json()["status"] == "resolved"

        trace = client.get(f"{API}/quality/issues/{issue['id']}/traceability")
        assert trace.status_code == 200, trace.text
        body = trace.json()
        assert body["component"]["id"] == item["id"]
        assert body["plant"]["id"] == plant["id"]
        assert body["operation"]["id"] == op["id"]


def test_issue_unknown_reference_rejected(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        response = client.post(
            f"{API}/quality/issues",
            json={"issue_key": "QI-BAD", "component_item_id": 999999},
        )
        assert response.status_code == 404


# --- Inspections / root causes / CAPA ------------------------------------
def test_inspection_results_and_status_transitions(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        issue = _issue(client, "QI-INSP")
        inspection = client.post(
            f"{API}/quality/inspections",
            json={
                "inspection_key": "INSP-1",
                "inspection_type": "in_process",
                "quality_issue_id": issue["id"],
            },
        )
        assert inspection.status_code == 201, inspection.text
        inspection_id = inspection.json()["id"]

        result = client.post(
            f"{API}/quality/inspections/{inspection_id}/results",
            json={"characteristic": "diameter", "result": "fail"},
        )
        assert result.status_code == 201, result.text
        listed = client.get(f"{API}/quality/inspections/{inspection_id}/results")
        assert len(listed.json()) == 1

        started = client.patch(
            f"{API}/quality/inspections/{inspection_id}",
            json={"status": "in_progress"},
        )
        assert started.status_code == 200
        failed = client.patch(
            f"{API}/quality/inspections/{inspection_id}", json={"status": "failed"}
        )
        assert failed.status_code == 200


def test_root_cause_is_not_auto_confirmed(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        issue = _issue(client, "QI-RC")
        created = client.post(
            f"{API}/quality/issues/{issue['id']}/root-causes",
            json={
                "classification": "process",
                "description": "possible tool wear",
                "is_hypothesis": True,
                "confidence": 0.4,
            },
        )
        assert created.status_code == 201, created.text
        root = created.json()
        assert root["confirmed"] is False
        assert root["is_hypothesis"] is True

        refreshed = client.get(f"{API}/quality/issues/{issue['id']}")
        assert refreshed.json()["root_cause_status"] == "hypothesis"

        confirmed = client.patch(
            f"{API}/quality/issues/{issue['id']}/root-causes/{root['id']}",
            json={"confirm": True},
        )
        assert confirmed.status_code == 200
        assert confirmed.json()["confirmed"] is True
        assert confirmed.json()["is_hypothesis"] is False
        refreshed = client.get(f"{API}/quality/issues/{issue['id']}")
        assert refreshed.json()["root_cause_status"] == "confirmed"


def test_capa_action_lifecycle_and_overdue(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        issue = _issue(client, "QI-CAPA")
        action = client.post(
            f"{API}/quality/actions",
            json={
                "quality_issue_id": issue["id"],
                "action_key": "CA-1",
                "action_type": "corrective",
                "due_at": "2020-01-01T00:00:00Z",
            },
        )
        assert action.status_code == 201, action.text
        action_id = action.json()["id"]

        implemented = client.patch(
            f"{API}/quality/actions/{action_id}", json={"status": "implemented"}
        )
        assert implemented.status_code == 200
        assert implemented.json()["implemented_at"] is not None

        verified = client.patch(
            f"{API}/quality/actions/{action_id}", json={"status": "verified"}
        )
        assert verified.status_code == 200
        assert verified.json()["verified_by"] == "tester"

        stats = client.get(f"{API}/quality/stats")
        assert stats.status_code == 200, stats.text
        assert stats.json()["actions"] == 1
        assert stats.json()["overdue_actions"] == 0


# --- Supplier quality / analytics ----------------------------------------
def _quality_dataset(client: TestClient) -> dict:
    item = _item(client, "PN-QD")
    first = _issue(
        client,
        "QI-D1",
        component_item_id=item["id"],
        supplier_ref="acme",
        failure_code="CRACK",
        severity="high",
    )
    second = _issue(
        client,
        "QI-D2",
        component_item_id=item["id"],
        supplier_ref="acme",
        failure_code="CRACK",
        severity="critical",
    )
    client.post(
        f"{API}/quality/issues/{first['id']}/supplier-issues",
        json={
            "supplier_ref": "acme",
            "supplier_name": "Acme Corp",
            "component_item_id": item["id"],
        },
    )
    return {"item": item, "first": first, "second": second}


def test_supplier_quality_and_repeat_detection(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        _quality_dataset(client)
        supplier = client.get(f"{API}/quality/supplier-quality")
        assert supplier.status_code == 200, supplier.text
        rows = supplier.json()["rows"]
        assert rows[0]["supplier_ref"] == "acme"
        assert rows[0]["supplier_name"] == "Acme Corp"
        assert rows[0]["issue_count"] == 2

        repeat = client.get(f"{API}/quality/repeat-issues")
        assert repeat.status_code == 200, repeat.text
        body = repeat.json()
        assert body["total"] == 1
        assert body["groups"][0]["occurrences"] == 2
        assert body["groups"][0]["reason"]


def test_quality_analytics_kinds(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        _quality_dataset(client)
        by_part = client.get(f"{API}/quality/analytics/issues_by_part")
        assert by_part.status_code == 200, by_part.text
        assert by_part.json()["rows"][0]["count"] == 2

        by_supplier = client.get(f"{API}/quality/analytics/defects_by_supplier")
        assert by_supplier.status_code == 200
        open_closed = client.get(f"{API}/quality/analytics/open_vs_closed")
        assert open_closed.status_code == 200
        assert open_closed.json()["summary"]["open"] == 2
        unknown = client.get(f"{API}/quality/analytics/not_a_kind")
        assert unknown.status_code == 422


# --- Authorization / tenant isolation -----------------------------------
def test_reader_cannot_write_quality(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal(permissions=READER)) as client:
        response = client.post(
            f"{API}/quality/issues", json={"issue_key": "QI-DENY"}
        )
        assert response.status_code == 403


def test_tenant_isolation_quality(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        issue = _issue(client, "QI-TENANT")
    with _client(repository, _principal(tenant_id=OTHER_TENANT)) as other:
        response = other.get(f"{API}/quality/issues/{issue['id']}")
        assert response.status_code == 404
        listed = other.get(f"{API}/quality/issues")
        assert listed.status_code == 200
        assert all(row["id"] != issue["id"] for row in listed.json()["items"])


# --- Copilot manufacturing/quality tools --------------------------------
def test_mq_tools_execute_in_process(repository: InMemoryAiRepository) -> None:
    import asyncio

    from ai_api.application.services.audit_service import AuditService
    from ai_api.application.services.enterprise_tools import (
        TOOL_MFG_PROCESS_STRUCTURE,
        TOOL_QUALITY_REPEAT,
        TOOL_QUALITY_SUPPLIER,
        TOOL_QUALITY_TRACEABILITY,
        build_enterprise_tool_client,
    )
    from ai_api.application.services.event_service import EventPublisher
    from ai_api.application.services.governance_service import GovernanceService
    from ai_api.application.services.graph_service import GraphService
    from ai_api.application.services.manufacturing_service import (
        ManufacturingService,
    )
    from ai_api.application.services.product_service import ProductService
    from ai_api.application.services.quality_service import QualityService
    from ai_api.config.settings import get_settings
    from ai_api.security.access_control import AccessControl
    from ai_api.security.policies import Policy

    with _client(repository, _principal()) as client:
        _, _, _, centre, process = _manufacturing_basics(client)
        _operation(
            client, process["id"], "OP-10", sequence=10, work_centre_id=centre["id"]
        )
        _quality_dataset(client)

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
    client = build_enterprise_tool_client(
        get_settings(),
        Policy(),
        manufacturing=manufacturing,
        quality=quality,
    )
    principal = _principal()
    with asyncio.Runner() as runner:
        structure = runner.run(
            client.run(
                principal, TOOL_MFG_PROCESS_STRUCTURE, {"process_id": process["id"]}
            )
        )
        supplier = runner.run(client.run(principal, TOOL_QUALITY_SUPPLIER, {}))
        repeat = runner.run(client.run(principal, TOOL_QUALITY_REPEAT, {}))
        trace = runner.run(
            client.run(
                principal,
                TOOL_QUALITY_TRACEABILITY,
                {"issue_id": 1},
            )
        )
    assert structure.status == "succeeded", structure.error_class
    assert supplier.status == "succeeded", supplier.error_class
    assert repeat.status == "succeeded", repeat.error_class
    assert repeat.summary["total"] >= 1
    assert trace.status == "succeeded", trace.error_class
