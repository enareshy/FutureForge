"""The API database profile must never enter cross-tenant system scope.

``ai_api`` is deliberately not a member of ``ai_system_access`` (migration
0019). Without an application-level guard, an accidental ``system_scope()`` on
the API path would not raise: the query would simply return zero rows once RLS
filtered it, which is a silent correctness failure rather than a loud one.

These tests pin the guard itself. They run without a database: the boundary
must be enforced before any connection or query is attempted.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from ai_api.config.settings import get_settings
from ai_api.domain.errors import ConfigurationError
from ai_api.infrastructure.db.tenant_context import (
    current_rls_context,
    system_scope,
    tenant_scope,
)

TENANT_ID = 4242


@pytest.fixture()
def profile(monkeypatch):
    """Set AI_DB_ROLE_PROFILE for one test and restore the settings cache."""

    def _set(value: str) -> None:
        monkeypatch.setenv("AI_DB_ROLE_PROFILE", value)
        get_settings.cache_clear()

    yield _set
    get_settings.cache_clear()


def test_api_profile_cannot_enter_system_scope(profile) -> None:
    profile("api")
    with pytest.raises(ConfigurationError) as excinfo:
        with system_scope():
            pytest.fail("system scope must not be entered for the API profile")
    assert excinfo.value.details["role_profile"] == "api"
    assert "system scope" in str(excinfo.value)


def test_rejection_happens_before_database_access(profile) -> None:
    """The guard raises on context entry, before any query can run."""

    profile("api")
    executed: list[str] = []

    async def scenario() -> None:
        with pytest.raises(ConfigurationError):
            with system_scope():
                # Any code here would imply the guard ran too late.
                executed.append("body entered")
                await asyncio.sleep(0)

    asyncio.run(scenario())
    assert executed == []


def test_rejection_does_not_change_the_active_scope(profile) -> None:
    """A refused system scope must not leave system context behind."""

    profile("api")
    with tenant_scope(TENANT_ID):
        with pytest.raises(ConfigurationError):
            with system_scope():
                pytest.fail("unreachable")
        relaxed = current_rls_context()
        assert relaxed.system is False
        assert relaxed.tenant_id == TENANT_ID


@pytest.mark.parametrize("role_profile", ["worker", "backup", "migrate"])
def test_trusted_profiles_still_enter_system_scope(profile, role_profile: str) -> None:
    profile(role_profile)
    with system_scope():
        assert current_rls_context().system is True
    assert current_rls_context().system is False


def test_unset_profile_keeps_development_and_test_behavior(profile) -> None:
    """Blank profile is the development/in-memory case; behavior is unchanged."""

    profile("")
    with system_scope():
        assert current_rls_context().system is True


def test_tenant_scope_is_unaffected_by_the_api_profile(profile) -> None:
    """Normal tenant-scoped API work must keep working under ``api``."""

    profile("api")
    with tenant_scope(TENANT_ID):
        context = current_rls_context()
        assert context.tenant_id == TENANT_ID
        assert context.system is False


def test_reconcile_stays_tenant_scoped_under_the_api_profile(profile) -> None:
    """The single-tenant reconcile route must keep working as ``ai_api``.

    ``POST /knowledge/reconcile`` resolves a tenant from the principal and never
    enters system scope, so it is safe for the API profile. Repeated calls are
    idempotent while the queued job is still active.
    """

    from ai_api.api import deps as deps_module
    from ai_api.api.deps import get_ai_repository, get_principal
    from ai_api.infrastructure.repositories import InMemoryAiRepository
    from ai_api.main import create_app
    from ai_api.security.policies import Principal

    profile("api")
    repository = InMemoryAiRepository()
    principal = Principal(
        user_id="admin",
        username="admin",
        tenant_id=TENANT_ID,
        actor_id=1,
        permissions=frozenset({"*:*"}),
    )

    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_principal] = lambda: principal
    try:
        with TestClient(app) as client:
            source = client.post(
                "/api/v1/ai/knowledge/sources",
                json={"code": "needs-work", "name": "needs-work", "kind": "manual"},
            ).json()
            ingest = client.post(
                f"/api/v1/ai/knowledge/sources/{source['id']}/ingest",
                json={"documents": [{"external_id": "w1", "text": "guide one"}]},
            )
            assert ingest.status_code == 202

            for document in repository._documents:
                document["status"] = "failed"
                document["error_class"] = "provider"

            first = client.post("/api/v1/ai/knowledge/reconcile")
            assert first.status_code == 200
            body = first.json()
            assert body["sources_queued"] == 1
            assert len(body["jobs"]) == 1

            second = client.post("/api/v1/ai/knowledge/reconcile")
            assert second.status_code == 200
            assert second.json()["sources_queued"] == 0
    finally:
        app.dependency_overrides.clear()
