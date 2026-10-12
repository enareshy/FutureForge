"""Provider/model registry.

Resolves a model code to a `ModelSpec` (capability metadata) and the provider
instance that serves it. Built from configuration; the database-backed registry
arrives in a later phase.
"""

from __future__ import annotations

from ai_api.config.settings import Settings
from ai_api.domain.errors import ConfigurationError, NotFoundError, ValidationError
from ai_api.domain.models.provider import ModelCapability, ModelSpec, ProviderKind
from ai_api.infrastructure.providers.litellm_adapter import LiteLLMProvider
from ai_api.infrastructure.providers.mock import MockEmbeddingProvider, MockLLMProvider

MOCK_PROVIDER = "mock"
MOCK_CHAT_MODEL = "mock-chat"
MOCK_EMBEDDING_MODEL = "mock-embed"

_JSON_MODE_PROVIDERS = {"openai", "azure", "azure_openai"}


class ProviderRegistry:
    def __init__(self) -> None:
        self._specs: dict[str, ModelSpec] = {}
        self._llm_providers: dict[str, object] = {}
        self._embedding_providers: dict[str, object] = {}

    def register_model(self, spec: ModelSpec) -> None:
        self._specs[spec.code] = spec

    def register_llm(self, provider_code: str, provider: object) -> None:
        self._llm_providers[provider_code] = provider

    def register_embedding(self, provider_code: str, provider: object) -> None:
        self._embedding_providers[provider_code] = provider

    def spec(self, model_code: str) -> ModelSpec:
        try:
            return self._specs[model_code]
        except KeyError as exc:
            raise NotFoundError(
                f"unknown model '{model_code}'",
                details={"model": model_code},
            ) from exc

    def llm(self, model_code: str) -> tuple[object, ModelSpec]:
        spec = self.spec(model_code)
        if spec.capability.kind is not ProviderKind.llm:
            raise ValidationError(
                f"model '{model_code}' is not a chat model",
                details={"model": model_code, "kind": spec.capability.kind.value},
            )
        provider = self._llm_providers.get(spec.provider_code)
        if provider is None:
            raise ConfigurationError(
                f"no chat provider registered for '{spec.provider_code}'",
                details={"provider": spec.provider_code},
            )
        return provider, spec

    def embedding(self, model_code: str) -> tuple[object, ModelSpec]:
        spec = self.spec(model_code)
        if spec.capability.kind is not ProviderKind.embedding:
            raise ValidationError(
                f"model '{model_code}' is not an embedding model",
                details={"model": model_code, "kind": spec.capability.kind.value},
            )
        provider = self._embedding_providers.get(spec.provider_code)
        if provider is None:
            raise ConfigurationError(
                f"no embedding provider registered for '{spec.provider_code}'",
                details={"provider": spec.provider_code},
            )
        return provider, spec

    def list_models(self) -> list[ModelSpec]:
        return sorted(self._specs.values(), key=lambda spec: spec.code)

    def provider_instances(self) -> dict[str, object]:
        instances: dict[str, object] = {}
        instances.update(self._llm_providers)
        instances.update(self._embedding_providers)
        return instances


def build_default_registry(settings: Settings) -> ProviderRegistry:
    registry = ProviderRegistry()

    registry.register_llm(MOCK_PROVIDER, MockLLMProvider(MOCK_PROVIDER))
    registry.register_embedding(MOCK_PROVIDER, MockEmbeddingProvider(MOCK_PROVIDER))
    registry.register_model(
        ModelSpec(
            code=MOCK_CHAT_MODEL,
            provider_code=MOCK_PROVIDER,
            capability=ModelCapability(
                kind=ProviderKind.llm,
                context_window=8192,
                max_output_tokens=2048,
                supports_json_mode=True,
            ),
            is_mock=True,
        )
    )
    registry.register_model(
        ModelSpec(
            code=MOCK_EMBEDDING_MODEL,
            provider_code=MOCK_PROVIDER,
            capability=ModelCapability(
                kind=ProviderKind.embedding,
                embedding_dimensions=settings.llm_embedding_dimensions,
            ),
            is_mock=True,
        )
    )

    provider_code = settings.llm_provider.strip().lower()
    if provider_code and provider_code != MOCK_PROVIDER:
        client = LiteLLMProvider(
            provider_code,
            api_key=settings.llm_api_key.get_secret_value(),
            base_url=settings.llm_base_url,
        )
        if settings.llm_chat_model:
            registry.register_llm(provider_code, client)
            registry.register_model(
                ModelSpec(
                    code=settings.llm_chat_model,
                    provider_code=provider_code,
                    capability=ModelCapability(
                        kind=ProviderKind.llm,
                        supports_json_mode=provider_code in _JSON_MODE_PROVIDERS,
                    ),
                    input_cost_per_1k=settings.llm_input_cost_per_1k,
                    output_cost_per_1k=settings.llm_output_cost_per_1k,
                )
            )
        if settings.llm_embedding_model:
            registry.register_embedding(provider_code, client)
            registry.register_model(
                ModelSpec(
                    code=settings.llm_embedding_model,
                    provider_code=provider_code,
                    capability=ModelCapability(
                        kind=ProviderKind.embedding,
                        embedding_dimensions=settings.llm_embedding_dimensions,
                    ),
                )
            )

    return registry


def default_chat_model(settings: Settings) -> str:
    return settings.llm_chat_model or MOCK_CHAT_MODEL


def default_embedding_model(settings: Settings) -> str:
    return settings.llm_embedding_model or MOCK_EMBEDDING_MODEL
