"""Shared service helpers."""

from __future__ import annotations

from ai_api.domain.errors import AuthorizationError
from ai_api.security.policies import Principal


def require_tenant(principal: Principal) -> int:
    if principal.tenant_id is None:
        raise AuthorizationError("a tenant context is required for this operation")
    return principal.tenant_id
