"""Real PostgreSQL coverage for the Stage 7 knowledge graph (migration 0023).

Exercises the actual SQL repositories for entity/relationship upsert,
versioning, neighbour queries, statistics and RLS-scoped isolation.

    AI_TEST_POSTGRES=1 \\
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 \\
    POSTGRES_USER=postgres POSTGRES_PASSWORD=test POSTGRES_DB=helix \\
    pytest -o addopts="" tests/test_knowledge_graph_postgres.py
"""

from __future__ import annotations

import asyncio
import os
import socket

import pytest

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.graph_query_service import GraphQueryService
from ai_api.application.services.graph_service import GraphService
from ai_api.config.settings import get_settings
from ai_api.infrastructure.db import PostgresDatabase, system_scope, tenant_scope
from ai_api.infrastructure.repositories.postgres_ai_repository import (
    PostgresAiRepository,
)
from ai_api.schemas.graph import (
    GraphEntityCreate,
    GraphEntityUpdate,
    GraphRelationshipCreate,
)
from ai_api.security.access_control import AccessControl
from ai_api.security.policies import Principal

pytestmark = pytest.mark.integration

TENANT = 990701
OTHER_TENANT = 990702
POWER_USER = frozenset({"*:*"})


def _principal(tenant_id: int = TENANT) -> Principal:
    return Principal(
        user_id="pg-tester",
        username="pg-tester",
        tenant_id=tenant_id,
        permissions=POWER_USER,
        actor_id=7,
    )


def _requires_postgres() -> None:
    if os.environ.get("AI_TEST_POSTGRES", "") != "1":
        pytest.skip("set AI_TEST_POSTGRES=1 to run PostgreSQL graph tests")
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
            await db.execute(
                "DELETE FROM ai.graph_relationship_versions WHERE tenant_id = $1",
                tenant,
            )
            await db.execute(
                "DELETE FROM ai.graph_relationships WHERE tenant_id = $1", tenant
            )
            await db.execute(
                "DELETE FROM ai.graph_entity_versions WHERE tenant_id = $1", tenant
            )
            await db.execute(
                "DELETE FROM ai.graph_entities WHERE tenant_id = $1", tenant
            )
            await db.execute(
                "DELETE FROM ai.graph_relationship_types WHERE tenant_id = $1",
                tenant,
            )
            await db.execute(
                "DELETE FROM ai.graph_entity_types WHERE tenant_id = $1", tenant
            )


def _services(repository: AiRepository) -> tuple[GraphService, GraphQueryService]:
    audit = AuditService(repository)
    graph = GraphService(
        repository=repository,
        audit=audit,
        access=AccessControl(),
        governance=GovernanceService(repository),
        events=EventPublisher(sinks=()),
    )
    query = GraphQueryService(repository=repository, graph=graph, audit=audit)
    return graph, query


def _run(scenario) -> None:
    _requires_postgres()

    async def wrapper() -> None:
        db = await _db()
        try:
            await _cleanup(db)
            repository = PostgresAiRepository(db)
            with tenant_scope(TENANT):
                graph, query = _services(repository)
                await scenario(graph, query)
        finally:
            await _cleanup(db)
            await db.close()

    asyncio.run(wrapper())


def _entity(entity_type: str, stable_key: str, **overrides) -> GraphEntityCreate:
    return GraphEntityCreate(
        entity_type=entity_type, stable_key=stable_key, **overrides
    )


def _rel(
    relationship_type: str, source: int, target: int, **overrides
) -> GraphRelationshipCreate:
    return GraphRelationshipCreate(
        relationship_type=relationship_type,
        source_entity_id=source,
        target_entity_id=target,
        **overrides,
    )


async def _build(graph: GraphService, principal: Principal) -> dict[str, int]:
    ids: dict[str, int] = {}
    pairs = [
        ("product", "prod-1"),
        ("ebom", "ebom-1"),
        ("bom_line", "line-1"),
        ("part", "part-1"),
        ("cad_model", "cad-1"),
        ("document", "doc-1"),
        ("engineering_change", "ec-1"),
        ("plant", "plant-1"),
    ]
    for kind, key in pairs:
        entity = await graph.create_or_update_entity(
            principal, _entity(kind, key, name=key)
        )
        ids[key] = entity["id"]
    links = [
        ("has_bom", "prod-1", "ebom-1"),
        ("has_line", "ebom-1", "line-1"),
        ("contains", "prod-1", "part-1"),
        ("has_cad_model", "part-1", "cad-1"),
        ("describes", "doc-1", "part-1"),
        ("affects", "ec-1", "part-1"),
        ("manufactured_at", "part-1", "plant-1"),
    ]
    for rel_type, source, target in links:
        await graph.create_relationship(
            principal, _rel(rel_type, ids[source], ids[target])
        )
    return ids


def test_entity_upsert_is_idempotent() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        first = await graph.create_or_update_entity(
            principal, _entity("part", "PN-1", name="Bracket")
        )
        second = await graph.create_or_update_entity(
            principal, _entity("part", "pn-1", name="Bracket v2")
        )
        assert first["id"] == second["id"]
        assert second["version"] == 2
        versions = await graph.entity_versions(principal, first["id"])
        assert [row["version"] for row in versions] == [2, 1]

    _run(scenario)


def test_entity_columns_round_trip() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        entity = await graph.create_or_update_entity(
            principal,
            _entity(
                "part",
                "PN-ROUND",
                name="Round trip",
                classification="public",
                properties={"material": "steel"},
                metadata={"origin": "plm"},
                confidence=0.75,
            ),
        )
        fetched = await graph.get_entity(principal, entity["id"])
        assert fetched["classification"] == "public"
        assert fetched["properties"] == {"material": "steel"}
        assert fetched["metadata"] == {"origin": "plm"}
        assert float(fetched["confidence"]) == pytest.approx(0.75)

    _run(scenario)


def test_relationship_unique_and_neighbors() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        ids = await _build(graph, principal)
        rel = await graph.create_relationship(
            principal, _rel("contains", ids["prod-1"], ids["part-1"])
        )
        # Re-creating the same active relationship updates in place.
        again = await graph.create_relationship(
            principal, _rel("contains", ids["prod-1"], ids["part-1"])
        )
        assert rel["id"] == again["id"]
        assert again["version"] == rel["version"] + 1

        neighbors = await query.neighbors(
            principal, ids["prod-1"], direction="outgoing"
        )
        keys = {item["entity"]["stable_key"] for item in neighbors["neighbors"]}
        assert {"ebom-1", "part-1"} <= keys

    _run(scenario)


def test_invalid_relationship_type_rejected() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        ids = await _build(graph, principal)
        from ai_api.domain.errors import ValidationError

        with pytest.raises(ValidationError):
            await graph.create_relationship(
                principal, _rel("contains", ids["doc-1"], ids["prod-1"])
            )

    _run(scenario)


def test_digital_thread_and_where_used() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        ids = await _build(graph, principal)
        thread = await query.digital_thread(principal, ids["prod-1"])
        assert any(e["stable_key"] == "part-1" for e in thread["sections"]["parts"])
        assert any(e["stable_key"] == "cad-1" for e in thread["sections"]["cad_models"])

        used = await query.where_used(principal, ids["part-1"])
        used_by = {item["entity"]["stable_key"] for item in used["used_by"]}
        assert "prod-1" in used_by

    _run(scenario)


def test_traversal_respects_acl_ceiling() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        ids = await _build(graph, principal)
        await graph.update_entity(
            principal,
            ids["plant-1"],
            GraphEntityUpdate(acl={"deny_all": True}),
        )
        reader = Principal(
            user_id="reader",
            username="reader",
            tenant_id=TENANT,
            permissions=frozenset({"iam.graph.entities:read"}),
            actor_id=8,
        )
        result = await query.traverse(
            reader, ids["prod-1"], max_depth=4, limit=100
        )
        keys = {node["stable_key"] for node in result["nodes"]}
        assert "plant-1" not in keys
        assert "part-1" in keys

    _run(scenario)


def test_stats_and_type_counts() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        await _build(graph, principal)
        stats = await graph.stats(principal)
        assert stats["entities"] >= 8
        assert stats["relationships"] >= 7
        counts = {row["entity_type"]: row["total"] for row in stats["entity_type_counts"]}
        assert counts.get("part", 0) >= 1

    _run(scenario)


def test_soft_delete_archives_entity() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        entity = await graph.create_or_update_entity(
            principal, _entity("part", "PN-DEL")
        )
        await graph.delete_entity(principal, entity["id"])
        from ai_api.domain.errors import NotFoundError

        with pytest.raises(NotFoundError):
            await graph.get_entity(principal, entity["id"])

    _run(scenario)


def test_tenant_isolation_under_rls() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        entity = await graph.create_or_update_entity(
            principal, _entity("part", "PN-ISO")
        )

        async def _other_tenant() -> None:
            with tenant_scope(OTHER_TENANT):
                other_graph, other_query = _services(graph.repository)
                listing, total = await other_graph.list_entities(
                    _principal(OTHER_TENANT),
                    entity_types=None,
                    query=None,
                    lifecycle_status=None,
                    source_system=None,
                    limit=50,
                    offset=0,
                )
                assert total == 0
                assert listing == []

        await _other_tenant()
        assert (await graph.get_entity(principal, entity["id"]))["id"] == entity["id"]

    _run(scenario)


def test_bulk_ingest_persists() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        from ai_api.schemas.graph import (
            GraphBulkEntity,
            GraphBulkIngestRequest,
            GraphBulkRelationship,
        )

        payload = GraphBulkIngestRequest(
            source_system="plm",
            entities=[
                GraphBulkEntity(entity_type="product", stable_key="BP"),
                GraphBulkEntity(entity_type="part", stable_key="BPA"),
            ],
            relationships=[
                GraphBulkRelationship(
                    relationship_type="contains",
                    source_stable_key="BP",
                    target_stable_key="BPA",
                    source_entity_type="product",
                    target_entity_type="part",
                )
            ],
        )
        result = await graph.bulk_ingest(principal, payload)
        assert result["entities_created"] == 2
        assert result["relationships_created"] == 1
        again = await graph.bulk_ingest(principal, payload)
        assert again["entities_updated"] == 2

    _run(scenario)


def test_unique_constraint_prevents_duplicate_active_edges() -> None:
    async def scenario(graph, query) -> None:
        principal = _principal()
        ids = await _build(graph, principal)
        row = await graph.repository.upsert_graph_relationship(
            TENANT,
            {
                "relationship_type": "contains",
                "source_entity_id": ids["prod-1"],
                "target_entity_id": ids["part-1"],
                "properties": {},
                "confidence": 1.0,
                "source_system": None,
                "source_ref": None,
                "lifecycle_status": "active",
                "valid_from": None,
                "valid_to": None,
                "created_by": "pg-tester",
                "updated_by": "pg-tester",
            },
        )
        assert row["version"] == 2
        relationships = await graph.repository.list_graph_relationships(
            TENANT,
            entity_ids=[ids["prod-1"]],
            relationship_types=["contains"],
            direction="outgoing",
            include_inactive=False,
            limit=50,
            offset=0,
        )
        active = [r for r in relationships[0] if r["lifecycle_status"] == "active"]
        assert len(active) == 1

    _run(scenario)
