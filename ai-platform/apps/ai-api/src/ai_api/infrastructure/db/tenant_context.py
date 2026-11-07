"""Transaction-scoped tenant context for PostgreSQL row-level security.

The application never sends tenant identity to PostgreSQL through SQL
parameters that callers can override. Instead, every database transaction
started by :class:`PostgresDatabase` sets the custom setting
``ai.tenant_id`` with ``set_config(..., is_local=true)``. PostgreSQL resets
that value when the transaction ends, so a pooled connection cannot retain one
tenant's identity for the next request or job.

Only two scopes exist:

* :func:`tenant_scope` - a single validated tenant from an authenticated
  principal or a claimed tenant-scoped background job.
* :func:`system_scope` - a deliberate cross-tenant operation (worker claim,
  reconciliation tenant discovery, backup, maintenance). It is never derived
  from client input.

The helpers are context variables so an ``asyncio`` task inherits the scope it
was started in, and concurrent tasks do not share mutable tenant state.

System scope is additionally gated on the configured database role profile.
The API runtime role (``ai_api``) is deliberately not a member of
``ai_system_access``, so entering system scope under that profile could only
produce silently empty result sets. :func:`system_scope` refuses up front
instead of relying on row-level security to return zero rows.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from ai_api.config.settings import get_settings
from ai_api.domain.errors import ConfigurationError

# Role profiles that are permitted to request cross-tenant system scope. These
# mirror the profiles that are members of ``ai_system_access``. The API profile
# is intentionally absent: ``ai_api`` is not a member (see migration 0019), so
# system scope there can only produce silently empty result sets.
_SYSTEM_SCOPE_PROFILES = frozenset({"worker", "backup", "migrate"})


@dataclass(frozen=True, slots=True)
class RlsContext:
    tenant_id: int | None = None
    system: bool = False

    @property
    def is_missing(self) -> bool:
        return self.tenant_id is None and not self.system


_MISSING = RlsContext()
_context: ContextVar[RlsContext] = ContextVar("ai_rls_context", default=_MISSING)


def current_rls_context() -> RlsContext:
    return _context.get()


def current_tenant_id() -> int | None:
    return _context.get().tenant_id


def system_access_enabled() -> bool:
    return _context.get().system


def _validated_tenant(tenant_id: int | None) -> int | None:
    if tenant_id is None:
        return None
    if isinstance(tenant_id, bool) or not isinstance(tenant_id, int) or tenant_id <= 0:
        raise ValueError("tenant_id must be a positive integer")
    return tenant_id


def _assert_system_scope_allowed() -> None:
    """Fail closed when the configured role profile may not cross tenants.

    Runs before any database work so an accidental API-side system query is a
    loud configuration error rather than an empty result set. A blank profile
    (development, tests, in-memory repositories) keeps the previous behavior;
    deployed environments are required to set ``api`` or ``worker`` explicitly.
    """

    profile = get_settings().ai_db_role_profile.strip().lower()
    if not profile or profile in _SYSTEM_SCOPE_PROFILES:
        return
    raise ConfigurationError(
        "system scope is not available to this database role profile",
        details={"role_profile": profile},
    )


@contextmanager
def tenant_scope(tenant_id: int | None) -> Iterator[None]:
    """Run the enclosed work with exactly one tenant context.

    ``None`` deliberately establishes an empty context (fail closed) rather
    than silently inheriting a system scope.
    """

    token = _context.set(RlsContext(tenant_id=_validated_tenant(tenant_id)))
    try:
        yield
    finally:
        _context.reset(token)


@contextmanager
def system_scope() -> Iterator[None]:
    """Run a narrowly scoped cross-tenant operation.

    Use only for global queue discovery/claiming, reconciliation tenant
    enumeration, and backup/maintenance paths. Tenant-scoped handlers must
    still enter :func:`tenant_scope` before touching tenant data.

    Raises :class:`ConfigurationError` before yielding when the configured
    ``AI_DB_ROLE_PROFILE`` is the API profile (or any profile outside the
    trusted set), so the boundary does not depend on RLS quietly returning no
    rows.
    """

    _assert_system_scope_allowed()
    token = _context.set(RlsContext(system=True))
    try:
        yield
    finally:
        _context.reset(token)


__all__ = [
    "RlsContext",
    "current_rls_context",
    "current_tenant_id",
    "system_access_enabled",
    "system_scope",
    "tenant_scope",
]
