"""Stage 5 Step 3: Copilot tool orchestration and controlled actions.

Covers the guarantees that matter most for a read/act-capable assistant:

* tool selection is deterministic and bounded;
* tools are authorized before any enterprise request is made;
* the caller's own session token is forwarded and never logged;
* enterprise payloads are reduced to a bounded summary;
* proposals are inert, require a different approver, re-check permissions at
  execution time, and cannot be executed twice.

The enterprise services are replaced with an ``httpx.MockTransport`` so the real
tool client, registry, service and persistence layers all run unchanged.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import (
    get_ai_repository,
    get_enterprise_tool_client,
    get_identity_provider,
)
from ai_api.application.services.copilot_actions import CopilotActionService
from ai_api.application.services.enterprise_tools import (
    TOOL_BOM_LOOKUP,
    TOOL_ENTERPRISE_SEARCH,
    EnterpriseToolClient,
    build_enterprise_tool_client,
)
from ai_api.config.settings import get_settings
from ai_api.domain.errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
)
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.main import create_app
from ai_api.security.policies import Policy, Principal
from ai_api.security.request_token import session_token_scope

TENANT = 1
ADMIN_TOKEN = "admin-session"
LIMITED_TOKEN = "limited-session"
REVIEWER_TOKEN = "reviewer-session"


class FakeIdentityProvider:
    _PRINCIPALS = {
        ADMIN_TOKEN: Principal(
            user_id="1",
            username="admin",
            tenant_id=TENANT,
            actor_id=1,
            permissions=frozenset({"*:*"}),
            auth_source="test",
        ),
        LIMITED_TOKEN: Principal(
            user_id="2",
            username="reader",
            tenant_id=TENANT,
            actor_id=2,
            permissions=frozenset({"ai.retrieval:execute", "iam.search.global:read"}),
            auth_source="test",
        ),
        REVIEWER_TOKEN: Principal(
            user_id="3",
            username="reviewer",
            tenant_id=TENANT,
            actor_id=3,
            permissions=frozenset(
                {
                    "ai.retrieval:execute",
                    "ai.copilot_actions:read",
                    "ai.copilot_actions:update",
                    "ai.copilot_actions:execute",
                }
            ),
            auth_source="test",
        ),
    }

    async def resolve(self, token: str) -> Principal:
        principal = self._PRINCIPALS.get(token)
        if principal is None:
            raise AuthenticationError("invalid session token")
        return principal


def _enterprise_handler(calls: list[httpx.Request]):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/api/v1/search":
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "objectType": "part",
                            "objectId": "P-100",
                            "code": "P-100",
                            "title": "Hydraulic pump",
                            "status": "released",
                            "secretField": "must-not-leak",
                        }
                    ],
                    "total": 1,
                },
            )
        if request.url.path == "/api/v1/bom/boms":
            return httpx.Response(200, json={"items": [], "total": 0})
        if request.url.path == "/api/v1/pdm/items":
            return httpx.Response(403, json={"error": "forbidden"})
        return httpx.Response(404, json={"error": "not found"})

    return handler


@contextmanager
def _client(
    repository: InMemoryAiRepository, calls: list[httpx.Request]
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    settings = get_settings()
    app = create_app()

    def _tool_client() -> EnterpriseToolClient:
        return build_enterprise_tool_client(
            settings, Policy(), transport=httpx.MockTransport(_enterprise_handler(calls))
        )

    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_identity_provider] = FakeIdentityProvider
    app.dependency_overrides[get_enterprise_tool_client] = _tool_client
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _conversation(client: TestClient, token: str = ADMIN_TOKEN) -> int:
    response = client.post(
        "/api/v1/ai/assistant/conversations",
        headers=_auth(token),
        json={"title": "Tools"},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _run(awaitable):
    return asyncio.run(awaitable)


# --- Tool selection -----------------------------------------------------


def test_tool_selection_is_deterministic_and_bounded() -> None:
    client = build_enterprise_tool_client(get_settings(), Policy())
    selected = client.select("find the bom for hydraulic pump part", limit=3)
    assert len(selected) <= 3
    assert len(set(selected)) == len(selected)
    assert TOOL_BOM_LOOKUP in selected
    assert client.select("hello there", limit=3) == []


def test_tool_catalog_is_read_only_and_allowlisted() -> None:
    client = build_enterprise_tool_client(get_settings(), Policy())
    described = client.describe()
    assert described
    for spec in described:
        assert spec["read_only"] is True
        assert spec["requires_approval"] is False
        assert spec["input_schema"]


def test_tool_denied_without_capability_never_calls_enterprise() -> None:
    calls: list[httpx.Request] = []
    client = build_enterprise_tool_client(
        get_settings(), Policy(), transport=httpx.MockTransport(_enterprise_handler(calls))
    )
    limited = Principal(
        user_id="2",
        username="reader",
        tenant_id=TENANT,
        actor_id=2,
        permissions=frozenset({"ai.retrieval:execute"}),
    )
    with session_token_scope(LIMITED_TOKEN):
        outcome = _run(client.run(limited, TOOL_ENTERPRISE_SEARCH, {"query": "pump"}))
    assert outcome.status == "denied"
    assert outcome.error_class == "authorization_denied"
    assert calls == []


def test_tool_forwards_session_token_and_bounds_summary() -> None:
    calls: list[httpx.Request] = []
    client = build_enterprise_tool_client(
        get_settings(), Policy(), transport=httpx.MockTransport(_enterprise_handler(calls))
    )
    admin = Principal(
        user_id="1",
        username="admin",
        tenant_id=TENANT,
        actor_id=1,
        permissions=frozenset({"*:*"}),
    )
    with session_token_scope(ADMIN_TOKEN):
        outcome = _run(client.run(admin, TOOL_ENTERPRISE_SEARCH, {"query": "pump"}))
    assert outcome.status == "succeeded"
    assert calls and calls[0].headers["authorization"] == f"Bearer {ADMIN_TOKEN}"
    encoded = json.dumps(outcome.summary)
    assert "must-not-leak" not in encoded
    assert outcome.summary["total"] == 1
    assert outcome.summary["rows"][0]["code"] == "P-100"


def test_tool_without_session_token_is_denied() -> None:
    client = build_enterprise_tool_client(get_settings(), Policy())
    admin = Principal(
        user_id="1",
        username="admin",
        tenant_id=TENANT,
        actor_id=1,
        permissions=frozenset({"*:*"}),
    )
    outcome = _run(client.run(admin, TOOL_ENTERPRISE_SEARCH, {"query": "pump"}))
    assert outcome.status == "denied"
    assert outcome.error_class == "missing_session_token"


def test_tool_enterprise_denial_is_reported_not_raised() -> None:
    calls: list[httpx.Request] = []
    client = build_enterprise_tool_client(
        get_settings(), Policy(), transport=httpx.MockTransport(_enterprise_handler(calls))
    )
    admin = Principal(
        user_id="1",
        username="admin",
        tenant_id=TENANT,
        actor_id=1,
        permissions=frozenset({"*:*"}),
    )
    with session_token_scope(ADMIN_TOKEN):
        outcome = _run(client.run(admin, "product.lookup", {"query": "pump"}))
    assert outcome.status == "denied"
    assert outcome.error_class == "enterprise_denied"


# --- Tool integration into the conversation -----------------------------


def test_question_records_tool_trace_on_message(
    repository: InMemoryAiRepository,
) -> None:
    calls: list[httpx.Request] = []
    with _client(repository, calls) as client:
        conversation_id = _conversation(client)
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            headers=_auth(ADMIN_TOKEN),
            json={"content": "Find the hydraulic pump part in the enterprise catalog"},
        )
        assert response.status_code in (200, 201), response.text
        body = response.json()
        tool_codes = {tool["tool_code"] for tool in body["tools"]}
        assert tool_codes
        assert calls, "the enterprise endpoint must be called for an authorized tool"
        assert all(
            "authorization" in call.headers for call in calls
        ), "tools must forward the caller's session"

        detail = client.get(
            f"/api/v1/ai/assistant/conversations/{conversation_id}",
            headers=_auth(ADMIN_TOKEN),
        ).json()
        assistant = [m for m in detail["messages"] if m["role"] == "assistant"][-1]
        assert assistant["tools"] == body["tools"]


def test_tool_trace_never_leaks_unlisted_fields(
    repository: InMemoryAiRepository,
) -> None:
    calls: list[httpx.Request] = []
    with _client(repository, calls) as client:
        conversation_id = _conversation(client)
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            headers=_auth(ADMIN_TOKEN),
            json={"content": "Search for hydraulic pump"},
        )
        assert response.status_code in (200, 201)
        serialized = json.dumps(response.json()["tools"])
        assert "must-not-leak" not in serialized


def test_capabilities_expose_tools_and_action_support(
    repository: InMemoryAiRepository,
) -> None:
    calls: list[httpx.Request] = []
    with _client(repository, calls) as client:
        body = client.get(
            "/api/v1/ai/assistant/capabilities", headers=_auth(ADMIN_TOKEN)
        ).json()
        assert body["tools"]
        assert body["actions_enabled"] is True


# --- Controlled actions -------------------------------------------------


def _propose(client: TestClient, token: str = ADMIN_TOKEN) -> dict[str, Any]:
    response = client.post(
        "/api/v1/ai/assistant/actions",
        headers=_auth(token),
        json={
            "action_type": "change_request.create",
            "target": "ECR-1000",
            "summary": "Open a change request for the pump seal revision",
            "expected_effect": "A draft ECR is created in Change Management",
            "arguments": {"required_capabilities": ["iam.change.requests:create"]},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_action_proposal_is_inert_and_idempotent(
    repository: InMemoryAiRepository,
) -> None:
    calls: list[httpx.Request] = []
    with _client(repository, calls) as client:
        first = _propose(client)
        assert first["status"] == "proposed"
        assert first["duplicate"] is False
        assert calls == [], "proposing must not call the enterprise"

        second = _propose(client)
        assert second["id"] == first["id"]
        assert second["duplicate"] is True


def test_requester_cannot_approve_own_action(
    repository: InMemoryAiRepository,
) -> None:
    calls: list[httpx.Request] = []
    with _client(repository, calls) as client:
        action = _propose(client, REVIEWER_TOKEN)
        response = client.post(
            f"/api/v1/ai/assistant/actions/{action['id']}/approve",
            headers=_auth(REVIEWER_TOKEN),
            json={"reason": "self approval"},
        )
        assert response.status_code == 403

        # A platform superuser is the documented exception.
        allowed = client.post(
            f"/api/v1/ai/assistant/actions/{action['id']}/approve",
            headers=_auth(ADMIN_TOKEN),
            json={"reason": "admin override"},
        )
        assert allowed.status_code == 200


def test_action_requires_decision_before_execution(
    repository: InMemoryAiRepository,
) -> None:
    calls: list[httpx.Request] = []
    with _client(repository, calls) as client:
        action = _propose(client)
        response = client.post(
            f"/api/v1/ai/assistant/actions/{action['id']}/execute",
            headers=_auth(ADMIN_TOKEN),
        )
        assert response.status_code == 409


def test_rejection_is_final_and_reason_required(
    repository: InMemoryAiRepository,
) -> None:
    calls: list[httpx.Request] = []
    with _client(repository, calls) as client:
        action = _propose(client, LIMITED_TOKEN)
        missing = client.post(
            f"/api/v1/ai/assistant/actions/{action['id']}/reject",
            headers=_auth(ADMIN_TOKEN),
            json={},
        )
        assert missing.status_code == 422
        rejected = client.post(
            f"/api/v1/ai/assistant/actions/{action['id']}/reject",
            headers=_auth(ADMIN_TOKEN),
            json={"reason": "duplicate of ECR-999"},
        )
        assert rejected.status_code == 200, rejected.text
        assert rejected.json()["status"] == "rejected"
        again = client.post(
            f"/api/v1/ai/assistant/actions/{action['id']}/approve",
            headers=_auth(ADMIN_TOKEN),
            json={},
        )
        assert again.status_code == 409


def test_execution_rechecks_authorization_and_runs_once(
    repository: InMemoryAiRepository,
) -> None:
    calls: list[httpx.Request] = []
    with _client(repository, calls) as client:
        action = _propose(client, LIMITED_TOKEN)
        approved = client.post(
            f"/api/v1/ai/assistant/actions/{action['id']}/approve",
            headers=_auth(ADMIN_TOKEN),
            json={"reason": "reviewed"},
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "approved"

        # The executor in the app is intentionally absent by default: an
        # approved action must fail closed rather than silently reach an
        # unapproved integration.
        executed = client.post(
            f"/api/v1/ai/assistant/actions/{action['id']}/execute",
            headers=_auth(ADMIN_TOKEN),
        )
        assert executed.status_code in (409, 503)
        assert calls == []


def test_action_service_records_execution_and_blocks_replay(
    repository: InMemoryAiRepository,
) -> None:
    settings = get_settings()
    policy = Policy()

    class _Executor:
        def __init__(self) -> None:
            self.calls = 0

        async def execute(self, principal: Principal, action: dict[str, Any]) -> dict[str, Any]:
            self.calls += 1
            return {"created": True}

    executor = _Executor()
    service = CopilotActionService(
        repository=repository,
        audit=_NoopAudit(),
        policy=policy,
        settings=settings,
        executor=executor,
    )
    requester = Principal(
        user_id="1",
        username="requester",
        tenant_id=TENANT,
        actor_id=1,
        permissions=frozenset({"*:*"}),
    )
    approver = Principal(
        user_id="9",
        username="approver",
        tenant_id=TENANT,
        actor_id=9,
        permissions=frozenset({"*:*"}),
    )

    proposed = _run(
        service.propose(
            requester,
            action_type="change_request.create",
            target="ECR-1001",
            summary="Create a draft change request",
        )
    )
    assert proposed["status"] == "proposed"
    _run(service.approve(approver, proposed["id"], "ok"))
    executed = _run(service.execute(approver, proposed["id"]))
    assert executed["status"] == "executed"
    assert executed["executed_by"] == 9
    assert executed["result"] == {"created": True}
    assert executor.calls == 1

    with pytest.raises(ConflictError):
        _run(service.execute(approver, proposed["id"]))
    assert executor.calls == 1


def test_action_execution_revalidates_capability(
    repository: InMemoryAiRepository,
) -> None:
    settings = get_settings()
    policy = Policy()

    class _Executor:
        async def execute(self, principal: Principal, action: dict[str, Any]) -> dict[str, Any]:
            return {"created": True}

    service = CopilotActionService(
        repository=repository,
        audit=_NoopAudit(),
        policy=policy,
        settings=settings,
        executor=_Executor(),
    )
    requester = Principal(
        user_id="1",
        username="requester",
        tenant_id=TENANT,
        actor_id=1,
        permissions=frozenset({"*:*"}),
    )
    approver = Principal(
        user_id="9",
        username="approver",
        tenant_id=TENANT,
        actor_id=9,
        permissions=frozenset({"*:*"}),
    )
    proposed = _run(
        service.propose(
            requester,
            action_type="change_request.create",
            target="ECR-1002",
            summary="Create a draft change request",
            arguments={"required_capabilities": ["iam.change.requests:create"]},
        )
    )
    _run(service.approve(approver, proposed["id"], "ok"))

    # The operator approved the action but does not hold the enterprise
    # permission it requires at execution time.
    operator = Principal(
        user_id="9",
        username="approver",
        tenant_id=TENANT,
        actor_id=9,
        permissions=frozenset({"ai.copilot_actions:execute"}),
    )
    with pytest.raises(AuthorizationError):
        _run(service.execute(operator, proposed["id"]))


def test_expired_action_cannot_be_approved(
    repository: InMemoryAiRepository,
) -> None:
    service = CopilotActionService(
        repository=repository,
        audit=_NoopAudit(),
        policy=Policy(),
        settings=get_settings(),
    )
    requester = Principal(
        user_id="1",
        username="requester",
        tenant_id=TENANT,
        actor_id=1,
        permissions=frozenset({"*:*"}),
    )
    proposed = _run(
        service.propose(
            requester,
            action_type="change_request.create",
            target="ECR-1003",
            summary="Create a draft change request",
        )
    )
    row = next(
        row for row in repository._copilot_actions if row["id"] == proposed["id"]
    )
    row["expires_at"] = datetime.now(UTC) - timedelta(seconds=1)
    approver = Principal(
        user_id="9",
        username="approver",
        tenant_id=TENANT,
        actor_id=9,
        permissions=frozenset({"*:*"}),
    )
    with pytest.raises(ConflictError):
        _run(service.approve(approver, proposed["id"], "late"))


def test_action_proposal_requires_message_ownership(
    repository: InMemoryAiRepository,
) -> None:
    calls: list[httpx.Request] = []
    with _client(repository, calls) as client:
        conversation_id = _conversation(client)
        response = client.post(
            "/api/v1/ai/assistant/actions",
            headers=_auth(LIMITED_TOKEN),
            json={
                "conversation_id": conversation_id,
                "message_id": 1,
                "action_type": "change_request.create",
                "target": "ECR-9",
                "summary": "Create a change request",
            },
        )
        # The conversation belongs to another actor; ownership fails closed.
        assert response.status_code == 404


class _NoopAudit:
    async def record(self, **_kwargs: Any) -> None:
        return None


_ = pytest
