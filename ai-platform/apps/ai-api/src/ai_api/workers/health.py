"""Worker health and metrics endpoint.

Background workers have no HTTP traffic to probe. This module exposes a small
HTTP server with:

* ``/healthz`` - the process is running (liveness);
* ``/readyz`` - a cycle completed recently and no shutdown is in progress;
* ``/metrics`` - the shared Prometheus registry.

Readiness fails closed until the first successful cycle, so a worker that cannot
reach PostgreSQL, the event store or the search backend never reports healthy.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from ai_api.telemetry.logging import get_logger
from ai_api.telemetry.metrics import (
    REGISTRY,
    record_worker_cycle,
    record_worker_failure,
    record_worker_shutdown,
    record_worker_success,
)
from ai_api.telemetry.metrics_auth import metrics_auth_configured, metrics_authorized

logger = get_logger("worker.health")


@dataclass
class WorkerHealth:
    worker: str
    stale_after_seconds: float
    clock: Callable[[], float] = time.time
    started_at: float = field(init=False)
    last_success_at: float | None = None
    last_failure_at: float | None = None
    last_error: str | None = None
    consecutive_failures: int = 0
    shutting_down: bool = False

    def __post_init__(self) -> None:
        self.started_at = self.clock()

    def success(self) -> None:
        self.last_success_at = self.clock()
        self.last_error = None
        self.consecutive_failures = 0
        record_worker_cycle(worker=self.worker, outcome="success")
        record_worker_success(worker=self.worker, timestamp=self.last_success_at)

    def failure(self, error: BaseException | str) -> None:
        self.last_failure_at = self.clock()
        self.consecutive_failures += 1
        self.last_error = str(error)[:200]
        record_worker_cycle(worker=self.worker, outcome="failure")
        record_worker_failure(
            worker=self.worker, consecutive_failures=self.consecutive_failures
        )

    def mark_shutdown(self) -> None:
        if not self.shutting_down:
            self.shutting_down = True
            record_worker_shutdown(worker=self.worker)

    def ready(self) -> bool:
        if self.shutting_down or self.last_success_at is None:
            return False
        return (self.clock() - self.last_success_at) <= self.stale_after_seconds

    def snapshot(self) -> dict[str, Any]:
        now = self.clock()
        return {
            "worker": self.worker,
            "ready": self.ready(),
            "started_seconds_ago": round(max(0.0, now - self.started_at), 1),
            "last_success_seconds_ago": (
                None
                if self.last_success_at is None
                else round(max(0.0, now - self.last_success_at), 1)
            ),
            "last_failure_seconds_ago": (
                None
                if self.last_failure_at is None
                else round(max(0.0, now - self.last_failure_at), 1)
            ),
            "consecutive_failures": self.consecutive_failures,
            "last_error": self.last_error,
            "shutting_down": self.shutting_down,
            "stale_after_seconds": self.stale_after_seconds,
        }


class _Handler(BaseHTTPRequestHandler):
    health: WorkerHealth
    metrics_token: str

    def _json(
        self,
        status: int,
        payload: dict[str, Any],
        headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self._json(200, {"status": "ok", **self.health.snapshot()})
        elif path == "/readyz":
            status = 200 if self.health.ready() else 503
            self._json(
                status,
                {
                    "status": "ok" if status == 200 else "degraded",
                    **self.health.snapshot(),
                },
            )
        elif path == "/metrics":
            if not metrics_auth_configured(self.metrics_token):
                self._json(503, {"error": "metrics unavailable"})
                return
            if not metrics_authorized(self.headers.get("Authorization"), self.metrics_token):
                self._json(
                    401,
                    {"error": "unauthorized"},
                    headers={"WWW-Authenticate": "Bearer"},
                )
                return
            body = generate_latest(REGISTRY)
            self.send_response(200)
            self.send_header("Content-Type", CONTENT_TYPE_LATEST)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._json(404, {"error": "not found"})

    def log_message(self, format: str, *args: Any) -> None:
        return


class WorkerHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_health_server(
    port: int,
    health: WorkerHealth,
    *,
    addr: str = "0.0.0.0",
    metrics_token: str = "",
) -> WorkerHTTPServer | None:
    """Start the health/metrics server; a non-positive port disables it.

    ``/metrics`` requires the configured bearer token. When no token is
    supplied the metrics endpoint returns 503, while ``/healthz`` and
    ``/readyz`` stay available to Kubernetes probes.
    """
    if port <= 0:
        return None
    handler = type(
        "WorkerHealthHandler",
        (_Handler,),
        {"health": health, "metrics_token": metrics_token},
    )
    server = WorkerHTTPServer((addr, port), handler)
    thread = threading.Thread(
        target=server.serve_forever,
        name=f"{health.worker}-health",
        daemon=True,
    )
    thread.start()
    logger.info("worker.health_server_started", port=port, addr=addr)
    return server
