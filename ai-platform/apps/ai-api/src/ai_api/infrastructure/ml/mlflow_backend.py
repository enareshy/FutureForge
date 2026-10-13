"""MLflow tracking backend.

A thin, dependency-free client over the MLflow tracking **REST API** (httpx).
Using the REST API keeps the AI service lean: MLflow is not a Python dependency
of the API, and the integration is directly testable with an HTTP transport
stub. Only the small subset of endpoints needed for experiment registration,
run logging, and (optional) model registration is used.

The MLflow server is optional. `status()` probes the `/health` endpoint (cached
briefly); callers skip external tracking when it is unavailable and record the
run in the platform registry instead. Every failure is raised as a
`ProviderError` so the caller can degrade honestly.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from ai_api.domain.errors import ProviderError
from ai_api.telemetry.logging import get_logger

logger = get_logger("mlflow")

# MLflow 2.x/3.x tracking endpoint prefixes. The 2.0 routes remain supported by
# MLflow 3.x for experiment/run/registry operations.
_API = "/api/2.0/mlflow"

_FINISHED_STATUS = {"finished": "FINISHED", "failed": "FAILED", "killed": "KILLED"}


def _to_tags(tags: dict[str, Any]) -> list[dict[str, str]]:
    return [{"key": str(k), "value": str(v)} for k, v in (tags or {}).items()]


def _to_params(params: dict[str, Any]) -> list[dict[str, str]]:
    return [{"key": str(k), "value": str(v)} for k, v in (params or {}).items()]


def _to_metrics(metrics: dict[str, Any], timestamp_ms: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for key, value in (metrics or {}).items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        out.append({"key": str(key), "value": float(value), "timestamp": timestamp_ms, "step": 0})
    return out


class MlflowTrackingBackend:
    backend = "mlflow"

    def __init__(
        self,
        tracking_uri: str,
        *,
        timeout_seconds: float = 10.0,
        health_ttl_seconds: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._uri = tracking_uri.rstrip("/")
        self._timeout = timeout_seconds
        self._health_ttl = health_ttl_seconds
        self._transport = transport
        self._health_cache: tuple[float, bool] | None = None

    @property
    def external(self) -> bool:
        return True

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self._uri, timeout=self._timeout, transport=self._transport
        )

    async def _available(self) -> bool:
        now = time.monotonic()
        if self._health_cache is not None and self._health_cache[0] > now:
            return self._health_cache[1]
        available = False
        try:
            async with self._client() as client:
                response = await client.get("/health")
                available = response.status_code == 200
        except httpx.HTTPError as exc:
            logger.warning("mlflow.health_unreachable", error=str(exc))
            available = False
        self._health_cache = (now + self._health_ttl, available)
        return available

    async def status(self) -> dict[str, Any]:
        available = await self._available()
        return {
            "backend": self.backend,
            "external": True,
            "available": available,
            "tracking_uri": self._uri,
            "detail": (
                "MLflow tracking server reachable"
                if available
                else "MLflow tracking server unreachable; runs are recorded locally"
            ),
        }

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            async with self._client() as client:
                response = await client.post(f"{_API}{path}", json=payload)
        except httpx.HTTPError as exc:
            raise ProviderError("MLflow request failed", details={"error": str(exc)}) from exc
        if response.status_code >= 400:
            raise ProviderError(
                "MLflow returned an error",
                details={"status": response.status_code, "body": response.text[:500]},
            )
        return response.json() if response.content else {}

    async def _get(self, path: str, params: dict[str, Any]) -> httpx.Response:
        try:
            async with self._client() as client:
                return await client.get(f"{_API}{path}", params=params)
        except httpx.HTTPError as exc:
            raise ProviderError("MLflow request failed", details={"error": str(exc)}) from exc

    async def ensure_experiment(
        self,
        *,
        code: str,
        name: str,
        description: str | None,
        tags: dict[str, Any],
    ) -> dict[str, Any]:
        existing = await self._get(
            "/experiments/get-by-name", {"experiment_name": name}
        )
        if existing.status_code == 200:
            experiment_id = (existing.json().get("experiment") or {}).get("experiment_id")
            if experiment_id:
                return {"external_experiment_id": str(experiment_id)}
        if existing.status_code not in (200, 404):
            raise ProviderError(
                "MLflow experiment lookup failed",
                details={"status": existing.status_code},
            )
        created = await self._post(
            "/experiments/create",
            {"name": name, "tags": _to_tags({**tags, "ai.code": code})},
        )
        return {"external_experiment_id": str(created.get("experiment_id"))}

    async def start_run(
        self,
        *,
        external_experiment_id: str | None,
        run_name: str | None,
        params: dict[str, Any],
        tags: dict[str, Any],
    ) -> dict[str, Any]:
        if not external_experiment_id:
            raise ProviderError("cannot start an MLflow run without an experiment id")
        payload: dict[str, Any] = {
            "experiment_id": external_experiment_id,
            "start_time": int(time.time() * 1000),
            "tags": _to_tags(tags),
        }
        if run_name:
            payload["run_name"] = run_name
        created = await self._post("/runs/create", payload)
        run_info = created.get("run", {}).get("info", {})
        return {
            "external_run_id": run_info.get("run_id"),
            "artifact_uri": run_info.get("artifact_uri"),
        }

    async def log_batch(
        self,
        *,
        external_run_id: str,
        params: dict[str, Any],
        metrics: dict[str, Any],
        tags: dict[str, Any],
    ) -> None:
        await self._post(
            "/runs/log-batch",
            {
                "run_id": external_run_id,
                "params": _to_params(params),
                "metrics": _to_metrics(metrics, int(time.time() * 1000)),
                "tags": _to_tags(tags),
            },
        )

    async def end_run(self, *, external_run_id: str, status: str) -> None:
        await self._post(
            "/runs/update",
            {
                "run_id": external_run_id,
                "status": _FINISHED_STATUS.get(status, "FINISHED"),
                "end_time": int(time.time() * 1000),
            },
        )

    async def register_model_version(
        self,
        *,
        name: str,
        source_uri: str,
        external_run_id: str | None,
        tags: dict[str, Any],
    ) -> dict[str, Any]:
        try:
            await self._post("/registered-models/create", {"name": name})
        except ProviderError as exc:
            # 409 => already exists; anything else is a real failure.
            if exc.details.get("status") != 409:
                raise
        payload: dict[str, Any] = {"name": name, "source": source_uri}
        if external_run_id:
            payload["run_id"] = external_run_id
        if tags:
            payload["tags"] = _to_tags(tags)
        created = await self._post("/model-versions/create", payload)
        version = (created.get("model_version") or {}).get("version")
        return {"external_model_version": str(version) if version is not None else None}
