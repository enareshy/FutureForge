"""Real PostgreSQL coverage for Stage 8 product & BOM intelligence (0024).

Exercises the actual SQL repositories for item/revision upsert, BOM headers and
lines, structure expansion, comparison, transformation/reconciliation and the
intelligence queries, plus RLS-scoped tenant isolation.

    AI_TEST_POSTGRES=1 \\
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 \\
    POSTGRES_USER=postgres POSTGRES_PASSWORD=test POSTGRES_DB=helix \\
    pytest -o addopts="" tests/test_product_bom_postgres.py
"""

from __future__ import annotations

import asyncio
import os
import socket

import pytest

from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.bom_service import BomService
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.graph_query_service import GraphQueryService
from ai_api.application.services.graph_service import GraphService
from ai_api.application.services.product_service import ProductService
from ai_api.config.settings import get_settings
from ai_api.domain.errors import NotFoundError
from ai_api.infrastructure.db import PostgresDatabase, system_scope, tenant_scope
from ai_api.infrastructure.repositories.postgres_ai_repository import (
    PostgresAiRepository,
)
from ai_api.schemas.product import (
    BomHeaderCreate,
    BomLineCreate,
    ProductItemCreate,
    ProductRevisionCreate,
)
from ai_api.security.access_control import AccessControl
from ai_api.security.policies import Principal

pytestmark = pytest.mark.integration

TENANT = 990801
OTHER_TENANT = 990802
POWER_USER = frozenset({"*:*"})


def _principal(tenant_id: int = TENANT) -> Principal:
    return Principal(
        user_id="pg-bom",
        username="pg-bom",
        tenant_id=tenant_id,
        permissions=POWER_USER,
        actor_id=7,
    )


def _requires_postgres() -> None:
    if os.environ.get("AI_TEST_POSTGRES", "") != "1":
        pytest.skip("set AI_TEST_POSTGRES=1 to run PostgreSQL product tests")
    settings = get_settings()
    try:
        with socket.create_connection((settings.postgres_host, settings.postgres_port), timeout=1):
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
                "bom_reconciliations",
                "bom_transformation_entries",
                "bom_transformation_runs",
                "bom_lines",
                "bom_headers",
                "product_revisions",
                "product_items",
                "graph_relationship_versions",
                "graph_relationships",
                "graph_entity_versions",
                "graph_entities",
            ):
                await db.execute(f"DELETE FROM ai.{table} WHERE tenant_id = $1", tenant)


def _services(repository):
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
    return products, boms


def _run(scenario) -> None:
    _requires_postgres()

    async def wrapper() -> None:
        db = await _db()
        try:
            await _cleanup(db)
            repository = PostgresAiRepository(db)
            with tenant_scope(TENANT):
                products, boms = _services(repository)
                await scenario(products, boms, repository)
        finally:
            await _cleanup(db)
            await db.close()

    asyncio.run(wrapper())


async def _item(products, principal, key, item_type="part"):
    return await products.create_or_update_item(
        principal,
        ProductItemCreate(item_type=item_type, item_key=key, name=key),
    )


async def _revision(products, principal, item_id, revision="A"):
    return await products.create_or_update_revision(
        principal, item_id, ProductRevisionCreate(revision=revision)
    )


async def _bom(products, principal, key, bom_type="EBOM", root_item=None, root_rev=None):
    return await products.create_or_update_header(
        principal,
        BomHeaderCreate(
            bom_type=bom_type,
            bom_key=key,
            root_item_id=root_item,
            root_revision_id=root_rev,
        ),
    )


async def _line(products, principal, header_id, parent_rev, child_item, **overrides):
    payload = {
        "parent_revision_id": parent_rev,
        "child_item_id": child_item,
    }
    payload.update(overrides)
    return await products.create_line(principal, header_id, BomLineCreate(**payload))


def test_item_round_trip_and_upsert() -> None:
    async def scenario(products, boms, repository) -> None:
        principal = _principal()
        item = await _item(products, principal, "PG-PN-1")
        again = await _item(products, principal, "PG-PN-1")
        assert item["id"] == again["id"]
        fetched = await products.get_item(principal, item["id"])
        assert fetched["item_key"] == "PG-PN-1"

    _run(scenario)


def test_structure_and_compare() -> None:
    async def scenario(products, boms, repository) -> None:
        principal = _principal()
        parent = await _item(products, principal, "PG-ASM", "assembly")
        parent_rev = await _revision(products, principal, parent["id"])
        child = await _item(products, principal, "PG-CHILD")
        header = await _bom(
            products,
            principal,
            "PG-EBOM",
            root_item=parent["id"],
            root_rev=parent_rev["id"],
        )
        await _line(products, principal, header["id"], parent_rev["id"], child["id"], quantity=2)
        structure = await boms.structure(principal, header["id"], max_depth=5)
        assert structure["total"] == 1
        assert structure["rows"][0]["quantity"] == 2.0

        right = await _bom(
            products,
            principal,
            "PG-EBOM-R",
            root_item=parent["id"],
            root_rev=parent_rev["id"],
        )
        await _line(products, principal, right["id"], parent_rev["id"], child["id"], quantity=2)
        diff = await boms.compare(principal, header["id"], right["id"])
        assert diff["summary"]["added"] == 0
        assert diff["summary"]["removed"] == 0

    _run(scenario)


def test_transform_and_reconcile() -> None:
    async def scenario(products, boms, repository) -> None:
        principal = _principal()
        parent = await _item(products, principal, "PG-ASM-X", "assembly")
        parent_rev = await _revision(products, principal, parent["id"])
        child = await _item(products, principal, "PG-CHILD-X")
        ebom = await _bom(
            products, principal, "PG-EBOM-X", root_item=parent["id"], root_rev=parent_rev["id"]
        )
        mbom = await _bom(
            products,
            principal,
            "PG-MBOM-X",
            bom_type="MBOM",
            root_item=parent["id"],
            root_rev=parent_rev["id"],
        )
        await _line(products, principal, ebom["id"], parent_rev["id"], child["id"])
        await _line(products, principal, mbom["id"], parent_rev["id"], child["id"])

        dry = await boms.transform(
            principal, source_header_id=ebom["id"], target_header_id=mbom["id"], mode="DRY_RUN"
        )
        assert dry["mode"] == "DRY_RUN"
        assert dry["id"] is None

        executed = await boms.transform(
            principal, source_header_id=ebom["id"], target_header_id=mbom["id"], mode="EXECUTE"
        )
        assert executed["id"] is not None

        reconciliation = await boms.reconcile(
            principal, source_header_id=ebom["id"], target_header_id=mbom["id"]
        )
        assert reconciliation["status"] == "matched"

    _run(scenario)


def test_tenant_isolation() -> None:
    async def scenario(products, boms, repository) -> None:
        principal = _principal()
        item = await _item(products, principal, "PG-ISO")
        other = _principal(OTHER_TENANT)
        with pytest.raises(NotFoundError):
            await products.get_item(other, item["id"])
        rows, _ = await repository.list_product_items(
            OTHER_TENANT,
            item_types=None,
            query=None,
            lifecycle_status=None,
            limit=50,
            offset=0,
        )
        assert all(row["id"] != item["id"] for row in rows)

    _run(scenario)
