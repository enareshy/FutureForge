"""Langfuse tracing (Phase 12).

A minimal, dependency-free client for the Langfuse **public ingestion API**
(``POST {host}/api/public/ingestion``) used to mirror model generations (and,
optionally, scores) for LLM observability and evaluation. It is entirely
optional: when ``LANGFUSE_HOST`` and both keys are unset the publisher is a
no-op.

Delivery is best-effort and non-blocking: events are queued and drained by a
single background worker, and are dropped (never blocking a request) if the
queue is full or the endpoint is unreachable. Only safe metadata is sent —
never raw prompt text, documents, or credentials.
"""

from __future__ import annotations

import asyncio
import base64
import json
import uuid
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

import httpx

from ai_api.telemetry.logging import get_logger

logger = get_logger("langfuse")

_QUEUE_MAX = 1000


def _iso_now() -> str:
    return datetime.now(UTC).isoformat()


class LangfusePublisher:
    def __init__(
        self,
        host: str,
        public_key: str,
        secret_key: str,
        *,
        timeout_seconds: float = 5.0,
    ) -> None:
        self._host = (host or "").rstrip("/")
        self._timeout = timeout_seconds
        self._auth = ""
        if self._host and public_key and secret_key:
            raw = f"{public_key}:{secret_key}".encode()
            self._auth = "Basic " + base64.b64encode(raw).decode()
        self._queue: asyncio.Queue[dict[str, Any]] | None = None
        self._worker: asyncio.Task[None] | None = None

    @property
    def enabled(self) -> bool:
        return bool(self._auth)

    def _ensure_worker(self) -> asyncio.Queue[dict[str, Any]]:
        if self._queue is None:
            self._queue = asyncio.Queue(maxsize=_QUEUE_MAX)
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._drain())
        return self._queue

    def _enqueue(self, event: dict[str, Any]) -> None:
        if not self.enabled:
            return
        try:
            queue = self._ensure_worker()
        except RuntimeError:
            # No running event loop (e.g. sync context); skip quietly.
            return
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            logger.debug("langfuse.queue_full")

    def emit_generation(
        self,
        *,
        model: str,
        provider: str,
        operation: str,
        latency_ms: int,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cost_usd: float | None = None,
        outcome: str = "success",
        request_id: str | None = None,
        tenant_id: int | str | None = None,
        user_id: str | None = None,
        prompt_version: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        trace_id = request_id or uuid.uuid4().hex
        body_metadata: dict[str, Any] = {
            "provider": provider,
            "operation": operation,
            "outcome": outcome,
        }
        if tenant_id is not None:
            body_metadata["tenant_id"] = str(tenant_id)
        if user_id:
            body_metadata["user_id"] = user_id
        if prompt_version:
            body_metadata["prompt_version"] = prompt_version
        if metadata:
            body_metadata.update(metadata)
        payload: dict[str, Any] = {
            "id": uuid.uuid4().hex,
            "type": "generation-create",
            "timestamp": _iso_now(),
            "body": {
                "id": uuid.uuid4().hex,
                "traceId": trace_id,
                "name": operation,
                "model": model,
                "startTime": _iso_now(),
                "endTime": _iso_now(),
                "usage": {
                    "input": input_tokens,
                    "output": output_tokens,
                    "total": input_tokens + output_tokens,
                    "unit": "TOKENS",
                },
                "metadata": body_metadata,
                "level": "DEFAULT" if outcome == "success" else "ERROR",
            },
        }
        if cost_usd is not None:
            payload["body"]["calculatedTotalCost"] = cost_usd
        if latency_ms:
            payload["body"]["metadata"]["latency_ms"] = latency_ms
        self._enqueue(payload)

    def emit_score(
        self,
        *,
        trace_id: str,
        name: str,
        value: float | str,
        comment: str | None = None,
    ) -> None:
        self._enqueue(
            {
                "id": uuid.uuid4().hex,
                "type": "score-create",
                "timestamp": _iso_now(),
                "body": {
                    "id": uuid.uuid4().hex,
                    "traceId": trace_id,
                    "name": name,
                    "value": value,
                    "comment": comment,
                },
            }
        )

    async def _drain(self) -> None:
        assert self._queue is not None
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            while True:
                event = await self._queue.get()
                try:
                    await client.post(
                        f"{self._host}/api/public/ingestion",
                        headers={
                            "Authorization": self._auth,
                            "Content-Type": "application/json",
                        },
                        content=json.dumps({"batch": [event]}),
                    )
                except httpx.HTTPError as exc:
                    logger.debug("langfuse.ingest_failed", error=str(exc))
                finally:
                    self._queue.task_done()

    async def aclose(self) -> None:
        if self._worker is None:
            return
        with suppress(asyncio.CancelledError):
            self._worker.cancel()
            await self._worker
        self._worker = None
