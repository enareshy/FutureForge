from __future__ import annotations

import pytest

from ai_api.config.settings import Settings
from ai_api.domain.errors import AuthorizationError, ConfigurationError
from ai_api.security.permissions import build_permission_map, parse_permission_list
from ai_api.security.policies import PermissionMap, Policy, Principal


def _principal(*permissions: str) -> Principal:
    return Principal(user_id="1", username="u", permissions=frozenset(permissions))


def test_wildcard_grants_everything() -> None:
    policy = Policy()
    assert policy.can(_principal("*:*"), "ai.chat:execute")


def test_resource_wildcard() -> None:
    policy = Policy()
    assert policy.can(_principal("ai.chat:*"), "ai.chat:execute")
    assert not policy.can(_principal("ai.knowledge:*"), "ai.chat:execute")


def test_exact_permission_required() -> None:
    policy = Policy()
    assert policy.can(_principal("ai.chat:execute"), "ai.chat:execute")
    assert not policy.can(_principal("ai.chat:execute"), "ai.knowledge:read")


def test_require_raises_with_details() -> None:
    policy = Policy()
    with pytest.raises(AuthorizationError) as excinfo:
        policy.require(_principal("ai.chat:execute"), "ai.audit:read")
    assert excinfo.value.details["required_permission"] == "ai.audit:read"


def test_permission_map_defaults_and_override() -> None:
    default = PermissionMap(build_permission_map(Settings(ai_permission_map="")))
    assert default.permission_for("chat.execute") == "ai.chat:execute"

    overridden = PermissionMap(
        build_permission_map(Settings(ai_permission_map='{"chat.execute": "custom:run"}'))
    )
    assert overridden.permission_for("chat.execute") == "custom:run"
    assert overridden.permission_for("audit.read") == "ai.audit:read"


def test_permission_map_rejects_invalid_json() -> None:
    with pytest.raises(ConfigurationError):
        build_permission_map(Settings(ai_permission_map="{not json"))


def test_superuser_permission_grants_everything() -> None:
    policy = Policy(superuser_permissions=frozenset({"iam.platform:read"}))
    assert policy.can(_principal("iam.platform:read"), "ai.chat:execute")
    assert not policy.can(_principal("ai.chat:execute"), "ai.knowledge:read")


def test_parse_permission_list() -> None:
    assert parse_permission_list("a:b, c:d ,,") == frozenset({"a:b", "c:d"})
    assert parse_permission_list("") == frozenset()
