"""Per-request session token context.

Enterprise tools call the enterprise APIs *as the caller*. The bearer token is
captured at authentication time and kept in a task-local variable so tools can
forward it without ever exposing it to the LLM, the browser or logs. The value
is never serialized into prompts, tool arguments or audit records.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

_session_token: ContextVar[str | None] = ContextVar("enterprise_session_token", default=None)


def current_session_token() -> str | None:
    return _session_token.get()


@contextmanager
def session_token_scope(token: str | None) -> Iterator[None]:
    handle = _session_token.set(token or None)
    try:
        yield
    finally:
        _session_token.reset(handle)
