from __future__ import annotations

from dataclasses import dataclass, field

from ai_api.domain.errors import AuthorizationError


@dataclass(frozen=True, slots=True)
class Principal:
    """The authenticated caller.

    Built from a verified enterprise session; never from browser-supplied data.
    `permissions` are enterprise permission codes (`<resource>:<action>`); `roles`
    are enterprise role codes retained for auditing and policy decisions.
    """

    user_id: str
    username: str
    tenant_id: int | None = None
    organization_id: int | None = None
    actor_id: int | None = None
    permissions: frozenset[str] = frozenset()
    roles: frozenset[str] = frozenset()
    auth_source: str = "unknown"


class Policy:
    """Permission checks over a principal's effective enterprise permissions.

    Wildcards: `*:*` grants everything, `<resource>:*` grants all actions on a
    resource, and any permission in `superuser_permissions` grants everything
    (used to map the enterprise platform-admin permission). Authorization is
    always evaluated server-side; the LLM is never trusted to enforce it.
    """

    def __init__(self, superuser_permissions: frozenset[str] = frozenset()) -> None:
        self._superuser = superuser_permissions

    def can(self, principal: Principal, permission: str) -> bool:
        permissions = principal.permissions
        if "*:*" in permissions or permission in permissions:
            return True
        if self._superuser and permissions & self._superuser:
            return True
        resource = permission.split(":", 1)[0]
        return f"{resource}:*" in permissions

    def is_superuser(self, principal: Principal) -> bool:
        """True when the principal holds the platform-wide wildcard or a
        configured platform-admin permission."""
        if "*:*" in principal.permissions:
            return True
        return bool(self._superuser and principal.permissions & self._superuser)

    def require(self, principal: Principal, permission: str, *, message: str | None = None) -> None:
        if not self.can(principal, permission):
            raise AuthorizationError(
                message or "not authorized for this action",
                details={"required_permission": permission},
            )


@dataclass(frozen=True, slots=True)
class PermissionMap:
    """Maps AI capability codes to the enterprise permission they require."""

    mapping: dict[str, str] = field(default_factory=dict)

    def permission_for(self, capability: str) -> str:
        return self.mapping.get(capability, capability)
