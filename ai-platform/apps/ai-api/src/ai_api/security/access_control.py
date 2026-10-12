"""Object-level access control for retrieval (Phase 7).

Authorization is applied server-side and *before* retrieved content is used.
Similarity/ranking is never an authorization signal: every candidate chunk is
checked against its access-control labels and the tenant's classification
ceiling.

ACL document shape (all keys optional):

```json
{
  "deny_all": false,
  "roles": ["iam.admin"],
  "permissions": ["ai.knowledge:read"],
  "users": ["m.okonkwo"]
}
```

Semantics:
- Empty/absent ACL -> any member of the tenant (tenant scoping is enforced at the
  query layer and is not represented here).
- `deny_all: true` -> nobody, except a platform superuser.
- Otherwise the principal must match at least one listed role, permission or
  user. Unknown keys are ignored (fail closed only when keys are present).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ai_api.security.policies import Policy, Principal

CLASSIFICATION_ORDER = ("public", "internal", "confidential", "restricted")

_ACL_KEYS = ("roles", "permissions", "users")


def classification_rank(value: str) -> int:
    try:
        return CLASSIFICATION_ORDER.index(value)
    except ValueError:
        return len(CLASSIFICATION_ORDER)


def within_ceiling(classification: str | None, ceiling: str | None) -> bool:
    if not ceiling:
        return True
    return classification_rank(classification or "internal") <= classification_rank(ceiling)


@dataclass(slots=True)
class AccessControl:
    policy: Policy = field(default_factory=Policy)
    superuser_permissions: frozenset[str] = frozenset()

    def is_superuser(self, principal: Principal) -> bool:
        if self.policy.is_superuser(principal):
            return True
        return bool(self.superuser_permissions & principal.permissions)

    def allows(self, principal: Principal, acl: dict[str, Any] | None) -> bool:
        acl = acl or {}
        if acl.get("deny_all") is True:
            return self.is_superuser(principal)
        if self.is_superuser(principal):
            return True

        present = [key for key in _ACL_KEYS if acl.get(key)]
        if not present:
            return True

        roles = set(acl.get("roles") or [])
        if roles and (roles & set(principal.roles)):
            return True
        permissions = acl.get("permissions") or []
        if permissions and any(self.policy.can(principal, perm) for perm in permissions):
            return True
        users = {str(u) for u in (acl.get("users") or [])}
        if users and (principal.username in users or str(principal.actor_id) in users):
            return True
        return False
