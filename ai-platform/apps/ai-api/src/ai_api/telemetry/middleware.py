from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from ai_api.telemetry.logging import (
    bind_log_context,
    clear_log_context,
    get_logger,
    request_id_var,
)
from ai_api.telemetry.metrics import record_http_request

REQUEST_ID_HEADER = "x-request-id"

# Health/metrics scraping is high-frequency; do not emit a log line or a metric
# time series per scrape.
_EXCLUDED_PATHS = {"/metrics", "/healthz", "/readyz"}


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get(REQUEST_ID_HEADER) or uuid.uuid4().hex
        token = request_id_var.set(request_id)
        request.state.request_id = request_id
        bind_log_context(request_id=request_id)
        logger = get_logger("request")
        started = time.perf_counter()
        excluded = request.url.path in _EXCLUDED_PATHS
        try:
            response = await call_next(request)
            duration = time.perf_counter() - started
            response.headers[REQUEST_ID_HEADER] = request_id
            if not excluded:
                route = request.scope.get("route")
                label_path = getattr(route, "path", None) or request.url.path
                record_http_request(
                    method=request.method,
                    path=label_path,
                    status=response.status_code,
                    duration_seconds=duration,
                )
                logger.info(
                    "request.completed",
                    method=request.method,
                    path=request.url.path,
                    status_code=response.status_code,
                    duration_ms=round(duration * 1000, 2),
                )
            return response
        except Exception:
            logger.exception(
                "request.failed", method=request.method, path=request.url.path
            )
            raise
        finally:
            request_id_var.reset(token)
            clear_log_context()
