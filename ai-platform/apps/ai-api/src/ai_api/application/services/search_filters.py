"""Server-side validation and application of Stage 4 search filters.

Filters are validated against a fixed allowlist (never string-concatenated into a
query) and applied to **already authorized** candidates, so a filter can only
narrow a result set, never widen tenant/object/classification scope. Unknown
fields, disallowed operators and type mismatches raise ``ValidationError`` (422).
"""

from __future__ import annotations

from typing import Any

from ai_api.domain.errors import ValidationError
from ai_api.schemas.search import SearchFilter

_EQ_NE = frozenset({"eq", "ne"})
_EQ_NE_IN = frozenset({"eq", "ne", "in"})
_EQ_NE_IN_CONTAINS = frozenset({"eq", "ne", "in", "contains"})
_RANGE = frozenset({"eq", "ne", "gte", "lte"})

# Fields that live on the document's free-form ``metadata`` object rather than on
# the top-level candidate. They are still an explicit allowlist: an unknown
# metadata key is never queried, so filters cannot reach arbitrary JSON paths.
METADATA_FIELDS: frozenset[str] = frozenset({"product", "part_number", "revision"})

# field -> (kind, allowed operators). `kind` is "str" or "int". Every field maps
# directly to a key on the candidate shape produced by vector/lexical search,
# except ``METADATA_FIELDS`` which resolve through ``document_metadata``.
FILTER_REGISTRY: dict[str, tuple[str, frozenset[str]]] = {
    "source_id": ("int", _EQ_NE_IN),
    "source_code": ("str", _EQ_NE_IN),
    "classification": ("str", _EQ_NE_IN),
    "mime_type": ("str", _EQ_NE_IN_CONTAINS),
    "external_id": ("str", _EQ_NE_IN_CONTAINS),
    "document_status": ("str", _EQ_NE_IN),
    "section": ("str", _EQ_NE_IN_CONTAINS),
    "page": ("int", _RANGE),
    "product": ("str", _EQ_NE_IN_CONTAINS),
    "part_number": ("str", _EQ_NE_IN_CONTAINS),
    "revision": ("str", _EQ_NE_IN_CONTAINS),
}


def validate_filters(filters: list[SearchFilter]) -> list[SearchFilter]:
    """Return the filters unchanged if valid, else raise ``ValidationError``."""
    for item in filters:
        spec = FILTER_REGISTRY.get(item.field)
        if spec is None:
            raise ValidationError(
                "Unsupported filter field",
                details={"field": item.field, "allowed": sorted(FILTER_REGISTRY)},
            )
        kind, allowed_ops = spec
        if item.op not in allowed_ops:
            raise ValidationError(
                "Unsupported filter operator",
                details={"field": item.field, "op": item.op, "allowed": sorted(allowed_ops)},
            )
        _check_value(item, kind)
    return filters


def _check_value(item: SearchFilter, kind: str) -> None:
    value = item.value
    if item.op == "in":
        if not isinstance(value, list):
            raise ValidationError(
                "Operator 'in' requires a list value", details={"field": item.field}
            )
        candidates: list[Any] = value
    else:
        if isinstance(value, list):
            raise ValidationError(
                f"Operator '{item.op}' does not accept a list",
                details={"field": item.field},
            )
        candidates = [value]
    for entry in candidates:
        if kind == "int" and not isinstance(entry, int):
            raise ValidationError("Expected an integer filter value", details={"field": item.field})
        if kind == "str" and not isinstance(entry, str):
            raise ValidationError("Expected a string filter value", details={"field": item.field})


def apply_filters(
    candidates: list[dict[str, Any]], filters: list[SearchFilter]
) -> list[dict[str, Any]]:
    """Return candidates matching every filter. Missing metadata never matches."""
    if not filters:
        return candidates
    return [c for c in candidates if all(_matches(c, f) for f in filters)]


def _matches(candidate: dict[str, Any], item: SearchFilter) -> bool:
    actual = candidate.get(item.field)
    if actual is None and item.field in METADATA_FIELDS:
        metadata = candidate.get("document_metadata")
        if isinstance(metadata, dict):
            actual = metadata.get(item.field)
    if actual is None:
        return False
    op = item.op
    if op == "eq":
        return actual == item.value
    if op == "ne":
        return actual != item.value
    if op == "in":
        return actual in item.value  # type: ignore[operator]
    if op == "contains":
        return isinstance(actual, str) and item.value.lower() in actual.lower()
    if op == "gte":
        return _compare(actual, item.value) >= 0
    if op == "lte":
        return _compare(actual, item.value) <= 0
    return False


def _compare(actual: Any, expected: Any) -> int:
    try:
        if actual < expected:
            return -1
        if actual > expected:
            return 1
        return 0
    except TypeError:
        return 0
