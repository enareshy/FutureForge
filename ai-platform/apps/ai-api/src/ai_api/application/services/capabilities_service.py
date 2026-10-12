from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api import __version__
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.config.settings import Settings
from ai_api.domain.models.provider import ModelSpec
from ai_api.infrastructure.providers.registry import default_chat_model, default_embedding_model

# Honest capability matrix for this release.
FEATURES: dict[str, str] = {
    "chat": "available",
    "summarize": "available",
    "models": "available",
    "embeddings": "available",
    "search": "available",
    "rag_query": "available",
    "knowledge_index": "available",
    "knowledge_ingest": "available",
    "agents_execute": "planned:phase9",
}


def _serialize_model(spec: ModelSpec) -> dict[str, Any]:
    capability = spec.capability
    return {
        "code": spec.code,
        "provider": spec.provider_code,
        "is_mock": spec.is_mock,
        "capability": {
            "kind": capability.kind.value,
            "context_window": capability.context_window,
            "max_output_tokens": capability.max_output_tokens,
            "supports_streaming": capability.supports_streaming,
            "supports_tools": capability.supports_tools,
            "supports_json_mode": capability.supports_json_mode,
            "embedding_dimensions": capability.embedding_dimensions,
        },
        "input_cost_per_1k": spec.input_cost_per_1k,
        "output_cost_per_1k": spec.output_cost_per_1k,
    }


@dataclass(slots=True)
class CapabilitiesService:
    gateway: ModelGateway
    settings: Settings

    async def describe(self) -> dict[str, Any]:
        health = await self.gateway.health()
        return {
            "version": __version__,
            "environment": self.settings.ai_env,
            "default_chat_model": default_chat_model(self.settings),
            "default_embedding_model": default_embedding_model(self.settings),
            "models": [_serialize_model(spec) for spec in self.gateway.list_models()],
            "providers": [
                {"provider": item.provider, "available": item.available} for item in health
            ],
            "features": FEATURES,
        }
