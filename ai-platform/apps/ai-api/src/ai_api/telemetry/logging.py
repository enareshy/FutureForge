from __future__ import annotations

import logging
import sys
from contextvars import ContextVar
from typing import Any

import structlog

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
tenant_id_var: ContextVar[int | None] = ContextVar("tenant_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)


def _add_request_id(_logger: Any, _method: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    request_id = request_id_var.get()
    if request_id is not None:
        event_dict.setdefault("request_id", request_id)
    return event_dict


def configure_logging(level: str = "info", *, json_logs: bool = True) -> None:
    numeric_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=numeric_level)

    processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        _add_request_id,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]
    processors.append(
        structlog.processors.JSONRenderer() if json_logs else structlog.dev.ConsoleRenderer()
    )

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(numeric_level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "ai-api") -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)


def bind_log_context(**values: Any) -> None:
    """Bind safe, bounded context (request/tenant/user refs) to structured logs.

    Only pass low-cardinality references (ids, enums). Never bind secrets, raw
    prompt text, document content, or unnecessary personal information.
    """
    if "tenant_id" in values:
        tenant_id_var.set(values["tenant_id"])
    if "user_id" in values:
        user_id_var.set(values["user_id"])
    filtered = {key: value for key, value in values.items() if value is not None}
    if filtered:
        structlog.contextvars.bind_contextvars(**filtered)


def clear_log_context() -> None:
    structlog.contextvars.clear_contextvars()
    tenant_id_var.set(None)
    user_id_var.set(None)
