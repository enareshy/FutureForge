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
    "agents_execute": "available",
    "experiment_tracking": "available",
    "model_registry": "available",
    "evaluations": "available",
    "model_training": "external",
    "model_serving": "not_enabled",
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

    async def describe_providers(self) -> dict[str, Any]:
        """Read-only provider registry joined with model capabilities.

        Surfaces only configuration-derived facts (provider codes, availability,
        mock labelling and model capabilities). No credentials or secrets.
        """
        health = await self.gateway.health()
        models = [_serialize_model(spec) for spec in self.gateway.list_models()]
        by_provider: dict[str, list[dict[str, Any]]] = {}
        for model in models:
            by_provider.setdefault(model["provider"], []).append(model)

        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        for entry in health:
            provider_models = by_provider.get(entry.provider, [])
            items.append(
                {
                    "provider": entry.provider,
                    "available": entry.available,
                    "is_mock": all(m["is_mock"] for m in provider_models)
                    if provider_models
                    else False,
                    "models": provider_models,
                }
            )
            seen.add(entry.provider)
        for code, provider_models in by_provider.items():
            if code in seen:
                continue
            items.append(
                {
                    "provider": code,
                    "available": False,
                    "is_mock": all(m["is_mock"] for m in provider_models),
                    "models": provider_models,
                }
            )
        return {"items": items}
