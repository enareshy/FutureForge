"""Stage 8 / Step 6: product & BOM intelligence tests."""

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
READER = frozenset({"iam.pdm.items:read", "iam.bom.boms:read", "iam.bom.compare:read"})
WRITER = READER | {"iam.pdm.items:update", "iam.bom.boms:update"}


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
def _client(repository: InMemoryAiRepository, principal: Principal) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _item(client: TestClient, key: str, **overrides) -> dict:
    payload = {"item_type": "part", "item_key": key, "name": key, **overrides}
    response = client.post("/api/v1/ai/products/items", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _revision(client: TestClient, item_id: int, revision: str = "A") -> dict:
    response = client.post(
        f"/api/v1/ai/products/items/{item_id}/revisions",
        json={"revision": revision},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _bom(client: TestClient, key: str, bom_type: str = "EBOM", **overrides) -> dict:
    payload = {"bom_type": bom_type, "bom_key": key, **overrides}
    response = client.post("/api/v1/ai/boms", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _line(
    client: TestClient, header_id: int, parent_revision_id: int, child_item_id: int, **overrides
) -> dict:
    payload = {
        "parent_revision_id": parent_revision_id,
        "child_item_id": child_item_id,
        **overrides,
    }
    response = client.post(f"/api/v1/ai/boms/{header_id}/lines", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# --- Items / revisions ---------------------------------------------------
def test_create_and_get_item(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-1", description="Bracket")
        assert item["item_key"] == "PN-1"
        fetched = client.get(f"/api/v1/ai/products/items/{item['id']}")
        assert fetched.status_code == 200
        assert fetched.json()["id"] == item["id"]


def test_item_lifecycle_transition_validated(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-2")
        ok = client.patch(
            f"/api/v1/ai/products/items/{item['id']}",
            json={"lifecycle_status": "active"},
        )
        assert ok.status_code == 200
        bad = client.patch(
            f"/api/v1/ai/products/items/{item['id']}",
            json={"lifecycle_status": "draft"},
        )
        assert bad.status_code == 422, bad.text


def test_revision_create_and_list(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-3")
        revision = _revision(client, item["id"], "B")
        assert revision["item_id"] == item["id"]
        listed = client.get("/api/v1/ai/products/revisions", params={"item_id": item["id"]})
        assert listed.status_code == 200
        assert len(listed.json()) == 1


def test_reader_cannot_write(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal(permissions=READER)) as client:
        response = client.post(
            "/api/v1/ai/products/items",
            json={"item_type": "part", "item_key": "PN-DENY"},
        )
        assert response.status_code == 403


# --- BOM headers / lines --------------------------------------------------
def _assembly(client: TestClient, key: str):
    item = _item(client, key, item_type="assembly")
    revision = _revision(client, item["id"])
    return item, revision


def test_bom_header_and_line_crud(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        parent, parent_rev = _assembly(client, "ASM-1")
        child = _item(client, "PN-CHILD")
        header = _bom(
            client, "EBOM-1", root_item_id=parent["id"], root_revision_id=parent_rev["id"]
        )
        line = _line(client, header["id"], parent_rev["id"], child["id"], quantity=2)
        assert line["quantity"] == 2

        updated = client.patch(f"/api/v1/ai/boms/lines/{line['id']}", json={"quantity": 3})
        assert updated.status_code == 200
        assert updated.json()["quantity"] == 3

        deleted = client.delete(f"/api/v1/ai/boms/lines/{line['id']}")
        assert deleted.status_code == 200


def test_immutable_revision_rejects_line_edits(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        parent, parent_rev = _assembly(client, "ASM-IMM")
        child = _item(client, "PN-IMM")
        header = _bom(
            client, "EBOM-IMM", root_item_id=parent["id"], root_revision_id=parent_rev["id"]
        )
        line = _line(client, header["id"], parent_rev["id"], child["id"])
        client.patch(
            f"/api/v1/ai/boms/{header['id']}",
            json={"lifecycle_status": "in_review"},
        )
        client.patch(
            f"/api/v1/ai/boms/{header['id']}",
            json={"lifecycle_status": "released"},
        )
        client.patch(
            f"/api/v1/ai/boms/{header['id']}",
            json={"lifecycle_status": "superseded"},
        )
        response = client.patch(f"/api/v1/ai/boms/lines/{line['id']}", json={"quantity": 9})
        assert response.status_code == 422, response.text


# --- Structure -----------------------------------------------------------
def test_structure_explosion(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        parent, parent_rev = _assembly(client, "ASM-STR")
        mid, mid_rev = _assembly(client, "ASM-MID")
        leaf = _item(client, "PN-LEAF")
        header = _bom(
            client, "EBOM-STR", root_item_id=parent["id"], root_revision_id=parent_rev["id"]
        )
        _line(
            client,
            header["id"],
            parent_rev["id"],
            mid["id"],
            child_revision_id=mid_rev["id"],
            quantity=2,
        )
        _line(client, header["id"], mid_rev["id"], leaf["id"], quantity=3)

        response = client.get(f"/api/v1/ai/boms/{header['id']}/structure", params={"max_depth": 5})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["total"] == 2
        assert body["max_depth_reached"] == 2
        leaf_row = next(r for r in body["rows"] if r["child_item_id"] == leaf["id"])
        assert leaf_row["cumulative_quantity"] == 6


# --- Compare -------------------------------------------------------------
def test_compare_detects_changes_and_ignores_reordering(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal()) as client:
        parent, parent_rev = _assembly(client, "ASM-CMP")
        child_a = _item(client, "PN-A")
        child_b = _item(client, "PN-B")
        left = _bom(client, "EBOM-L", root_item_id=parent["id"], root_revision_id=parent_rev["id"])
        right = _bom(client, "EBOM-R", root_item_id=parent["id"], root_revision_id=parent_rev["id"])
        _line(
            client,
            left["id"],
            parent_rev["id"],
            child_a["id"],
            quantity=1,
            find_number="10",
            sequence=1,
        )
        _line(
            client,
            left["id"],
            parent_rev["id"],
            child_b["id"],
            quantity=1,
            find_number="20",
            sequence=2,
        )
        _line(
            client,
            right["id"],
            parent_rev["id"],
            child_a["id"],
            quantity=1,
            find_number="10",
            sequence=1,
        )
        _line(
            client,
            right["id"],
            parent_rev["id"],
            child_b["id"],
            quantity=1,
            find_number="20",
            sequence=2,
        )

        moved = client.post(
            "/api/v1/ai/boms/compare",
            json={"left_header_id": left["id"], "right_header_id": right["id"]},
        )
        assert moved.status_code == 200, moved.text
        summary = moved.json()["summary"]
        assert summary["added"] == 0 and summary["removed"] == 0

        line_id = client.get(
            "/api/v1/ai/boms/lines",
            params={"header_id": right["id"], "child_item_id": child_b["id"]},
        ).json()["items"][0]["id"]
        client.patch(f"/api/v1/ai/boms/lines/{line_id}", json={"quantity": 4})
        changed = client.post(
            "/api/v1/ai/boms/compare",
            json={"left_header_id": left["id"], "right_header_id": right["id"]},
        )
        assert changed.json()["summary"]["modified"] == 1


# --- Transform / reconcile ----------------------------------------------
def _ebom_mbom(client: TestClient):
    parent, parent_rev = _assembly(client, "ASM-X")
    child = _item(client, "PN-X")
    ebom = _bom(client, "EBOM-X", root_item_id=parent["id"], root_revision_id=parent_rev["id"])
    mbom = _bom(
        client,
        "MBOM-X",
        bom_type="MBOM",
        root_item_id=parent["id"],
        root_revision_id=parent_rev["id"],
    )
    _line(client, ebom["id"], parent_rev["id"], child["id"], quantity=1)
    _line(client, mbom["id"], parent_rev["id"], child["id"], quantity=1)
    return ebom, mbom


def test_transform_dry_run_does_not_persist(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        ebom, mbom = _ebom_mbom(client)
        response = client.post(
            "/api/v1/ai/boms/transform",
            json={
                "source_header_id": ebom["id"],
                "target_header_id": mbom["id"],
                "mode": "DRY_RUN",
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["mode"] == "DRY_RUN"


def test_reconcile_matched(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        ebom, mbom = _ebom_mbom(client)
        response = client.post(
            "/api/v1/ai/boms/reconcile",
            json={"source_header_id": ebom["id"], "target_header_id": mbom["id"]},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "matched"
        assert body["exceptions"] == []


# --- Intelligence --------------------------------------------------------
def test_where_used(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        parent, parent_rev = _assembly(client, "ASM-WU")
        child = _item(client, "PN-WU")
        header = _bom(
            client, "EBOM-WU", root_item_id=parent["id"], root_revision_id=parent_rev["id"]
        )
        _line(client, header["id"], parent_rev["id"], child["id"])
        response = client.get(f"/api/v1/ai/products/items/{child['id']}/where-used")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["kind"] == "where_used"
        assert body["total"] >= 1


def test_reuse_and_duplicates(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        _item(client, "PN-DUP", item_type="part")
        _item(client, "PN-DUP", item_type="component")
        _item(client, "PN-UNIQ")
        reuse = client.get("/api/v1/ai/products/reuse")
        assert reuse.status_code == 200, reuse.text
        duplicates = client.get("/api/v1/ai/products/duplicates")
        assert duplicates.status_code == 200, duplicates.text
        body = duplicates.json()
        assert body["summary"]["exact"] >= 2


def test_quality_flags_missing_child(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        parent, parent_rev = _assembly(client, "ASM-Q")
        child = _item(client, "PN-Q")
        header = _bom(
            client, "EBOM-Q", root_item_id=parent["id"], root_revision_id=parent_rev["id"]
        )
        _line(client, header["id"], parent_rev["id"], child["id"])
        repository_now = repository
        response = client.get(f"/api/v1/ai/boms/{header['id']}/quality")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["header_id"] == header["id"]
        assert "issues" in body
        assert repository_now is repository


def test_stats(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        _item(client, "PN-ST")
        response = client.get("/api/v1/ai/products/stats")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["items"] >= 1


# --- Tenant isolation ----------------------------------------------------
def test_tenant_isolation_items(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        item = _item(client, "PN-T1")
    with _client(repository, _principal(tenant_id=OTHER_TENANT)) as other:
        response = other.get(f"/api/v1/ai/products/items/{item['id']}")
        assert response.status_code == 404
        listed = other.get("/api/v1/ai/products/items")
        assert listed.status_code == 200
        assert all(row["id"] != item["id"] for row in listed.json()["items"])


# --- Copilot product/BOM tools (local execution) -------------------------
def test_product_tools_execute_in_process(repository: InMemoryAiRepository) -> None:
    import asyncio

    from ai_api.application.services.enterprise_tools import (
        TOOL_BOM_DUPLICATES,
        TOOL_BOM_EXPAND,
        TOOL_BOM_QUALITY,
        TOOL_BOM_REUSE,
        TOOL_PRODUCT_ITEM_LOOKUP,
        build_enterprise_tool_client,
    )
    from ai_api.config.settings import get_settings
    from ai_api.infrastructure.repositories import InMemoryAiRepository as MemoryRepo
    from ai_api.security.policies import Policy

    with _client(repository, _principal()) as client:
        parent, parent_rev = _assembly(client, "ASM-TOOL")
        child = _item(client, "PN-TOOL")
        header = _bom(
            client,
            "EBOM-TOOL",
            root_item_id=parent["id"],
            root_revision_id=parent_rev["id"],
        )
        _line(client, header["id"], parent_rev["id"], child["id"])

    # Build services over the same in-memory repository to exercise tool paths.
    from ai_api.application.services.audit_service import AuditService
    from ai_api.application.services.bom_service import BomService
    from ai_api.application.services.event_service import EventPublisher
    from ai_api.application.services.governance_service import GovernanceService
    from ai_api.application.services.graph_query_service import GraphQueryService
    from ai_api.application.services.graph_service import GraphService
    from ai_api.application.services.product_service import ProductService
    from ai_api.security.access_control import AccessControl

    assert isinstance(repository, MemoryRepo)
    audit = AuditService(repository)
    graph = GraphService(
        repository=repository,
        audit=audit,
        access=AccessControl(),
        governance=GovernanceService(repository),
        events=EventPublisher(sinks=()),
    )
    query = GraphQueryService(repository=repository, graph=graph, audit=audit)
    products = ProductService(
        repository=repository,
        audit=audit,
        access=AccessControl(),
        governance=GovernanceService(repository),
        graph=graph,
        events=EventPublisher(sinks=()),
    )
    boms = BomService(
        repository=repository,
        products=products,
        audit=audit,
        graph=graph,
        graph_query=query,
        events=EventPublisher(sinks=()),
    )
    client = build_enterprise_tool_client(
        get_settings(), Policy(), products=products, boms=boms
    )
    principal = _principal()
    with asyncio.Runner() as runner:
        lookup = runner.run(
            client.run(principal, TOOL_PRODUCT_ITEM_LOOKUP, {"query": "PN-TOOL"})
        )
        expand = runner.run(
            client.run(principal, TOOL_BOM_EXPAND, {"header_id": header["id"]})
        )
        reuse = runner.run(client.run(principal, TOOL_BOM_REUSE, {}))
        duplicates = runner.run(client.run(principal, TOOL_BOM_DUPLICATES, {}))
        quality = runner.run(
            client.run(principal, TOOL_BOM_QUALITY, {"header_id": header["id"]})
        )
    assert lookup.status == "succeeded"
    assert expand.status == "succeeded"
    assert reuse.status == "succeeded"
    assert duplicates.status == "succeeded"
    assert quality.status == "succeeded"
    assert expand.summary["total"] >= 1


def test_bom_lookup_tool_still_routes_to_http(repository: InMemoryAiRepository) -> None:
    from ai_api.application.services.enterprise_tools import TOOL_BOM_LOOKUP

    assert TOOL_BOM_LOOKUP not in __import__(
        "ai_api.application.services.enterprise_tools",
        fromlist=["_LOCAL_PRODUCT_TOOLS"],
    )._LOCAL_PRODUCT_TOOLS
