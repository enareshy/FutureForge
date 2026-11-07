"""Shared service helpers."""

from __future__ import annotations

from ai_api.domain.errors import AuthorizationError
from ai_api.security.policies import Principal
from ai_api.telemetry.rls_metrics import RLS_CONTEXT_MISSING


def require_tenant(principal: Principal) -> int:
    if principal.tenant_id is None:
        RLS_CONTEXT_MISSING.labels(operation="authorization").inc()
        raise AuthorizationError("a tenant context is required for this operation")
    return principal.tenant_id


def require_actor_id(principal: Principal) -> int:
    """Return the authenticated actor ID, failing closed when it is unusable.

    Conversation ownership is keyed by an enterprise user ID. A missing, empty,
    boolean or otherwise malformed value must never be treated as permission.
    """
    actor_id = principal.actor_id
    if isinstance(actor_id, bool) or not isinstance(actor_id, int) or actor_id <= 0:
        raise AuthorizationError(
            "a valid actor identity is required for this operation"
        )
    return actor_id
