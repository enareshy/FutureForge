from __future__ import annotations

import httpx
import pytest

from ai_api.domain.errors import AuthenticationError
from ai_api.security.enterprise_identity import (
    EnterpriseIdentityClient,
    EnterpriseIdentityProvider,
)


def _client(handler, *, timeout: float = 5.0) -> EnterpriseIdentityClient:
    return EnterpriseIdentityClient(
        "http://enterprise.test",
        timeout=timeout,
        transport=httpx.MockTransport(handler),
    )


async def test_resolves_principal_from_enterprise_iam() -> None:
    calls = {"me": 0, "effective": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/me":
            calls["me"] += 1
            assert request.headers["authorization"] == "Bearer session-token"
            return httpx.Response(
                200,
                json={
                    "user": {
                        "id": 7,
                        "username": "alice",
                        "status": "active",
                        "organization_id": 12,
                        "tenant_id": 3,
                    },
                    "access": {"roles": [{"code": "iam.admin"}]},
                    "session": {"tenant_id": 3},
                },
            )
        if request.url.path == "/api/authorization/effective/7":
            calls["effective"] += 1
            return httpx.Response(
                200,
                json={"permissions": [{"code": "ai.chat:execute"}, {"code": "ai.platform:read"}]},
            )
        return httpx.Response(404)

    provider = EnterpriseIdentityProvider(_client(handler), cache_ttl_seconds=30)
    principal = await provider.resolve("session-token")

    assert principal.user_id == "7"
    assert principal.actor_id == 7
    assert principal.username == "alice"
    assert principal.tenant_id == 3
    assert principal.organization_id == 12
    assert principal.roles == frozenset({"iam.admin"})
    assert "ai.chat:execute" in principal.permissions
    assert principal.auth_source == "enterprise"

    again = await provider.resolve("session-token")
    assert again == principal
    assert calls["me"] == 1
    assert calls["effective"] == 1


async def test_rejects_expired_session() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    provider = EnterpriseIdentityProvider(_client(handler))
    with pytest.raises(AuthenticationError):
        await provider.resolve("expired")


async def test_rejects_inactive_user() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"user": {"id": 9, "username": "bob", "status": "inactive"}},
        )

    provider = EnterpriseIdentityProvider(_client(handler))
    with pytest.raises(AuthenticationError):
        await provider.resolve("token")


async def test_fails_closed_when_enterprise_unreachable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    provider = EnterpriseIdentityProvider(_client(handler))
    with pytest.raises(AuthenticationError):
        await provider.resolve("token")


async def test_missing_token_is_rejected() -> None:
    provider = EnterpriseIdentityProvider(_client(lambda request: httpx.Response(200, json={})))
    with pytest.raises(AuthenticationError):
        await provider.resolve("")
