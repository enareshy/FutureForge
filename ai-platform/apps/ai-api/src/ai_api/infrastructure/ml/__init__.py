"""Experiment-tracking backends (Phase 11).

The platform repository is always the authority for authorization metadata; a
tracking backend only mirrors runs and artifacts. See `build_tracking_backend`.
"""

from __future__ import annotations

from ai_api.application.ports import TrackingBackend
from ai_api.config.settings import Settings
from ai_api.domain.errors import ConfigurationError
from ai_api.infrastructure.ml.local_backend import LocalTrackingBackend
from ai_api.infrastructure.ml.mlflow_backend import MlflowTrackingBackend

__all__ = ["LocalTrackingBackend", "MlflowTrackingBackend", "build_tracking_backend"]


def build_tracking_backend(settings: Settings) -> TrackingBackend:
    """Select the tracking backend from configuration.

    - `local`: platform registry only (no external tracker).
    - `mlflow`: require the configured MLflow tracking server.
    - `auto`: MLflow when a tracking URI is configured, otherwise local. When
      MLflow is configured but unreachable at runtime, the service degrades to
      local recording per call instead of failing.
    """
    mode = settings.ml_tracking_backend.strip().lower()
    if mode == "local":
        return LocalTrackingBackend()
    if mode == "mlflow":
        if not settings.mlflow_tracking_uri:
            raise ConfigurationError("ML_TRACKING_BACKEND=mlflow requires MLFLOW_TRACKING_URI")
        return MlflowTrackingBackend(
            settings.mlflow_tracking_uri,
            timeout_seconds=settings.ml_request_timeout_seconds,
        )
    if mode in ("auto", ""):
        if settings.mlflow_tracking_uri:
            return MlflowTrackingBackend(
                settings.mlflow_tracking_uri,
                timeout_seconds=settings.ml_request_timeout_seconds,
            )
        return LocalTrackingBackend()
    raise ConfigurationError(f"unknown ML_TRACKING_BACKEND: {settings.ml_tracking_backend}")
