from __future__ import annotations

import json

import pytest

from ai_api.application.reliability import CircuitOpenError
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.config.settings import Settings
from ai_api.domain.errors import NotFoundError, ProviderError, RateLimitError, ValidationError
from ai_api.domain.models.provider import (
    ChatRequest,
    ChatResponse,
    EmbeddingRequest,
    EmbeddingResponse,
    Message,
    ModelCapability,
    ModelSpec,
    ProviderKind,
    Role,
    TokenUsage,
)
from ai_api.infrastructure.providers.registry import (
    MOCK_CHAT_MODEL,
    MOCK_EMBEDDING_MODEL,
    ProviderRegistry,
    build_default_registry,
)


class FakeLLM:
    code = "fake"

    def __init__(self, *, fail_times: int = 0, content: str = "model answer") -> None:
        self.fail_times = fail_times
        self.content = content
        self.calls = 0

    async def generate(self, spec: ModelSpec, request: ChatRequest) -> ChatResponse:
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ProviderError("transient provider failure")
        return ChatResponse(
            content=self.content,
            model=spec.code,
            provider=self.code,
            usage=TokenUsage.create(2, 3),
        )

    async def health(self) -> bool:
        return True


class FakeEmbedding:
    code = "fake-embed"

    def __init__(self, *, dimensions: int = 3) -> None:
        self.dimensions = dimensions

    async def embed(self, spec: ModelSpec, request: EmbeddingRequest) -> EmbeddingResponse:
        vector = tuple(0.1 for _ in range(self.dimensions))
        return EmbeddingResponse(
            vectors=tuple(vector for _ in request.texts),
            model=spec.code,
            provider=self.code,
            dimensions=self.dimensions,
            usage=TokenUsage.create(1, 0),
        )

    async def health(self) -> bool:
        return True


def _settings(**overrides) -> Settings:
    base = {
        "llm_max_retries": 1,
        "llm_requests_per_minute": 1000,
        "llm_retry_base_delay_seconds": 0.001,
        "llm_retry_max_delay_seconds": 0.002,
    }
    base.update(overrides)
    return Settings(**base)


def _chat_spec(
    *, supports_json: bool = True, max_output: int | None = 2048, **spec_kwargs
) -> ModelSpec:
    return ModelSpec(
        code="fake-chat",
        provider_code="fake",
        capability=ModelCapability(
            kind=ProviderKind.llm,
            supports_json_mode=supports_json,
            max_output_tokens=max_output,
        ),
        **spec_kwargs,
    )


def _gateway_with(provider, spec: ModelSpec, **overrides) -> ModelGateway:
    registry = ProviderRegistry()
    registry.register_llm(spec.provider_code, provider)
    registry.register_model(spec)
    return ModelGateway(registry=registry, settings=_settings(**overrides))


def _user(text: str = "hello") -> ChatRequest:
    return ChatRequest(messages=(Message(Role.user, text),), model="fake-chat")


async def test_default_registry_chat_uses_mock() -> None:
    settings = _settings()
    gateway = ModelGateway(registry=build_default_registry(settings), settings=settings)

    response = await gateway.chat(
        ChatRequest(messages=(Message(Role.user, "hi"),), model=MOCK_CHAT_MODEL)
    )

    assert response.is_mock is True
    assert response.provider == "mock"
    assert response.estimated_cost_usd is None


async def test_default_registry_embed_uses_mock() -> None:
    settings = _settings()
    gateway = ModelGateway(registry=build_default_registry(settings), settings=settings)

    response = await gateway.embed(EmbeddingRequest(texts=("a", "b"), model=MOCK_EMBEDDING_MODEL))

    assert response.is_mock is True
    assert response.dimensions == 1536
    assert len(response.vectors) == 2


async def test_unknown_model_raises_not_found() -> None:
    gateway = _gateway_with(FakeLLM(), _chat_spec())
    with pytest.raises(NotFoundError):
        await gateway.chat(
            ChatRequest(messages=(Message(Role.user, "hi"),), model="does-not-exist")
        )


async def test_wrong_model_kind_raises_validation() -> None:
    settings = _settings()
    gateway = ModelGateway(registry=build_default_registry(settings), settings=settings)
    with pytest.raises(ValidationError):
        await gateway.chat(
            ChatRequest(messages=(Message(Role.user, "hi"),), model=MOCK_EMBEDDING_MODEL)
        )


async def test_json_output_round_trips_on_mock() -> None:
    settings = _settings()
    gateway = ModelGateway(registry=build_default_registry(settings), settings=settings)
    response = await gateway.chat(
        ChatRequest(
            messages=(Message(Role.user, "hi"),),
            model=MOCK_CHAT_MODEL,
            response_format="json",
        )
    )
    assert json.loads(response.content)["mock"] is True


async def test_json_mode_unsupported_is_rejected() -> None:
    gateway = _gateway_with(FakeLLM(), _chat_spec(supports_json=False))
    with pytest.raises(ValidationError):
        await gateway.chat(
            ChatRequest(
                messages=(Message(Role.user, "hi"),),
                model="fake-chat",
                response_format="json",
            )
        )


async def test_max_output_tokens_capability_is_enforced() -> None:
    gateway = _gateway_with(FakeLLM(), _chat_spec(max_output=100))
    request = ChatRequest(
        messages=(Message(Role.user, "hi"),),
        model="fake-chat",
        max_output_tokens=500,
    )
    with pytest.raises(ValidationError):
        await gateway.chat(request)


async def test_invalid_structured_output_is_rejected() -> None:
    gateway = _gateway_with(FakeLLM(content="not json"), _chat_spec())
    request = ChatRequest(
        messages=(Message(Role.user, "hi"),),
        model="fake-chat",
        response_format="json",
    )
    with pytest.raises(ProviderError):
        await gateway.chat(request)


async def test_cost_is_estimated_from_pricing_metadata() -> None:
    spec = _chat_spec(input_cost_per_1k=1.0, output_cost_per_1k=2.0)
    gateway = _gateway_with(FakeLLM(), spec)
    response = await gateway.chat(_user())
    assert response.estimated_cost_usd == pytest.approx(0.002 + 0.006)


async def test_embed_dimension_mismatch_is_rejected() -> None:
    spec = ModelSpec(
        code="fake-embed",
        provider_code="fake",
        capability=ModelCapability(kind=ProviderKind.embedding, embedding_dimensions=8),
    )
    registry = ProviderRegistry()
    registry.register_embedding("fake", FakeEmbedding(dimensions=3))
    registry.register_model(spec)
    gateway = ModelGateway(registry=registry, settings=_settings())

    with pytest.raises(ProviderError):
        await gateway.embed(EmbeddingRequest(texts=("x",), model="fake-embed"))


async def test_embed_empty_and_oversized_batches_are_rejected() -> None:
    spec = ModelSpec(
        code="fake-embed",
        provider_code="fake",
        capability=ModelCapability(kind=ProviderKind.embedding, embedding_dimensions=3),
    )
    registry = ProviderRegistry()
    registry.register_embedding("fake", FakeEmbedding(dimensions=3))
    registry.register_model(spec)
    gateway = ModelGateway(registry=registry, settings=_settings(llm_max_embedding_batch=1))

    with pytest.raises(ValidationError):
        await gateway.embed(EmbeddingRequest(texts=(), model="fake-embed"))
    with pytest.raises(ValidationError):
        await gateway.embed(EmbeddingRequest(texts=("a", "b"), model="fake-embed"))


async def test_rate_limit_is_enforced() -> None:
    gateway = _gateway_with(FakeLLM(), _chat_spec(), llm_requests_per_minute=1)
    await gateway.chat(_user())
    with pytest.raises(RateLimitError):
        await gateway.chat(_user())


async def test_retry_recovers_transient_failure() -> None:
    gateway = _gateway_with(FakeLLM(fail_times=1), _chat_spec(), llm_max_retries=2)
    response = await gateway.chat(_user())
    assert response.content == "model answer"


async def test_circuit_breaker_opens_after_repeated_failures() -> None:
    gateway = _gateway_with(
        FakeLLM(fail_times=99),
        _chat_spec(),
        llm_max_retries=1,
        llm_circuit_breaker_threshold=2,
    )
    with pytest.raises(ProviderError):
        await gateway.chat(_user())
    with pytest.raises(ProviderError):
        await gateway.chat(_user())
    with pytest.raises(CircuitOpenError):
        await gateway.chat(_user())


async def test_health_and_list_models() -> None:
    settings = _settings()
    gateway = ModelGateway(registry=build_default_registry(settings), settings=settings)

    health = await gateway.health()
    codes = {item.provider for item in health}
    assert "mock" in codes
    assert all(item.available for item in health)

    models = {spec.code for spec in gateway.list_models()}
    assert {MOCK_CHAT_MODEL, MOCK_EMBEDDING_MODEL} <= models
