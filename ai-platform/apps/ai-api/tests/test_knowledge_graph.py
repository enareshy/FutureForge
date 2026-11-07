"""Stage 7: enterprise knowledge graph, traversal and digital thread tests."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.graph_query_service import GraphQueryService
from ai_api.application.services.graph_service import GraphService
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.access_control import AccessControl
from ai_api.security.policies import Principal

TENANT = 1
OTHER_TENANT = 2
POWER_USER = frozenset({"*:*"})
READER = frozenset({"iam.graph.entities:read"})
WRITER = frozenset({"iam.graph.entities:read", "iam.graph.entities:update"})


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


def _services(
    repository: InMemoryAiRepository,
) -> tuple[GraphService, GraphQueryService]:
    audit = AuditService(repository)
    access = AccessControl()
    governance = GovernanceService(repository)
    graph = GraphService(
        repository=repository,
        audit=audit,
        access=access,
        governance=governance,
        events=EventPublisher(sinks=()),
    )
    query = GraphQueryService(repository=repository, graph=graph, audit=audit)
    return graph, query


def _build_product_graph(
    graph: GraphService, principal: Principal
) -> dict[str, int]:
    import asyncio

    ids: dict[str, int] = {}
    for kind, key in [
        ("product", "prod-1"),
        ("ebom", "ebom-1"),
        ("bom_line", "line-1"),
        ("part", "part-1"),
        ("part", "part-2"),
        ("cad_model", "cad-1"),
        ("document", "doc-1"),
        ("engineering_change", "ec-1"),
        ("release", "rel-1"),
        ("plant", "plant-1"),
    ]:
        entity = asyncio.run(
            graph.create_or_update_entity(principal, _make_payload(kind, key))
        )
        ids[key] = entity["id"]
    return ids


def _make_payload(entity_type: str, stable_key: str, **overrides):
    from ai_api.schemas.graph import GraphEntityCreate

    return GraphEntityCreate(
        entity_type=entity_type, stable_key=stable_key, **overrides
    )


def _rel(relationship_type: str, source: int, target: int, **overrides):
    from ai_api.schemas.graph import GraphRelationshipCreate

    return GraphRelationshipCreate(
        relationship_type=relationship_type,
        source_entity_id=source,
        target_entity_id=target,
        **overrides,
    )


# --- Type registry -------------------------------------------------------


def test_graph_types_catalog(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        response = client.get("/api/v1/ai/graph/types")
        assert response.status_code == 200
        body = response.json()
        entity_codes = {item["code"] for item in body["entity_types"]}
        relationship_codes = {item["code"] for item in body["relationship_types"]}
        assert {"product", "part", "ebom", "engineering_change", "release"} <= (
            entity_codes
        )
        assert {"contains", "affects", "results_in", "satisfied_by"} <= (
            relationship_codes
        )
        assert all(item["builtin"] for item in body["entity_types"])


def test_entity_type_requires_write_capability(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal(permissions=READER)) as client:
        response = client.post(
            "/api/v1/ai/graph/entity-types",
            json={"code": "tool", "name": "Tool"},
        )
        assert response.status_code == 403


# --- Entity CRUD ---------------------------------------------------------


def test_create_and_fetch_entity(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal(permissions=WRITER)) as client:
        created = client.post(
            "/api/v1/ai/graph/entities",
            json={
                "entity_type": "part",
                "stable_key": "PN-100",
                "name": "Bracket",
                "properties": {"material": "steel"},
            },
        )
        assert created.status_code == 201
        entity = created.json()
        assert entity["entity_type"] == "part"
        assert entity["stable_key"] == "pn-100"
        assert entity["version"] == 1

        fetched = client.get(f"/api/v1/ai/graph/entities/{entity['id']}")
        assert fetched.status_code == 200
        assert fetched.json()["name"] == "Bracket"


def test_upsert_is_idempotent_and_versions(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal(permissions=WRITER)) as client:
        first = client.post(
            "/api/v1/ai/graph/entities",
            json={"entity_type": "part", "stable_key": "PN-1", "name": "A"},
        ).json()
        second = client.post(
            "/api/v1/ai/graph/entities",
            json={"entity_type": "part", "stable_key": "pn-1", "name": "A2"},
        ).json()
        assert first["id"] == second["id"]
        assert second["version"] == 2
        versions = client.get(
            f"/api/v1/ai/graph/entities/{first['id']}/versions"
        ).json()
        assert [v["version"] for v in versions] == [2, 1]


def test_unknown_entity_type_rejected(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal(permissions=WRITER)) as client:
        response = client.post(
            "/api/v1/ai/graph/entities",
            json={"entity_type": "nonsense", "stable_key": "x"},
        )
        assert response.status_code == 422


def test_entity_across_tenant_is_not_found(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal(permissions=WRITER)) as client:
        entity = client.post(
            "/api/v1/ai/graph/entities",
            json={"entity_type": "part", "stable_key": "secret", "acl": {"deny_all": True}},
        ).json()
    with _client(
        repository, _principal(permissions=WRITER, tenant_id=OTHER_TENANT)
    ) as other:
        assert other.get(f"/api/v1/ai/graph/entities/{entity['id']}").status_code == 404


# --- Relationships ------------------------------------------------------


def test_relationship_type_constraints(repository: InMemoryAiRepository) -> None:
    graph, _ = _services(repository)
    principal = _principal()
    ids = _build_product_graph(graph, principal)
    # valid: product contains part
    relationship = _rel("contains", ids["prod-1"], ids["part-1"])
    import asyncio

    created = asyncio.run(
        graph.create_relationship(principal, relationship)
    )
    assert created["relationship_type"] == "contains"
    # invalid: document contains product (source constraint)
    from ai_api.domain.errors import ValidationError

    with pytest.raises(ValidationError):
        asyncio.run(
            graph.create_relationship(
                principal, _rel("contains", ids["doc-1"], ids["prod-1"])
            )
        )


def test_self_relationship_rejected(repository: InMemoryAiRepository) -> None:
    graph, _ = _services(repository)
    principal = _principal()
    ids = _build_product_graph(graph, principal)
    import asyncio

    from ai_api.domain.errors import ValidationError

    with pytest.raises(ValidationError):
        asyncio.run(
            graph.create_relationship(
                principal, _rel("contains", ids["prod-1"], ids["prod-1"])
            )
        )


# --- Traversal & analysis -----------------------------------------------


def _linked_graph(repository: InMemoryAiRepository):
    graph, query = _services(repository)
    principal = _principal()
    ids = _build_product_graph(graph, principal)

    async def _link(rel_type: str, source: str, target: str) -> None:
        await graph.create_relationship(
            principal, _rel(rel_type, ids[source], ids[target])
        )

    import asyncio

    asyncio.run(_link("has_bom", "prod-1", "ebom-1"))
    asyncio.run(_link("has_line", "ebom-1", "line-1"))
    asyncio.run(_link("contains", "prod-1", "part-1"))
    asyncio.run(_link("contains", "prod-1", "part-2"))
    asyncio.run(_link("has_cad_model", "part-1", "cad-1"))
    asyncio.run(_link("describes", "doc-1", "part-1"))
    asyncio.run(_link("affects", "ec-1", "part-1"))
    asyncio.run(_link("results_in", "ec-1", "rel-1"))
    asyncio.run(_link("manufactured_at", "part-1", "plant-1"))
    return graph, query, principal, ids


def test_neighbors_filters_unauthorized(repository: InMemoryAiRepository) -> None:
    graph, query, principal, ids = _linked_graph(repository)
    # Deny access to part-2 via ACL
    import asyncio

    asyncio.run(
        graph.update_entity(
            principal,
            ids["part-2"],
            _make_update(acl={"deny_all": True}),
        )
    )
    reader = _principal(username="reader", permissions=READER)
    result = asyncio.run(
        query.neighbors(reader, ids["prod-1"], direction="outgoing")
    )
    names = {item["entity"]["stable_key"] for item in result["neighbors"]}
    assert "part-1" in names
    assert "part-2" not in names


def _make_update(**kwargs):
    from ai_api.schemas.graph import GraphEntityUpdate

    return GraphEntityUpdate(**kwargs)


def test_traverse_bounded_depth(repository: InMemoryAiRepository) -> None:
    _, query, principal, ids = _linked_graph(repository)
    import asyncio

    result = asyncio.run(
        query.traverse(principal, ids["prod-1"], max_depth=3, limit=100)
    )
    keys = {node["stable_key"] for node in result["nodes"]}
    assert "part-1" in keys
    assert "plant-1" in keys
    assert result["depth_reached"] <= 3


def test_traverse_drops_unauthorized_endpoint(
    repository: InMemoryAiRepository,
) -> None:
    graph, query, principal, ids = _linked_graph(repository)
    import asyncio

    asyncio.run(
        graph.update_entity(
            principal, ids["plant-1"], _make_update(acl={"deny_all": True})
        )
    )
    reader = _principal(username="reader", permissions=READER)
    result = asyncio.run(
        query.traverse(reader, ids["prod-1"], max_depth=4, limit=100)
    )
    keys = {node["stable_key"] for node in result["nodes"]}
    assert "plant-1" not in keys
    assert "part-1" in keys


def test_digital_thread_sections(repository: InMemoryAiRepository) -> None:
    _, query, principal, ids = _linked_graph(repository)
    import asyncio

    result = asyncio.run(query.digital_thread(principal, ids["prod-1"]))
    assert result["product"]["entity_type"] == "product"
    assert any(e["stable_key"] == "part-1" for e in result["sections"]["parts"])
    assert any(e["stable_key"] == "ebom-1" for e in result["sections"]["boms"])
    assert any(e["stable_key"] == "cad-1" for e in result["sections"]["cad_models"])
    assert any(e["stable_key"] == "doc-1" for e in result["sections"]["documents"])
    assert any(e["stable_key"] == "ec-1" for e in result["sections"]["changes"])


def test_where_used(repository: InMemoryAiRepository) -> None:
    _, query, principal, ids = _linked_graph(repository)
    import asyncio

    result = asyncio.run(query.where_used(principal, ids["part-1"]))
    used_by = {item["entity"]["stable_key"] for item in result["used_by"]}
    assert "prod-1" in used_by
    assert "doc-1" in used_by


def test_change_impact_flags_inferred(repository: InMemoryAiRepository) -> None:
    _, query, principal, ids = _linked_graph(repository)
    import asyncio

    result = asyncio.run(query.change_impact(principal, ids["ec-1"]))
    assert result["change"]["entity_type"] == "engineering_change"
    affected = {item["entity"]["stable_key"] for item in result["affected"]}
    assert "part-1" in affected
    assert result["inferred"] in (True, False)


def test_traceability_links(repository: InMemoryAiRepository) -> None:
    _, query, principal, ids = _linked_graph(repository)
    import asyncio

    result = asyncio.run(query.traceability(principal, ids["part-1"]))
    assert result["root"]["stable_key"] == "part-1"
    assert result["links"]


def test_find_paths(repository: InMemoryAiRepository) -> None:
    _, query, principal, ids = _linked_graph(repository)
    import asyncio

    result = asyncio.run(
        query.find_paths(
            principal, ids["prod-1"], target_id=ids["part-1"], max_depth=4
        )
    )
    assert result["paths"]
    path = result["paths"][0]
    assert path["nodes"][0]["stable_key"] == "prod-1"
    assert path["nodes"][-1]["stable_key"] == "part-1"


# --- Bulk ingestion -----------------------------------------------------


def test_bulk_ingest_creates_entities_and_relationships(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal(permissions=WRITER)) as client:
        response = client.post(
            "/api/v1/ai/graph/ingest",
            json={
                "source_system": "plm",
                "entities": [
                    {"entity_type": "product", "stable_key": "P1"},
                    {"entity_type": "part", "stable_key": "PA1"},
                ],
                "relationships": [
                    {
                        "relationship_type": "contains",
                        "source_stable_key": "P1",
                        "target_stable_key": "PA1",
                        "source_entity_type": "product",
                        "target_entity_type": "part",
                    }
                ],
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["entities_created"] == 2
        assert body["relationships_created"] == 1


def test_bulk_ingest_is_idempotent(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal(permissions=WRITER)) as client:
        payload = {
            "source_system": "plm",
            "entities": [{"entity_type": "part", "stable_key": "PA1"}],
        }
        first = client.post("/api/v1/ai/graph/ingest", json=payload).json()
        second = client.post("/api/v1/ai/graph/ingest", json=payload).json()
        assert first["entities_created"] == 1
        assert second["entities_updated"] == 1


# --- API surface & authz ------------------------------------------------


def test_graph_endpoints_require_capability(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal(permissions=frozenset())) as client:
        assert client.get("/api/v1/ai/graph/types").status_code == 403
        assert client.get("/api/v1/ai/graph/stats").status_code == 403


def test_graph_stats(repository: InMemoryAiRepository) -> None:
    _, _, _, _ = _linked_graph(repository)
    with _client(repository, _principal(permissions=READER)) as client:
        body = client.get("/api/v1/ai/graph/stats").json()
        assert body["entities"] >= 10
        assert body["relationships"] >= 9
        assert body["status"] == "ok"


def test_reader_cannot_write(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal(permissions=READER)) as client:
        response = client.post(
            "/api/v1/ai/graph/entities",
            json={"entity_type": "part", "stable_key": "nope"},
        )
        assert response.status_code == 403


def test_tenant_isolation_by_query(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal()) as client:
        client.post(
            "/api/v1/ai/graph/entities",
            json={"entity_type": "part", "stable_key": "shared"},
        )
    with _client(
        repository, _principal(tenant_id=OTHER_TENANT)
    ) as other:
        listing = other.get("/api/v1/ai/graph/entities").json()
        assert listing["total"] == 0


# --- Tool surface -------------------------------------------------------


def test_graph_tools_return_bounded_summaries(
    repository: InMemoryAiRepository,
) -> None:
    _, query, principal, ids = _linked_graph(repository)
    import asyncio

    search = asyncio.run(
        query.run_tool(principal, "graph.search", {"query": "part"})
    )
    assert search["tool"] == "graph.search"
    assert all("name" in row for row in search["rows"])

    neighbors = asyncio.run(
        query.run_tool(
            principal, "graph.neighbors", {"entity_id": ids["prod-1"]}
        )
    )
    assert neighbors["root"]["entity_type"] == "product"
    assert neighbors["rows"]
    assert "properties" not in neighbors["rows"][0]["entity"]


def test_unknown_graph_tool_rejected(repository: InMemoryAiRepository) -> None:
    _, query, principal, _ = _linked_graph(repository)
    import asyncio

    from ai_api.domain.errors import ValidationError

    with pytest.raises(ValidationError):
        asyncio.run(query.run_tool(principal, "graph.delete_everything", {}))
