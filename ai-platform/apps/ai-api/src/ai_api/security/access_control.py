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
  user. Unknown keys fail closed: an ACL that contains a key we do not understand
  is treated as denying everyone (except a platform superuser), so a typo can
  never silently broaden access.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from ai_api.domain.errors import ValidationError
from ai_api.security.policies import Policy, Principal

CLASSIFICATION_ORDER = ("public", "internal", "confidential", "restricted")

ACL_KEYS = ("roles", "permissions", "users")
_ACL_KEYS = ACL_KEYS
_ACL_MAX_ENTRIES = 50
_ACL_MAX_VALUE_CHARS = 256
_ACL_MAX_BYTES = 8192


def validate_acl(acl: Any) -> dict[str, Any]:
    """Validate and normalize an ACL supplied through a management API.

    The persisted/evaluated shape is unchanged, but malformed, ambiguous or
    unknown structures are rejected instead of being stored and later failing
    open or closed differently by different readers. List values are trimmed,
    de-duplicated and sorted for deterministic storage and comparisons.
    """

    if not isinstance(acl, dict):
        raise ValidationError("ACL must be an object")
    unknown = sorted(set(acl) - {"deny_all", *_ACL_KEYS})
    if unknown:
        raise ValidationError("ACL contains unsupported keys", details={"keys": unknown})

    deny_all = acl.get("deny_all", False)
    if not isinstance(deny_all, bool):
        raise ValidationError("ACL deny_all must be a boolean")

    normalized: dict[str, Any] = {}
    if deny_all:
        others = [key for key in _ACL_KEYS if acl.get(key)]
        if others:
            raise ValidationError(
                "ACL deny_all cannot be combined with role, permission or user grants",
                details={"keys": others},
            )
        normalized["deny_all"] = True
    elif "deny_all" in acl:
        normalized["deny_all"] = False

    for key in _ACL_KEYS:
        raw = acl.get(key)
        if raw in (None, []):
            continue
        if not isinstance(raw, list):
            raise ValidationError(f"ACL {key} must be a list of strings")
        if len(raw) > _ACL_MAX_ENTRIES:
            raise ValidationError(f"ACL {key} has too many entries")
        values: set[str] = set()
        for value in raw:
            if not isinstance(value, str):
                raise ValidationError(f"ACL {key} entries must be strings")
            value = value.strip()
            if not value:
                raise ValidationError(f"ACL {key} entries must not be empty")
            if len(value) > _ACL_MAX_VALUE_CHARS:
                raise ValidationError(f"ACL {key} entries are too long")
            values.add(value)
        if values:
            normalized[key] = sorted(values)

    if len(json.dumps(normalized, separators=(",", ":")).encode("utf-8")) > _ACL_MAX_BYTES:
        raise ValidationError("ACL is too large")
    return normalized


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
        if acl is None:
            acl = {}
        if not isinstance(acl, dict):
            return False

        deny_all = acl.get("deny_all", False)
        if not isinstance(deny_all, bool):
            return False
        is_superuser = self.is_superuser(principal)
        if deny_all:
            return is_superuser
        if is_superuser:
            return True

        known = {"deny_all", *_ACL_KEYS}
        for key, value in acl.items():
            if key not in known:
                if value not in (None, "", False, [], {}):
                    return False
                continue
            if key == "deny_all" or value is None:
                continue
            if not isinstance(value, list) or any(
                not isinstance(entry, str) or not entry.strip() for entry in value
            ):
                return False

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
