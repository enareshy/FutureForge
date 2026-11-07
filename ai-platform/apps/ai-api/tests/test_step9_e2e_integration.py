"""Step 9: enterprise-wide end-to-end integration tests.

These tests drive the real application services and HTTP API paths across all
completed module boundaries (Steps 1-8). Only the enterprise identity provider
is replaced (in the same style as ``test_e2e_copilot``); everything else uses the
in-memory repository + real services so the integrated code path is exercised.

Covered workflows:
* A - Enterprise knowledge intelligence
* B - Product and engineering intelligence
* C - Manufacturing and quality intelligence
* D - Predictive intelligence and recommendations
* E - Enterprise AI agent (search, graph, product/BOM, manufacturing, quality,
      predictive tools + delegation + human approval)
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal
from ai_api.application.services.agent_execution_service import AgentExecutionService
from ai_api.application.services.agent_memory_service import AgentMemoryService
from ai_api.application.services.agent_tool_service import AgentToolService
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.bom_service import BomService
from ai_api.application.services.enterprise_tools import build_enterprise_tool_client
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.graph_query_service import GraphQueryService
from ai_api.application.services.graph_service import GraphService
from ai_api.application.services.manufacturing_service import ManufacturingService
from ai_api.application.services.predictive_service import PredictiveService
from ai_api.application.services.product_service import ProductService
from ai_api.application.services.quality_service import QualityService
from ai_api.config.settings import Settings
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.access_control import AccessControl
from ai_api.security.permissions import build_permission_map
from ai_api.security.policies import PermissionMap, Policy, Principal

TENANT = 1
OTHER_TENANT = 2
POWER_USER = frozenset({"*:*"})
API = "/api/v1/ai"
PRED = f"{API}/predictive-intelligence"


class _FakeRetrieval:
    async def ranked_documents(
        self, principal, *, query, mode, filters, sort, limit
    ):
        return ([], mode, False)


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
    repository: InMemoryAiRepository, principal: Principal | None = None
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal or _principal()
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


# --- Seed helpers --------------------------------------------------------
def _source(client: TestClient, code: str = "handbook") -> dict:
    response = client.post(
        f"{API}/knowledge/sources",
        json={"code": code, "name": code, "kind": "manual"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _ingest(client: TestClient, source_id: int, docs: list[dict]) -> dict:
    response = client.post(
        f"{API}/knowledge/sources/{source_id}/ingest",
        json={"documents": docs},
    )
    assert response.status_code == 202, response.text
    return response.json()


def _item(client: TestClient, key: str, item_type: str = "part", **overrides) -> dict:
    payload = {"item_type": item_type, "item_key": key, "name": key, **overrides}
    response = client.post(f"{API}/products/items", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _revision(client: TestClient, item_id: int, revision: str = "A") -> dict:
    response = client.post(
        f"{API}/products/items/{item_id}/revisions", json={"revision": revision}
    )
    assert response.status_code == 201, response.text
    return response.json()


def _bom(client: TestClient, key: str, bom_type: str = "EBOM", **overrides) -> dict:
    payload = {"bom_type": bom_type, "bom_key": key, **overrides}
    response = client.post(f"{API}/boms", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _line(
    client: TestClient,
    header_id: int,
    parent_revision_id: int,
    child_item_id: int,
    **overrides,
) -> dict:
    payload = {
        "parent_revision_id": parent_revision_id,
        "child_item_id": child_item_id,
        **overrides,
    }
    response = client.post(f"{API}/boms/{header_id}/lines", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _plant(client: TestClient, key: str = "PLANT-1") -> dict:
    response = client.post(f"{API}/manufacturing/plants", json={"plant_key": key})
    assert response.status_code == 201, response.text
    return response.json()


def _line_wc(client: TestClient, plant_id: int, key: str = "LINE-1") -> dict:
    response = client.post(
        f"{API}/manufacturing/lines", json={"plant_id": plant_id, "line_key": key}
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


def _process(client: TestClient, key: str, **overrides) -> dict:
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


def _issue(client: TestClient, key: str, **overrides) -> dict:
    payload = {"issue_key": key, "title": key, **overrides}
    response = client.post(f"{API}/quality/issues", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _predict(client: TestClient, item_id: int, **overrides) -> dict:
    payload = {
        "prediction_type": "defect_risk",
        "subject_type": "product_item",
        "subject_id": item_id,
        **overrides,
    }
    response = client.post(f"{PRED}/predictions", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# --- Workflow A: Enterprise knowledge intelligence -----------------------
def test_workflow_a_knowledge_intelligence(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        source = _source(client, "maintenance")
        ingest = _ingest(
            client,
            source["id"],
            [
                {
                    "external_id": "pump-lubrication",
                    "title": "Pump lubrication",
                    "text": (
                        "The hydraulic pump bearings require quarterly "
                        "lubrication with ISO VG 46 oil."
                    ),
                },
                {
                    "external_id": "secret-comp",
                    "title": "Executive compensation",
                    "text": "Executive compensation details are restricted.",
                    "classification": "restricted",
                    "acl": {"users": ["chro"]},
                },
            ],
        )
        assert ingest["job"]["status"] == "succeeded"

        # Enterprise search surfaces the public document, not the restricted one.
        search = client.post(
            f"{API}/search", json={"query": "hydraulic pump lubrication", "limit": 10}
        )
        assert search.status_code == 200, search.text
        assert search.json()["count"] >= 1
        assert all(
            row["source_code"] == "maintenance"
            for row in search.json()["results"]
        )
        assert all(
            "compensation" not in row["content"].lower()
            for row in search.json()["results"]
        )

        # RAG query returns an evidence-backed answer with citations.
        rag = client.post(
            f"{API}/rag/query",
            json={"query": "How often must the pump bearings be lubricated?"},
        )
        assert rag.status_code == 200, rag.text
        body = rag.json()
        assert body["insufficient_evidence"] is False
        assert body["citations"]
        assert body["citations"][0]["source_code"] == "maintenance"
        assert "pump" in body["citations"][0]["snippet"].lower()

        # Knowledge Assistant answers with sources attached.
        conversation = client.post(
            f"{API}/assistant/conversations", json={"title": "Pump maintenance"}
        )
        assert conversation.status_code == 201, conversation.text
        reply = client.post(
            f"{API}/assistant/conversations/{conversation.json()['id']}/messages",
            json={"content": "How do I maintain the hydraulic pump?"},
        )
        assert reply.status_code == 201, reply.text
        message = reply.json()
        assert message["role"] == "assistant"
        assert message["answer_status"] == "answered"
        assert message["sources"]

        # Reindexing the source is supported and stays tenant scoped.
        reindex = client.post(f"{API}/knowledge/sources/{source['id']}/reindex")
        assert reindex.status_code == 200, reindex.text
        assert reindex.json()["result"]["documents"] == 2

    # Tenant isolation: another tenant cannot read the source or its docs.
    with _client(repository, _principal(tenant_id=OTHER_TENANT, username="other")) as other:
        sources = other.get(f"{API}/knowledge/sources")
        assert sources.status_code == 200
        assert all(row["id"] != source["id"] for row in sources.json()["items"])
        denied = other.get(f"{API}/knowledge/sources/{source['id']}")
        assert denied.status_code == 404
        rag = other.post(
            f"{API}/rag/query", json={"query": "hydraulic pump lubrication"}
        )
        assert rag.status_code == 200
        assert rag.json()["insufficient_evidence"] is True


# --- Workflow B: Product and engineering intelligence --------------------
def test_workflow_b_product_bom_graph(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        product = _item(client, "ASM-PUMP", item_type="assembly")
        product_rev = _revision(client, product["id"])
        mid = _item(client, "ASM-MID", item_type="assembly")
        mid_rev = _revision(client, mid["id"])
        seal = _item(client, "PN-SEAL")
        bearing = _item(client, "PN-BEARING")

        ebom = _bom(
            client,
            "EBOM-PUMP",
            root_item_id=product["id"],
            root_revision_id=product_rev["id"],
        )
        _line(
            client,
            ebom["id"],
            product_rev["id"],
            mid["id"],
            child_revision_id=mid_rev["id"],
            quantity=2,
        )
        _line(client, ebom["id"], mid_rev["id"], seal["id"], quantity=3)
        _line(client, ebom["id"], product_rev["id"], bearing["id"], quantity=1)

        mbom = _bom(
            client,
            "MBOM-PUMP",
            bom_type="MBOM",
            root_item_id=product["id"],
            root_revision_id=product_rev["id"],
        )
        _line(client, mbom["id"], product_rev["id"], mid["id"], quantity=2)
        _line(client, mbom["id"], product_rev["id"], bearing["id"], quantity=1)

        # Multi-level expansion with cumulative quantities.
        structure = client.get(
            f"{API}/boms/{ebom['id']}/structure", params={"max_depth": 5}
        )
        assert structure.status_code == 200, structure.text
        rows = structure.json()["rows"]
        seal_row = next(r for r in rows if r["child_item_id"] == seal["id"])
        assert seal_row["cumulative_quantity"] == 6

        # EBOM vs MBOM comparison identifies added/missing components.
        compare = client.post(
            f"{API}/boms/compare",
            json={"left_header_id": ebom["id"], "right_header_id": mbom["id"]},
        )
        assert compare.status_code == 200, compare.text
        body = compare.json()
        summary = body["summary"]
        assert summary["removed"] + summary["added"] + summary["modified"] >= 1
        # The seal is only in the EBOM, so it must appear as removed.
        removed_ids = {
            diff["child_item_id"]
            for diff in body["diffs"]
            if diff["change_type"] == "removed"
        }
        assert seal["id"] in removed_ids

        # Products are linked into the knowledge graph.
        assert product.get("graph_entity_id")
        graph_search = client.get(
            f"{API}/graph/search", params={"q": "ASM-PUMP"}
        )
        assert graph_search.status_code == 200, graph_search.text
        matching = [
            e for e in graph_search.json()["items"] if e["id"] == product["graph_entity_id"]
        ]
        assert matching
        assert matching[0]["source_system"] == "ai.product"

        # Connect the product to an engineering change and trace impact.
        change = client.post(
            f"{API}/graph/entities",
            json={
                "entity_type": "change_request",
                "stable_key": "CR-1001",
                "name": "Replace seal material",
                "source_system": "ai.change",
            },
        )
        assert change.status_code == 201, change.text
        change_id = change.json()["id"]
        link = client.post(
            f"{API}/graph/relationships",
            json={
                "relationship_type": "affects",
                "source_entity_id": change_id,
                "target_entity_id": product["graph_entity_id"],
            },
        )
        assert link.status_code == 201, link.text
        impact = client.get(f"{API}/graph/changes/{change_id}/impact")
        assert impact.status_code == 200, impact.text
        affected_ids = {
            item["entity"]["id"] for item in impact.json()["affected"]
        }
        assert product["graph_entity_id"] in affected_ids
        for item in impact.json()["affected"]:
            assert item["path"]
            assert item["impact"] in ("direct", "indirect")

    # Tenant isolation on product lookup.
    with _client(repository, _principal(tenant_id=OTHER_TENANT, username="other")) as other:
        denied = other.get(f"{API}/products/items/{product['id']}")
        assert denied.status_code == 404


# --- Workflow C: Manufacturing and quality intelligence ------------------
def test_workflow_c_manufacturing_quality(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        item = _item(client, "ASM-MFG", item_type="assembly")
        plant = _plant(client)
        line = _line_wc(client, plant["id"])
        centre = _work_centre(client, plant["id"])
        process = _process(
            client,
            "PROC-MFG",
            root_item_id=item["id"],
            plant_id=plant["id"],
            line_id=line["id"],
        )
        op = _operation(
            client, process["id"], "OP-10", sequence=10, work_centre_id=centre["id"]
        )
        instruction = client.post(
            f"{API}/manufacturing/work-instructions",
            json={
                "process_id": process["id"],
                "instruction_key": "WI-10",
                "title": "Assemble pump",
                "operation_id": op["id"],
            },
        )
        assert instruction.status_code == 201, instruction.text

        # Manufacturing structure navigation (operations + instructions).
        structure = client.get(
            f"{API}/manufacturing/processes/{process['id']}/structure"
        )
        assert structure.status_code == 200, structure.text

        # Quality issue tied to the component/operation, with supplier data.
        issue = _issue(
            client,
            "QI-MFG",
            component_item_id=item["id"],
            plant_id=plant["id"],
            work_centre_id=centre["id"],
            operation_id=op["id"],
            supplier_ref="acme",
            failure_code="CRACK",
            severity="high",
        )
        supplier = client.post(
            f"{API}/quality/issues/{issue['id']}/supplier-issues",
            json={
                "supplier_ref": "acme",
                "supplier_name": "Acme Corp",
                "component_item_id": item["id"],
            },
        )
        assert supplier.status_code in (200, 201), supplier.text

        # Corrective action lifecycle.
        action = client.post(
            f"{API}/quality/actions",
            json={
                "quality_issue_id": issue["id"],
                "action_key": "CA-MFG",
                "action_type": "corrective",
                "description": "Reinspect supplier batch",
            },
        )
        assert action.status_code == 201, action.text
        action_id = action.json()["id"]
        implemented = client.patch(
            f"{API}/quality/actions/{action_id}", json={"status": "implemented"}
        )
        assert implemented.status_code == 200, implemented.text

        # Traceability distinguishes confirmed references from inferred impact.
        trace = client.get(f"{API}/quality/issues/{issue['id']}/traceability")
        assert trace.status_code == 200, trace.text
        body = trace.json()
        assert body["component"]["id"] == item["id"]
        assert body["plant"]["id"] == plant["id"]
        assert body["operation"]["id"] == op["id"]

        # Supplier quality roll-up exposes the linked supplier.
        supplier_quality = client.get(f"{API}/quality/supplier-quality")
        assert supplier_quality.status_code == 200, supplier_quality.text
        assert any(
            row["supplier_ref"] == "acme" for row in supplier_quality.json()["rows"]
        )

    # Tenant isolation on manufacturing and quality.
    with _client(repository, _principal(tenant_id=OTHER_TENANT, username="other")) as other:
        assert other.get(f"{API}/quality/issues/{issue['id']}").status_code == 404
        assert (
            other.get(f"{API}/manufacturing/processes/{process['id']}").status_code
            == 404
        )


# --- Workflow D: Predictive intelligence and recommendations -------------
def test_workflow_d_predictive_recommendations(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        item = _item(client, "PN-PRED")

        # Insufficient data is explicit, never fabricated.
        empty = _predict(client, item["id"])
        assert empty["status"] == "insufficient_data"
        assert empty["risk_category"] == "unknown"
        assert empty["score"] is None
        assert empty["limitations"]

        # With real quality history, a rule-based strategy produces a result.
        _issue(client, "QI-P1", product_item_id=item["id"], severity="critical")
        _issue(client, "QI-P2", product_item_id=item["id"], severity="high")
        prediction = _predict(client, item["id"])
        assert prediction["status"] == "active"
        assert prediction["method"] == "rule_based"
        assert prediction["score"] is not None
        assert prediction["uncertainty"]["kind"] == "RULE_BASED_SCORE"
        assert prediction["evidence"]
        assert prediction["limitations"]

        # Explanation carries method label, factors and data freshness.
        explanation = client.get(
            f"{PRED}/predictions/{prediction['id']}/explanation"
        )
        assert explanation.status_code == 200, explanation.text
        explanation_body = explanation.json()
        assert explanation_body["method_label"]
        assert "data_freshness" in explanation_body
        assert "limitations" in explanation_body

        # Generate a recommendation, route it to human review, accept it.
        generated = client.post(
            f"{PRED}/recommendations/generate",
            json={"prediction_ids": [prediction["id"]]},
        )
        assert generated.status_code == 200, generated.text
        recommendation = generated.json()[0]
        assert recommendation["prediction_id"] == prediction["id"]
        assert recommendation["status"] == "new"

        # Generation is idempotent per prediction.
        again = client.post(
            f"{PRED}/recommendations/generate",
            json={"prediction_ids": [prediction["id"]]},
        )
        assert again.json()[0]["id"] == recommendation["id"]

        under_review = client.patch(
            f"{PRED}/recommendations/{recommendation['id']}",
            json={"status": "under_review"},
        )
        assert under_review.status_code == 200, under_review.text

        feedback = client.post(
            f"{PRED}/recommendations/{recommendation['id']}/feedback",
            json={
                "decision": "accept",
                "comment": "Batch reinspection scheduled",
                "outcome": "defect rate reduced",
                "risk_after": 5,
            },
        )
        assert feedback.status_code == 201, feedback.text
        assert feedback.json()["decision"] == "accept"

        accepted = client.get(f"{PRED}/recommendations/{recommendation['id']}")
        assert accepted.json()["status"] == "accepted"

        history = client.get(
            f"{PRED}/recommendations/{recommendation['id']}/feedback"
        )
        assert len(history.json()) == 1

        # The recommendation review is recorded in the audit trail.
        audit = client.get(f"{API}/audit").json()
        assert any(
            str(row.get("resource_type", "")).startswith("ai.predictive")
            or "predictive" in str(row.get("action", ""))
            for row in audit["items"]
        )

    # Tenant isolation on predictive records.
    with _client(repository, _principal(tenant_id=OTHER_TENANT, username="other")) as other:
        listed = other.get(f"{PRED}/predictions")
        assert listed.status_code == 200
        assert all(
            row["id"] != prediction["id"] for row in listed.json()["items"]
        )


# --- Workflow E: Enterprise AI agent -------------------------------------
def _build_services(repository: InMemoryAiRepository) -> dict:
    """Wire the same in-process services the API dependency graph uses."""

    audit = AuditService(repository)
    policy = Policy()
    settings = Settings(ai_repository="memory")
    governance = GovernanceService(repository)
    access = AccessControl(policy=policy)
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
    )
    tools = build_enterprise_tool_client(
        settings,
        policy,
        graph=graph_query,
        products=products,
        boms=boms,
        manufacturing=manufacturing,
        quality=quality,
        predictive=predictive,
    )
    return {
        "audit": audit,
        "policy": policy,
        "settings": settings,
        "enterprise_tools": tools,
    }


def _build_execution_service(
    repository: InMemoryAiRepository,
) -> AgentExecutionService:
    wired = _build_services(repository)
    audit = wired["audit"]
    policy = wired["policy"]
    settings = wired["settings"]
    return AgentExecutionService(
        repository=repository,
        retrieval=_FakeRetrieval(),
        audit=audit,
        policy=policy,
        settings=settings,
        tools=AgentToolService(repository=repository, audit=audit, policy=policy),
        permissions=PermissionMap(build_permission_map(settings)),
        enterprise_tools=wired["enterprise_tools"],
        memory=AgentMemoryService(repository=repository, audit=audit, policy=policy),
    )


def _published_agent(client: TestClient, code: str, definition: dict) -> dict:
    created = client.post(
        f"{API}/agents",
        json={"code": code, "name": code, "definition": definition},
    )
    assert created.status_code == 201, created.text
    published = client.post(f"{API}/agents/{created.json()['id']}/publish", json={})
    assert published.status_code == 200, published.text
    return published.json()


def _run_execution(
    repository: InMemoryAiRepository, execution_id: int
) -> AgentExecutionService:
    service = _build_execution_service(repository)

    async def scenario() -> None:
        claimed = await repository.claim_agent_execution(
            worker_id="step9-worker", lease_seconds=120
        )
        assert claimed is not None and claimed["id"] == execution_id
        await service.run_claimed(claimed)

    asyncio.run(scenario())
    return service


def test_workflow_e_agent_end_to_end(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        # Seed enterprise data the agent will reason over.
        source = _source(client, "runbook")
        _ingest(
            client,
            source["id"],
            [
                {
                    "external_id": "seal-replacement",
                    "title": "Seal replacement",
                    "text": "Replace the pump seal every 12 months or on failure.",
                }
            ],
        )
        item = _item(client, "PN-AGENT")
        # Two quality issues make the predictive tool return an active result.
        _issue(client, "QI-A1", product_item_id=item["id"], severity="critical")
        _issue(client, "QI-A2", product_item_id=item["id"], severity="high")

        # Child agent performs a knowledge lookup.
        child = _published_agent(
            client,
            "knowledge-child",
            {
                "system_instructions": "Search the knowledge base.",
                "tools": ["knowledge.search"],
                "steps": [
                    {
                        "key": "search",
                        "sequence": 1,
                        "tool": "knowledge.search",
                        "args": {"query": "{{query}}"},
                        "depends_on": [],
                    }
                ],
            },
        )

        # Parent agent exercises authorized search + predictive tools and
        # delegates the knowledge lookup to the child.
        parent = _published_agent(
            client,
            "ops-orchestrator",
            {
                "system_instructions": "Orchestrate enterprise lookups.",
                "tools": ["predictive.risk_lookup"],
                "delegation": {
                    "enabled": True,
                    "max_depth": 2,
                    "agents": [child["id"]],
                },
                "steps": [
                    {
                        "key": "risk",
                        "sequence": 1,
                        "tool": "predictive.risk_lookup",
                        "args": {
                            "prediction_type": "defect_risk",
                            "subject_type": "product_item",
                        },
                        "depends_on": [],
                    },
                    {
                        "key": "knowledge",
                        "sequence": 2,
                        "delegate_to": child["id"],
                        "depends_on": ["risk"],
                    },
                ],
            },
        )

        created = client.post(
            f"{API}/agent-executions",
            json={
                "agent_id": parent["id"],
                "input": {"query": "pump seal replacement"},
            },
        )
        assert created.status_code == 202, created.text
        execution = created.json()

        # Idempotency: same request with same key returns the same execution.
        keyed = client.post(
            f"{API}/agent-executions",
            json={
                "agent_id": parent["id"],
                "input": {"query": "pump seal replacement"},
                "idempotency_key": "step9-run-1",
            },
        )
        assert keyed.status_code == 202, keyed.text
        repeat = client.post(
            f"{API}/agent-executions",
            json={
                "agent_id": parent["id"],
                "input": {"query": "pump seal replacement"},
                "idempotency_key": "step9-run-1",
            },
        )
        assert repeat.json()["id"] == keyed.json()["id"]

    _run_execution(repository, execution["id"])

    with _client(repository) as client:
        detail = client.get(f"{API}/agent-executions/{execution['id']}")
        assert detail.status_code == 200, detail.text
        detail_body = detail.json()
        assert detail_body["status"] in ("completed", "succeeded")

        trace = client.get(f"{API}/agent-executions/{execution['id']}/trace")
        assert trace.status_code == 200, trace.text
        trace_body = trace.json()
        assert len(trace_body["steps"]) >= 2
        invocations = trace_body["invocations"]
        assert invocations

        # The local predictive tool must have actually executed (this proves the
        # dispatch fix: Stage 9-10 in-process tools are reachable by agents).
        predictive_calls = [
            inv for inv in invocations if inv.get("tool_code") == "predictive.risk_lookup"
        ]
        assert predictive_calls
        assert any(inv.get("status") == "succeeded" for inv in predictive_calls)
        result_snapshot = predictive_calls[0].get("result") or {}
        assert result_snapshot.get("tool") == "predictive.risk_lookup"
        assert "disclaimer" in result_snapshot

        result = client.get(f"{API}/agent-executions/{execution['id']}/result")
        assert result.status_code == 200, result.text

        delegations = client.get(
            f"{API}/agent-executions/{execution['id']}/delegations"
        )
        assert delegations.status_code == 200, delegations.text
        rows = delegations.json()["delegations"]
        assert len(rows) == 1
        assert rows[0]["child_agent_id"] == child["id"]
        assert rows[0]["status"] == "completed"

        # Execution activity is audited.
        audit = client.get(f"{API}/audit").json()
        assert any(
            row.get("action", "").startswith("ai.agent.execution")
            for row in audit["items"]
        )


def test_workflow_e_controlled_action_requires_approval(
    repository: InMemoryAiRepository,
) -> None:
    tester = frozenset(
        {
            "ai.agents:read",
            "ai.agents:update",
            "ai.agents:execute",
            "ai.agent_tools:read",
            "ai.agent_tools:update",
            "ai.agent_approvals:read",
            "ai.agent_approvals:execute",
        }
    )
    reviewer = frozenset(
        {
            "ai.agents:read",
            "ai.agent_approvals:read",
            "ai.agent_approvals:execute",
        }
    )
    with _client(repository, _principal("tester", tester)) as client:
        tool = client.post(
            f"{API}/agent-tools",
            json={
                "code": "platform.draft.create",
                "name": "Create platform draft",
                "definition": {
                    "capability": "platform.draft",
                    "read_only": False,
                    "risk_class": "controlled_mutation",
                    "requires_approval": True,
                    "idempotency": "required",
                    "input_schema": {"type": "object"},
                    "output_schema": {"type": "object"},
                },
            },
        ).json()
        assert (
            client.post(f"{API}/agent-tools/{tool['id']}/publish").status_code == 200
        )
        agent = _published_agent(
            client,
            "draft-agent",
            {
                "system_instructions": "Prepare a draft for human review.",
                "tools": ["platform.draft.create"],
                "steps": [
                    {
                        "key": "draft",
                        "sequence": 1,
                        "tool": "platform.draft.create",
                        "args": {"title": "{{title}}", "content": "{{content}}"},
                        "depends_on": [],
                    }
                ],
            },
        )
        created = client.post(
            f"{API}/agent-executions",
            json={
                "agent_id": agent["id"],
                "input": {"title": "Quarterly plan", "content": "Draft body"},
            },
        )
        assert created.status_code == 202, created.text
        execution_id = created.json()["id"]

    _run_execution(repository, execution_id)

    with _client(repository, _principal("tester", tester)) as client:
        waiting = client.get(f"{API}/agent-executions/{execution_id}").json()
        assert waiting["status"] == "waiting_approval"
        approvals = client.get(f"{API}/agent-approvals", params={"status": "pending"})
        assert approvals.status_code == 200, approvals.text
        assert approvals.json()["total"] == 1
        approval = approvals.json()["items"][0]
        assert approval["operation_hash"]

        # A requester cannot approve their own controlled operation.
        self_approval = client.post(
            f"{API}/agent-approvals/{approval['id']}/approve", json={}
        )
        assert self_approval.status_code == 403

    with _client(repository, _principal("reviewer", reviewer, actor_id=42)) as client:
        approved = client.post(
            f"{API}/agent-approvals/{approval['id']}/approve",
            json={"reason": "looks safe"},
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "approved"

    _run_execution(repository, execution_id)

    with _client(repository) as client:
        done = client.get(f"{API}/agent-executions/{execution_id}").json()
        assert done["status"] == "completed"
        assert done["artifacts"][0]["artifact_type"] == "draft"

        audit = client.get(f"{API}/audit").json()
        actions = {row.get("action") for row in audit["items"]}
        assert "ai.agent_approval.approved" in actions
        assert "ai.agent.execution.create" in actions


# --- Cross-module: event framework ---------------------------------------
def test_workflow_events_are_published(
    repository: InMemoryAiRepository,
) -> None:
    """The event framework receives domain events from integrated workflows.

    Retry/dead-letter/idempotency semantics are covered by ``tests/test_events.py``;
    this only verifies that the integrated workflows actually emit events.
    """

    with _client(repository) as client:
        source = _source(client, "evented")
        _ingest(
            client,
            source["id"],
            [{"external_id": "e1", "title": "e1", "text": "evented body"}],
        )
        events = client.get(f"{API}/events")
        assert events.status_code == 200, events.text
        types = {row["type"] for row in events.json()}
        assert "KnowledgeSourceRegistered" in types


# --- Cross-module: Copilot <-> enterprise tools --------------------------
def test_copilot_tools_authorized_in_process(
    repository: InMemoryAiRepository,
) -> None:
    wired = _build_services(repository)
    tools = wired["enterprise_tools"]

    with _client(repository) as client:
        _item(client, "PN-COPILOT", item_type="part")
        _item(client, "PN-COPILOT", item_type="component")

    # A power user can run an in-process BOM tool through the same client the
    # Copilot/Agent layers use, and the result is bounded + source-attributed.
    admin = _principal()
    outcome = asyncio.run(tools.run(admin, "bom.duplicates", {}))
    assert outcome.status == "succeeded", outcome.error_class
    assert outcome.read_only is True
    assert outcome.summary["summary"]["exact"] >= 2

    # A reader without the tool capability is denied before any data access.
    limited = Principal(
        user_id="reader",
        username="reader",
        tenant_id=TENANT,
        actor_id=9,
        permissions=frozenset({"ai.retrieval:execute"}),
    )
    denied = asyncio.run(tools.run(limited, "bom.duplicates", {}))
    assert denied.status == "denied"
    assert denied.error_class == "authorization_denied"

    # Tenant scoping: the same tool run as another tenant sees no data.
    other = _principal(tenant_id=OTHER_TENANT, username="other")
    scoped = asyncio.run(tools.run(other, "bom.duplicates", {}))
    assert scoped.status == "succeeded"
    assert scoped.summary["summary"]["exact"] == 0


# --- Security: unauthorized graph traversal ------------------------------
def test_graph_traversal_requires_capability(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        entity = client.post(
            f"{API}/graph/entities",
            json={
                "entity_type": "part",
                "stable_key": "SEC-PART",
                "name": "Secret part",
            },
        )
        assert entity.status_code == 201, entity.text
        entity_id = entity.json()["id"]

    reader = _principal(username="reader", permissions=frozenset({"ai.agents:read"}))
    with _client(repository, reader) as client:
        # No graph capability -> forbidden, not leaked data.
        denied = client.get(f"{API}/graph/entities/{entity_id}/neighborhood")
        assert denied.status_code in (401, 403)


# --- Failure and recovery ------------------------------------------------
def test_failure_recovery_execution_cancel_and_retry(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        agent = _published_agent(
            client,
            "cancel-agent",
            {
                "system_instructions": "Search.",
                "tools": ["knowledge.search"],
                "steps": [
                    {
                        "key": "search",
                        "sequence": 1,
                        "tool": "knowledge.search",
                        "args": {"query": "{{query}}"},
                        "depends_on": [],
                    }
                ],
            },
        )
        created = client.post(
            f"{API}/agent-executions",
            json={"agent_id": agent["id"], "input": {"query": "anything"}},
        )
        assert created.status_code == 202, created.text
        execution_id = created.json()["id"]

        cancelled = client.post(f"{API}/agent-executions/{execution_id}/cancel")
        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()["status"] == "cancelled"

        # A terminal execution cannot be cancelled again (controlled error).
        again = client.post(f"{API}/agent-executions/{execution_id}/cancel")
        assert again.status_code == 409, again.text


def test_predictive_ml_method_is_insufficient(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository) as client:
        item = _item(client, "PN-ML")
        client.post(
            f"{PRED}/models",
            json={
                "model_key": "ml-defect",
                "prediction_type": "defect_risk",
                "method": "ml",
                "lifecycle_status": "active",
            },
        )
        result = _predict(client, item["id"], model_key="ml-defect")
        assert result["status"] == "insufficient_data"
        assert result["method"] == "ml"
        assert result["limitations"]
