from __future__ import annotations

from ai_api.security.access_control import AccessControl, within_ceiling
from ai_api.security.policies import Policy, Principal


def _principal(**overrides: object) -> Principal:
    base: dict[str, object] = {"user_id": "1", "username": "u", "tenant_id": 1}
    base.update(overrides)
    return Principal(**base)  # type: ignore[arg-type]


def test_empty_acl_allows_tenant_member() -> None:
    control = AccessControl(policy=Policy())
    assert control.allows(_principal(), {}) is True
    assert control.allows(_principal(), None) is True


def test_deny_all_blocks_non_superuser_but_not_superuser() -> None:
    control = AccessControl(policy=Policy())
    assert control.allows(_principal(), {"deny_all": True}) is False
    superuser = _principal(permissions=frozenset({"*:*"}))
    assert control.allows(superuser, {"deny_all": True}) is True


def test_acl_matches_roles_permissions_and_users() -> None:
    control = AccessControl(policy=Policy())

    assert control.allows(_principal(roles=frozenset({"iam.admin"})), {"roles": ["iam.admin"]})
    assert control.allows(
        _principal(permissions=frozenset({"ai.knowledge:read"})),
        {"permissions": ["ai.knowledge:read"]},
    )
    assert control.allows(_principal(username="j.patel"), {"users": ["j.patel"]})

    assert control.allows(_principal(username="x"), {"roles": ["iam.admin"]}) is False
    assert control.allows(_principal(username="x"), {"users": ["m.okonkwo"]}) is False


def test_superuser_bypasses_constrained_acl() -> None:
    admin = _principal(permissions=frozenset({"iam.platform:read"}))
    control = AccessControl(
        policy=Policy(superuser_permissions=frozenset({"iam.platform:read"}))
    )
    assert control.allows(admin, {"users": ["someone-else"]}) is True


def test_within_ceiling() -> None:
    assert within_ceiling("public", "internal") is True
    assert within_ceiling("internal", "internal") is True
    assert within_ceiling("restricted", "internal") is False
    assert within_ceiling("restricted", None) is True
