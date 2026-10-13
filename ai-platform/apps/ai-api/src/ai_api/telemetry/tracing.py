"""OpenTelemetry span helpers (Phase 12).

Thin wrappers over the OTel tracer used by services to add manual spans for
operations that the framework instrumentation does not cover (model calls,
retrieval, tool execution, event consumption). When no tracer provider is
configured, OTel returns a no-op tracer and these helpers cost almost nothing.

Only safe, low-cardinality attributes are attached; secrets and raw
prompt/document content must never be set as span attributes.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import Any

from opentelemetry import trace

_TRACER_NAME = "ai-api"
_SAFE_TYPES = (str, bool, int, float)


def get_tracer():
    return trace.get_tracer(_TRACER_NAME)


def set_attributes(target: Any, attributes: Mapping[str, Any] | None) -> None:
    if not attributes:
        return
    for key, value in attributes.items():
        if value is None:
            continue
        if isinstance(value, _SAFE_TYPES):
            target.set_attribute(key, value)
        else:
            target.set_attribute(key, str(value))


@contextmanager
def span(name: str, attributes: Mapping[str, Any] | None = None) -> Iterator[Any]:
    """Start a span; safe no-op when tracing is disabled."""
    with get_tracer().start_as_current_span(name) as current:
        set_attributes(current, attributes)
        yield current


def record_exception(current: Any, exc: BaseException) -> None:
    try:
        current.record_exception(exc)
    except Exception:  # noqa: BLE001 - tracing must never break the request
        pass
