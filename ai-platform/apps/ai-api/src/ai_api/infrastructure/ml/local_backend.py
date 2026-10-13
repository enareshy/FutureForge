"""Local (platform-only) experiment-tracking backend.

This backend performs no external calls. The platform repository remains the
authority for run metadata; there is simply no external tracker or artifact
store attached. It is the honest default when MLflow is not configured, and it
is always available.
"""

from __future__ import annotations

from typing import Any


class LocalTrackingBackend:
    backend = "local"

    @property
    def external(self) -> bool:
        return False

    async def status(self) -> dict[str, Any]:
        return {
            "backend": self.backend,
            "external": False,
            "available": True,
            "tracking_uri": None,
            "detail": "runs are recorded in the platform registry only",
        }

    async def ensure_experiment(
        self,
        *,
        code: str,
        name: str,
        description: str | None,
        tags: dict[str, Any],
    ) -> dict[str, Any]:
        return {"external_experiment_id": None}

    async def start_run(
        self,
        *,
        external_experiment_id: str | None,
        run_name: str | None,
        params: dict[str, Any],
        tags: dict[str, Any],
    ) -> dict[str, Any]:
        return {"external_run_id": None, "artifact_uri": None}

    async def log_batch(
        self,
        *,
        external_run_id: str,
        params: dict[str, Any],
        metrics: dict[str, Any],
        tags: dict[str, Any],
    ) -> None:
        return None

    async def end_run(self, *, external_run_id: str, status: str) -> None:
        return None

    async def register_model_version(
        self,
        *,
        name: str,
        source_uri: str,
        external_run_id: str | None,
        tags: dict[str, Any],
    ) -> dict[str, Any]:
        return {"external_model_version": None}
