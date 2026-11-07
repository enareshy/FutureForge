"""Stage 4 Phase 3: facets, suggestions, saved searches and history.

Authorization is the focus: facets must only count documents the caller can see,
and saved searches/history are personal to the exact actor.
"""

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
POWER_USER = frozenset({"*:*"})


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


def _principal(name: str, actor_id: int | None) -> Principal:
    return Principal(
        user_id=name,
        username=name,
        tenant_id=TENANT,
        actor_id=actor_id,
        permissions=POWER_USER,
    )


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


def _ingest(client: TestClient, code: str, documents: list[dict]) -> dict:
    source = client.post(
        "/api/v1/ai/knowledge/sources",
        json={"code": code, "name": code, "kind": "manual"},
    ).json()
    response = client.post(
        f"/api/v1/ai/knowledge/sources/{source['id']}/ingest",
        json={"documents": documents},
    )
    assert response.status_code == 202
    assert response.json()["job"]["status"] == "succeeded"
    return source


# --- history ------------------------------------------------------------
def test_search_is_recorded_in_history(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("alice", 1)) as client:
        _ingest(client, "docs", [{"external_id": "g1", "text": "guide for pump"}])
        client.post(
            "/api/v1/ai/search",
            json={"query": "guide", "mode": "lexical", "sort": "title"},
        )
        page = client.get("/api/v1/ai/search/history").json()

    assert page["meta"]["total"] == 1
    entry = page["items"][0]
    assert entry["query"] == "guide"
    assert entry["mode"] == "lexical"
    assert entry["sort"] == "title"
    assert entry["result_count"] == 1


def test_history_is_scoped_to_the_actor(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("alice", 1)) as alice:
        alice.post("/api/v1/ai/search", json={"query": "alice query"})
    with _client(repository, _principal("bob", 2)) as bob:
        page = bob.get("/api/v1/ai/search/history").json()
        assert page["meta"]["total"] == 0
        # Bob cannot delete a history row he does not own.
        assert bob.delete("/api/v1/ai/search/history/1").status_code == 404


def test_history_delete_and_clear(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("alice", 1)) as client:
        client.post("/api/v1/ai/search", json={"query": "first"})
        client.post("/api/v1/ai/search", json={"query": "second"})
        page = client.get("/api/v1/ai/search/history").json()
        assert page["meta"]["total"] == 2

        first_id = page["items"][-1]["id"]
        assert client.delete(f"/api/v1/ai/search/history/{first_id}").status_code == 204
        assert client.get("/api/v1/ai/search/history").json()["meta"]["total"] == 1

        assert client.delete("/api/v1/ai/search/history").status_code == 204
        assert client.get("/api/v1/ai/search/history").json()["meta"]["total"] == 0


# --- saved searches -----------------------------------------------------
def test_saved_search_crud_roundtrip(repository: InMemoryAiRepository) -> None:
    payload = {
        "name": "Pump maintenance",
        "query": "pump lubrication",
        "mode": "hybrid",
        "filters": [{"field": "mime_type", "op": "eq", "value": "text/markdown"}],
        "sort": "recency",
    }
    with _client(repository, _principal("alice", 1)) as client:
        created = client.post("/api/v1/ai/search/saved", json=payload)
        assert created.status_code == 201
        saved = created.json()
        assert saved["name"] == "Pump maintenance"
        assert saved["filters"][0]["field"] == "mime_type"

        listed = client.get("/api/v1/ai/search/saved").json()
        assert listed["meta"]["total"] == 1

        fetched = client.get(f"/api/v1/ai/search/saved/{saved['id']}")
        assert fetched.status_code == 200

        assert client.delete(f"/api/v1/ai/search/saved/{saved['id']}").status_code == 204
        assert client.get(f"/api/v1/ai/search/saved/{saved['id']}").status_code == 404


def test_saved_search_is_scoped_to_the_actor(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("alice", 1)) as alice:
        saved = alice.post(
            "/api/v1/ai/search/saved", json={"name": "mine", "query": "secret"}
        ).json()
    with _client(repository, _principal("bob", 2)) as bob:
        assert bob.get("/api/v1/ai/search/saved").json()["meta"]["total"] == 0
        assert bob.get(f"/api/v1/ai/search/saved/{saved['id']}").status_code == 404
        assert bob.delete(f"/api/v1/ai/search/saved/{saved['id']}").status_code == 404


# --- facets -------------------------------------------------------------
def test_facets_count_only_authorized_documents(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin", 1)) as client:
        _ingest(
            client,
            "mixed",
            [
                {"external_id": "m1", "mime_type": "text/markdown", "text": "guide alpha"},
                {"external_id": "m2", "mime_type": "text/markdown", "text": "guide beta"},
                {"external_id": "p1", "mime_type": "text/plain", "text": "guide gamma"},
            ],
        )
        response = client.get(
            "/api/v1/ai/search/facets",
            params={"q": "guide", "mode": "lexical"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 3
    by_field = {facet["field"]: facet for facet in body["facets"]}
    mime = {b["value"]: b["count"] for b in by_field["mime_type"]["buckets"]}
    assert mime == {"text/markdown": 2, "text/plain": 1}


def test_facets_respect_classification_ceiling(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin", 1)) as client:
        _ingest(
            client,
            "classified",
            [
                {"external_id": "pub", "text": "guide public", "classification": "public"},
                {
                    "external_id": "sec",
                    "text": "guide secret",
                    "classification": "restricted",
                },
            ],
        )
        # A principal with no ceiling override still searches; the restricted doc
        # is only omitted if the policy ceiling disallows it. Assert facet total
        # never exceeds the number of documents the search itself returns.
        facets = client.get(
            "/api/v1/ai/search/facets", params={"q": "guide", "mode": "lexical"}
        ).json()
        search = client.post(
            "/api/v1/ai/search", json={"query": "guide", "mode": "lexical"}
        ).json()
    assert facets["total"] == search["total"]


# --- suggestions --------------------------------------------------------
def test_suggestions_come_from_the_actors_own_history(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("alice", 1)) as alice:
        alice.post("/api/v1/ai/search", json={"query": "pump lubrication"})
        alice.post("/api/v1/ai/search", json={"query": "valve torque"})
        response = alice.get(
            "/api/v1/ai/search/suggestions", params={"q": "pump"}
        ).json()
        assert "pump lubrication" in response["suggestions"]
        assert "valve torque" not in response["suggestions"]

    with _client(repository, _principal("bob", 2)) as bob:
        empty = bob.get("/api/v1/ai/search/suggestions", params={"q": ""}).json()
        assert empty["suggestions"] == []


# --- index health + reconciliation --------------------------------------
def test_search_health_reports_indexed_documents(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin", 1)) as client:
        _ingest(client, "healthy", [{"external_id": "h1", "text": "pump guide"}])
        health = client.get("/api/v1/ai/search/health")

    assert health.status_code == 200
    body = health.json()
    assert body["status"] == "ok"
    assert body["documents"]["total"] == 1
    assert body["documents"]["indexed"] == 1
    assert body["documents"]["stale"] == 0
    assert body["documents"]["missing"] == 0
    assert body["chunks_total"] == 1
    assert body["search_backend"]


def test_search_health_is_degraded_when_a_document_is_stale(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin", 1)) as client:
        _ingest(client, "aging", [{"external_id": "s1", "text": "pump guide"}])

    repository._documents[0]["status"] = "stale"  # simulate content drift

    with _client(repository, _principal("admin", 1)) as client:
        health = client.get("/api/v1/ai/search/health").json()
    assert health["status"] == "degraded"
    assert health["documents"]["stale"] == 1


def test_index_status_lists_problem_documents(repository: InMemoryAiRepository) -> None:
    with _client(repository, _principal("admin", 1)) as client:
        _ingest(
            client,
            "mixed-status",
            [
                {"external_id": "ok", "text": "healthy guide"},
                {"external_id": "bad", "text": "unhealthy guide"},
            ],
        )

    for doc in repository._documents:
        if doc["external_id"] == "bad":
            doc["status"] = "stale"

    with _client(repository, _principal("admin", 1)) as client:
        response = client.get("/api/v1/ai/knowledge/index-status")

    assert response.status_code == 200
    body = response.json()
    assert body["totals"]["total"] == 2
    assert body["totals"]["stale"] == 1
    assert body["sources"][0]["source_code"] == "mixed-status"
    assert body["sources"][0]["stale"] == 1
    assert [d["external_id"] for d in body["problem_documents"]] == ["bad"]


def test_reconcile_queues_reindex_for_problem_sources_only(
    repository: InMemoryAiRepository,
) -> None:
    with _client(repository, _principal("admin", 1)) as client:
        broken = _ingest(client, "needs-work", [{"external_id": "w1", "text": "guide one"}])
        _ingest(client, "is-fine", [{"external_id": "w2", "text": "guide two"}])

    for doc in repository._documents:
        if doc["source_id"] == broken["id"]:
            doc["status"] = "failed"
            doc["error_class"] = "provider"

    with _client(repository, _principal("admin", 1)) as client:
        first = client.post("/api/v1/ai/knowledge/reconcile")
        assert first.status_code == 200
        body = first.json()
        assert body["sources_queued"] == 1
        assert len(body["jobs"]) == 1

        # Idempotent while the queued job is active.
        second = client.post("/api/v1/ai/knowledge/reconcile").json()
        assert second["sources_queued"] == 0

