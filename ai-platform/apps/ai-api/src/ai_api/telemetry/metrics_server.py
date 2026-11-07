"""Standalone Prometheus metrics server for worker processes (Phase 12).

The API exposes metrics through its FastAPI ``/metrics`` route. Background
workers (event consumer, indexer) are separate processes, so they start a small
HTTP server on a configurable port using the shared registry. Disabled by
default (port 0).
"""

from __future__ import annotations

from prometheus_client import start_http_server

from ai_api.telemetry.logging import get_logger
from ai_api.telemetry.metrics import REGISTRY

logger = get_logger("metrics")


def start_metrics_server(port: int, *, addr: str = "0.0.0.0") -> bool:
    """Start a background thread serving the shared registry; no-op when port <= 0."""
    if port <= 0:
        return False
    start_http_server(port, addr=addr, registry=REGISTRY)
    logger.info("metrics.server_started", port=port, addr=addr)
    return True
