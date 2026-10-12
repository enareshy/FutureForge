from __future__ import annotations

from ai_api.domain.models.provider import (
    ChatRequest,
    EmbeddingRequest,
    Message,
    ModelCapability,
    ModelSpec,
    ProviderKind,
    Role,
)
from ai_api.infrastructure.providers.mock import (
    MOCK_LABEL,
    MockEmbeddingProvider,
    MockLLMProvider,
)


def _chat_spec() -> ModelSpec:
    return ModelSpec(
        code="mock-chat",
        provider_code="mock",
        capability=ModelCapability(kind=ProviderKind.llm, supports_json_mode=True),
        is_mock=True,
    )


def _embedding_spec() -> ModelSpec:
    return ModelSpec(
        code="mock-embed",
        provider_code="mock",
        capability=ModelCapability(kind=ProviderKind.embedding, embedding_dimensions=1536),
        is_mock=True,
    )


async def test_mock_chat_is_labeled_and_deterministic() -> None:
    provider = MockLLMProvider("mock")
    request = ChatRequest(messages=(Message(Role.user, "hello world"),), model="mock-chat")

    first = await provider.generate(_chat_spec(), request)
    second = await provider.generate(_chat_spec(), request)

    assert first.is_mock is True
    assert first.content.startswith(MOCK_LABEL)
    assert first.content == second.content
    assert first.usage.total_tokens == first.usage.input_tokens + first.usage.output_tokens


async def test_mock_embedding_is_normalized_and_stable() -> None:
    provider = MockEmbeddingProvider("mock")
    request = EmbeddingRequest(texts=("alpha", "alpha", "beta"), model="mock-embed")

    response = await provider.embed(_embedding_spec(), request)

    assert response.is_mock is True
    assert response.dimensions == 1536
    assert len(response.vectors) == 3
    assert response.vectors[0] == response.vectors[1]
    assert response.vectors[0] != response.vectors[2]
    norm = sum(value * value for value in response.vectors[0]) ** 0.5
    assert abs(norm - 1.0) < 1e-9
