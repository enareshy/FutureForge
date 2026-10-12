from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api import __version__
from ai_api.config.settings import Settings


@dataclass(slots=True)
class HealthService:
    settings: Settings

    def check(self) -> dict[str, Any]:
        components: dict[str, str] = {"api": "ok", "configuration": "ok"}
        return {
            "status": "ok",
            "service": "ai-api",
            "version": __version__,
            "environment": self.settings.ai_env,
            "components": components,
        }
