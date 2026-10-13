"""End-to-end copilot flow (Phase 13).

Exercises the full request path through the real app: identity resolution ->
capability authorization -> knowledge registration -> indexing -> authorized
retrieval/RAG with citations -> audit + event records. It also verifies that an
unauthorized principal cannot retrieve a restricted document.

The enterprise identity provider is replaced with a deterministic test provider
(the production provider requires the live IAM), but everything else - middleware,
error handlers, capability checks, retrieval, RAG, audit and events - is the
real code path.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_identity_provider
from ai_api.domain.errors import AuthenticationError
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
ADMIN_TOKEN = "test-admin-token"
ANALYST_TOKEN = "test-analyst-token"

pytestmark = pytest.mark.e2e


class FakeIdentityProvider:
    """Deterministic stand-in for the enterprise session bridge."""

    _PRINCIPALS = {
        ADMIN_TOKEN: Principal(
            user_id="1",
            username="admin",
            tenant_id=TENANT,
            permissions=frozenset({"*:*"}),
            auth_source="test",
        ),
        ANALYST_TOKEN: Principal(
            user_id="2",
            username="analyst",
            tenant_id=TENANT,
            permissions=frozenset({"ai.retrieval:execute"}),
            auth_source="test",
        ),
    }

    async def resolve(self, token: str) -> Principal:
        principal = self._PRINCIPALS.get(token)
        if principal is None:
            raise AuthenticationError("invalid session token")
        return principal


@contextmanager
def _signed_in_client(repository: InMemoryAiRepository) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_identity_provider] = FakeIdentityProvider
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_invalid_session_is_rejected() -> None:
    with _signed_in_client(InMemoryAiRepository()) as client:
        response = client.get("/api/v1/ai/knowledge/sources", headers=_auth("nope"))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_copilot_end_to_end_flow() -> None:
    repository = InMemoryAiRepository()
    with _signed_in_client(repository) as client:
        # 1. Sign in (admin) and register a knowledge source.
        source = client.post(
            "/api/v1/ai/knowledge/sources",
            headers=_auth(ADMIN_TOKEN),
            json={"code": "handbook", "name": "Plant handbook", "kind": "manual"},
        )
        assert source.status_code == 201, source.text
        source_id = source.json()["id"]

        # 2. Index a document (inline processing in the test environment).
        lubrication_text = (
            "The hydraulic pump requires quarterly lubrication of its bearings."
        )
        ingest = client.post(
            f"/api/v1/ai/knowledge/sources/{source_id}/ingest",
            headers=_auth(ADMIN_TOKEN),
            json={
                "documents": [
                    {
                        "external_id": "lubrication",
                        "title": "Pump lubrication",
                        "text": lubrication_text,
                    },
                    {
                        "external_id": "exec-comp",
                        "title": "Executive compensation",
                        "text": "Executive compensation is confidential and restricted.",
                        "classification": "restricted",
                        "acl": {"users": ["chro"]},
                    },
                ]
            },
        )
        assert ingest.status_code == 202
        assert ingest.json()["job"]["status"] == "succeeded"

        # 3. Query through the copilot (RAG) and verify grounded citations.
        rag = client.post(
            "/api/v1/ai/rag/query",
            headers=_auth(ADMIN_TOKEN),
            json={"query": "How often must the hydraulic pump bearings be lubricated?"},
        )
        assert rag.status_code == 200
        body = rag.json()
        assert body["insufficient_evidence"] is False
        assert body["citations"]
        assert body["citations"][0]["source_code"] == "handbook"
        assert "pump" in body["citations"][0]["snippet"].lower()
        request_id = rag.headers["x-request-id"]
        assert body["request_id"] == request_id

        # 4. Inspect audit records: the RAG query is recorded under the same trace.
        audit = client.get("/api/v1/ai/audit", headers=_auth(ADMIN_TOKEN)).json()
        rag_events = [e for e in audit["items"] if e["action"] == "ai.rag.query"]
        assert rag_events, "the RAG query must be audited"
        assert any(e["request_id"] == request_id for e in rag_events)

        # 5. Inspect events: ingest published domain events.
        events = client.get("/api/v1/ai/events", headers=_auth(ADMIN_TOKEN)).json()
        event_types = {e["type"] for e in events}
        assert "KnowledgeSourceRegistered" in event_types

    # 6. An unauthorized principal cannot retrieve the restricted document.
    with _signed_in_client(repository) as client:
        restricted = client.post(
            "/api/v1/ai/search",
            headers=_auth(ANALYST_TOKEN),
            json={"query": "executive compensation confidential", "limit": 10},
        )
        assert restricted.status_code == 200
        restricted_results = restricted.json()["results"]
        assert all(
            "confidential" not in r["content"].lower() for r in restricted_results
        )

        allowed = client.post(
            "/api/v1/ai/search",
            headers=_auth(ANALYST_TOKEN),
            json={"query": "hydraulic pump lubrication", "limit": 10},
        )
        assert allowed.status_code == 200
        assert allowed.json()["count"] >= 1
        assert all(
            r["source_code"] == "handbook" for r in allowed.json()["results"]
        )
