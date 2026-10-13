from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api import __version__
from ai_api.config.settings import Settings


@dataclass(slots=True)
class HealthService:
    settings: Settings

    def check(self) -> dict[str, Any]:
        components: dict[str, str] = {
            "api": "ok",
            "configuration": "ok",
            "repository": self.settings.ai_repository,
            "event_bus": self.settings.event_bus_provider,
        }
        return {
            "status": "ok",
            "service": "ai-api",
            "version": __version__,
            "environment": self.settings.ai_env,
            "components": components,
        }

    def readiness(self) -> dict[str, Any]:
        """Static view of configured backends used by the readiness probe.

        Live dependency checks (database connectivity) are layered on by the
        ``/readyz`` endpoint, which can perform I/O; this method only reports
        configuration so it stays side-effect free.
        """
        return {
            "repository": self.settings.ai_repository,
            "vector_store": "pgvector",
            "search_index": self.settings.search_provider,
            "hybrid_search": "enabled" if self.settings.ai_hybrid_search_enabled else "disabled",
            "event_bus": self.settings.event_bus_provider,
            "ml_tracking": self.settings.ml_tracking_backend,
            "telemetry": {
                "metrics": "enabled",
                "tracing": "enabled" if self.settings.otel_enabled else "disabled",
                "langfuse": "enabled"
                if (
                    self.settings.langfuse_host
                    and self.settings.langfuse_public_key
                    and self.settings.langfuse_secret_key
                )
                else "disabled",
            },
        }
