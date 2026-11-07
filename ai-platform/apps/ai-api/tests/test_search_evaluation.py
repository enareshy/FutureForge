"""Stage 4 Phase 7: labeled relevance evaluation and a bounded perf check.

The corpus and judgements are version-controlled and deterministic. This is a
regression guard for ranking/filter behaviour, not a benchmark of a real model.
"""

from __future__ import annotations

import math
import time
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_principal
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

POWER_USER = frozenset({"*:*"})

CORPUS: list[dict] = [
    (
        "safety",
        [
            {
                "external_id": "pump-startup",
                "title": "Pump startup checklist",
                "text": (
                    "Pump startup checklist: open the inlet valve, verify lubrication, "
                    "then start the motor."
                ),
            },
            {
                "external_id": "pump-lockout",
                "title": "Pump lockout tagout",
                "text": "Lockout tagout is required before any pump maintenance.",
            },
        ],
    ),
    (
        "manual",
        [
            {
                "external_id": "bearing-service",
                "title": "Bearing service interval",
                "text": "Lubricate the pump bearings every 500 operating hours.",
            },
            {
                "external_id": "alignment",
                "title": "Coupling alignment",
                "text": "Align the pump coupling within 0.05 mm before operation.",
            },
        ],
    ),
]

# (query, expected external_id)
EVAL_CASES: list[tuple[str, str]] = [
    ("how often should I lubricate the pump bearings", "bearing-service"),
    ("is lockout required before pump maintenance", "pump-lockout"),
    ("pump coupling alignment tolerance", "alignment"),
    ("pump startup checklist", "pump-startup"),
]


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


def _principal(name: str = "admin") -> Principal:
    return Principal(
        user_id=name,
        username=name,
        tenant_id=1,
        actor_id=1,
        permissions=POWER_USER,
    )


def _ingest_all(client: TestClient) -> None:
    for code, documents in CORPUS:
        source = client.post(
            "/api/v1/ai/knowledge/sources",
            json={"code": code, "name": code, "kind": "manual"},
        )
        assert source.status_code == 201, source.text
        response = client.post(
            f"/api/v1/ai/knowledge/sources/{source.json()['id']}/ingest",
            json={"documents": documents},
        )
        assert response.status_code == 202
        assert response.json()["job"]["status"] == "succeeded"


def _dcg(gains: list[float]) -> float:
    return sum(gain / math.log2(index + 2) for index, gain in enumerate(gains))


def test_labeled_relevance_ndcg_at_3() -> None:
    repository = InMemoryAiRepository()
    with _client(repository, _principal()) as client:
        _ingest_all(client)
        scores: list[float] = []
        for query, expected in EVAL_CASES:
            response = client.post(
                "/api/v1/ai/search", json={"query": query, "limit": 3}
            )
            assert response.status_code == 200, response.text
            external_ids = [item["external_id"] for item in response.json()["results"]]
            gains = [1.0 if external_id == expected else 0.0 for external_id in external_ids]
            assert any(gains), (query, expected, external_ids)
            ideal = [1.0]
            scores.append(_dcg(gains) / _dcg(ideal))

    assert sum(scores) / len(scores) >= 0.8


def test_filters_do_not_widen_authorization() -> None:
    repository = InMemoryAiRepository()
    with _client(repository, _principal()) as client:
        source = client.post(
            "/api/v1/ai/knowledge/sources",
            json={"code": "mixed", "name": "mixed", "kind": "manual"},
        ).json()
        client.post(
            f"/api/v1/ai/knowledge/sources/{source['id']}/ingest",
            json={
                "documents": [
                    {"external_id": "open-1", "text": "pump procedure baseline"},
                    {
                        "external_id": "secret-1",
                        "text": "pump procedure baseline",
                        "classification": "restricted",
                    },
                ]
            },
        )
        response = client.post(
            "/api/v1/ai/search",
            json={
                "query": "pump procedure",
                "filters": [{"field": "external_id", "op": "eq", "value": "secret-1"}],
            },
        )
    assert response.status_code == 200
    assert all(item["external_id"] != "secret-1" for item in response.json()["results"])


def test_search_latency_is_bounded() -> None:
    repository = InMemoryAiRepository()
    with _client(repository, _principal()) as client:
        _ingest_all(client)
        started = time.perf_counter()
        for _ in range(20):
            response = client.post(
                "/api/v1/ai/search", json={"query": "pump maintenance", "limit": 10}
            )
            assert response.status_code == 200
        elapsed = time.perf_counter() - started

    assert elapsed < 5.0
