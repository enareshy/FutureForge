from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from ai_api.application.services.event_service import EventConsumer
from ai_api.config.settings import Settings
from ai_api.workers import event_consumer as event_worker
from ai_api.workers.health import WorkerHealth, start_health_server

APP_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = APP_ROOT / "src"
_METRICS_TOKEN = "test-worker-metrics-token"


def _env(**overrides: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "AI_REPOSITORY": "memory",
            "EVENT_BUS_PROVIDER": "database",
            "AI_API_LOG_LEVEL": "warning",
            "PYTHONPATH": str(SRC_ROOT),
        }
    )
    env.update(overrides)
    return env


@pytest.mark.parametrize(
    "module",
    [
        "ai_api.workers.event_consumer",
        "ai_api.workers.reconciler",
        "ai_api.workers.indexer",
        "ai_api.workers.agent",
    ],
)
def test_worker_entrypoints_start_once_with_memory_config(module: str) -> None:
    result = subprocess.run(
        [sys.executable, "-m", module, "--once"],
        cwd=APP_ROOT,
        env=_env(),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]


def test_worker_entrypoint_rejects_invalid_configuration() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "ai_api.workers.event_consumer", "--once"],
        cwd=APP_ROOT,
        env=_env(AI_EVENT_RETRY_JITTER="2"),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode != 0
    assert "ai_event_retry_jitter" in (result.stderr + result.stdout).lower()


def _free_port() -> int:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _get(url: str, *, token: str | None = None) -> tuple[int, bytes]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def test_health_endpoints_fail_closed_until_a_cycle_succeeds() -> None:
    now = [1000.0]
    health = WorkerHealth("event-consumer", 60, clock=lambda: now[0])
    port = _free_port()
    server = start_health_server(port, health, addr="127.0.0.1", metrics_token=_METRICS_TOKEN)
    assert server is not None
    try:
        status, _ = _get(f"http://127.0.0.1:{port}/healthz")
        assert status == 200
        status, body = _get(f"http://127.0.0.1:{port}/readyz")
        assert status == 503
        assert json.loads(body)["ready"] is False

        health.success()
        status, body = _get(f"http://127.0.0.1:{port}/readyz")
        assert status == 200
        assert json.loads(body)["last_success_seconds_ago"] == 0.0

        now[0] += 61
        status, _ = _get(f"http://127.0.0.1:{port}/readyz")
        assert status == 503

        status, body = _get(f"http://127.0.0.1:{port}/metrics")
        assert status == 401
        assert b"ai_worker_cycles_total" not in body
        status, payload = _get(f"http://127.0.0.1:{port}/metrics", token=_METRICS_TOKEN)
        assert status == 200
        assert b"ai_worker_last_success_timestamp_seconds" in payload
        assert b"ai_worker_cycles_total" in payload
    finally:
        server.shutdown()
        server.server_close()


def test_failed_cycle_marks_worker_unready() -> None:
    now = [1000.0]
    health = WorkerHealth("indexer", 60, clock=lambda: now[0])
    health.failure(RuntimeError("database unreachable"))
    assert health.ready() is False
    assert health.consecutive_failures == 1
    health.success()
    assert health.ready() is True
    assert health.consecutive_failures == 0
    assert health.last_error is None


class _BlockingStore:
    def __init__(self) -> None:
        self.marked: list[str] = []
        self.handler_started = asyncio.Event()
        self.release = asyncio.Event()

    async def list_undelivered(self, consumer_group: str, *, limit: int):
        return [
            {
                "event_id": "evt-1",
                "type": "KnowledgeSourceRegistered",
                "version": "v1",
                "tenant_id": 7,
                "payload": {},
            }
        ]

    async def claim_undelivered(
        self,
        consumer_group: str,
        *,
        limit: int,
        claimed_by: str,
        lease_seconds: float,
    ):
        return await self.list_undelivered(consumer_group, limit=limit)

    async def mark_delivered(self, event_id: str, consumer_group: str) -> None:
        self.marked.append(event_id)

    async def record_failure(self, *args, **kwargs) -> str:  # pragma: no cover
        return "failed"

    async def delivery_backlog(self) -> dict[str, int | float]:
        return {
            "pending": 0,
            "delayed": 0,
            "dead": 0,
            "oldest_pending_seconds": 0.0,
        }


def test_shutdown_waits_for_inflight_work_and_does_not_ack_early(monkeypatch) -> None:
    store = _BlockingStore()

    async def handler(_envelope) -> None:
        store.handler_started.set()
        await store.release.wait()

    consumer = EventConsumer(
        store=store,  # type: ignore[arg-type]
        consumer_group="test-group",
        handlers={"KnowledgeSourceRegistered": handler},
        batch_size=1,
    )
    monkeypatch.setattr(event_worker, "build_consumer", lambda _settings: consumer)
    health = WorkerHealth("event-consumer", 60)
    settings = Settings(
        ai_repository="memory",
        ai_event_poll_seconds=0.01,
        ai_event_batch_size=1,
    )

    async def scenario() -> None:
        task = asyncio.create_task(
            event_worker.run(once=False, settings=settings, health=health)
        )
        await asyncio.wait_for(store.handler_started.wait(), 5)
        assert store.marked == []
        event_worker._shutdown.set()
        store.release.set()
        await asyncio.wait_for(task, 5)

    asyncio.run(scenario())
    assert store.marked == ["evt-1"]
    assert health.shutting_down is True
    assert health.last_success_at is not None


def test_reconciler_passes_dry_run_and_purge_settings(monkeypatch) -> None:
    from ai_api.workers import reconciler as reconciler_worker

    captured: dict[str, object] = {}

    class _Service:
        class repository:  # noqa: N801 - mirrors the real attribute shape
            @staticmethod
            async def job_metrics(**_kwargs):
                return {"by_status": {}, "security_refresh_overdue": 0}

        async def reconcile_all_tenants(self, **kwargs):
            captured.update(kwargs)
            return {"sources_queued": 0, "orphans_deleted": 0}

    settings = Settings(
        ai_repository="memory",
        ai_reconcile_dry_run=True,
        ai_reconcile_purge_orphans=True,
        ai_reconcile_limit=7,
        ai_reconcile_max_tenants=3,
    )
    asyncio.run(reconciler_worker._run_once(_Service(), settings))  # type: ignore[arg-type]
    assert captured["dry_run"] is True
    assert captured["purge_orphans"] is True
    assert captured["limit"] == 7
    assert captured["max_tenants"] == 3


def test_event_backlog_reports_oldest_pending_age() -> None:
    from ai_api.infrastructure.events import InMemoryEventStore

    async def scenario() -> tuple[dict, dict]:
        store = InMemoryEventStore()
        await store.publish(
            [
                {
                    "event_id": "evt-old",
                    "type": "KnowledgeSourceRegistered",
                    "version": "v1",
                    "tenant_id": 1,
                    "payload": {},
                }
            ]
        )
        before = await store.delivery_backlog()
        await store.mark_delivered("evt-old", "group")
        after = await store.delivery_backlog()
        return before, after

    before, after = asyncio.run(scenario())
    assert before["pending"] == 1
    assert before["oldest_pending_seconds"] >= 0.0
    assert after["pending"] == 0
    assert after["oldest_pending_seconds"] == 0.0


def test_agent_worker_wires_enterprise_tools() -> None:
    """Regression: the worker is the real execution path for workflow agents.

    If it omits ``enterprise_tools`` then Stage 8-10 tools such as
    ``predictive.risk_lookup`` fail at runtime with
    "tool implementation is not enabled in this release".
    """
    from ai_api.config.settings import Settings
    from ai_api.workers.agent import _build_services

    settings = Settings(ai_repository="memory")
    service, _schedules = _build_services(settings)
    assert service.enterprise_tools is not None
    names = service.enterprise_tools.names()
    assert "predictive.risk_lookup" in names
    assert "graph.change_impact" in names
