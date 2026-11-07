"""Low-cardinality metrics for RLS context and policy failures.

Labels never contain tenant IDs, record IDs, SQL text or query parameters.
Only a bounded SQL operation name (``select``/``insert``/``update``/``delete``/
``with``/``other``) is recorded.
"""

from __future__ import annotations

from prometheus_client import Counter

from ai_api.telemetry.metrics import REGISTRY

RLS_CONTEXT_MISSING = Counter(
    "ai_rls_context_missing_total",
    "Tenant-owned database operations attempted without a tenant or system context.",
    ["operation"],
    registry=REGISTRY,
)

RLS_DENIED = Counter(
    "ai_rls_denied_total",
    "Database writes rejected by a row-level security policy.",
    ["operation"],
    registry=REGISTRY,
)

_OPERATIONS = frozenset({"select", "insert", "update", "delete", "with"})


def sql_operation(query: str) -> str:
    words = query.lstrip().split(None, 1)
    if not words:
        return "other"
    operation = words[0].lower()
    return operation if operation in _OPERATIONS else "other"


__all__ = ["RLS_CONTEXT_MISSING", "RLS_DENIED", "sql_operation"]
