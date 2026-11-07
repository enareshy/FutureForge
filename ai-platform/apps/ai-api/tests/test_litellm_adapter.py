from __future__ import annotations

import pytest

from ai_api.domain.errors import ProviderError
from ai_api.domain.models.provider import (
    ChatRequest,
    EmbeddingRequest,
    Message,
    ModelCapability,
    ModelSpec,
    ProviderKind,
    Role,
)
from ai_api.infrastructure.providers.litellm_adapter import LiteLLMProvider


class _FakeMessage:
    content = "llm answer"


class _FakeChoice:
    message = _FakeMessage()
    finish_reason = "stop"


class _FakeUsage:
    prompt_tokens = 4
    completion_tokens = 6
    total_tokens = 10


class _FakeResponse:
    choices = [_FakeChoice()]
    usage = _FakeUsage()


class FakeLiteLLM:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[str, dict]] = []

    async def acompletion(self, **kwargs):
        self.calls.append(("chat", kwargs))
        if self.fail:
            raise RuntimeError("boom")
        return _FakeResponse()

    async def aembedding(self, **kwargs):
        self.calls.append(("embed", kwargs))
        return {"data": [{"embedding": [0.1, 0.2, 0.3]}], "usage": {"prompt_tokens": 2}}


def _chat_spec() -> ModelSpec:
    return ModelSpec(
        code="gpt-test",
        provider_code="openai",
        capability=ModelCapability(kind=ProviderKind.llm, supports_json_mode=True),
    )


def _embedding_spec() -> ModelSpec:
    return ModelSpec(
        code="text-embedding-test",
        provider_code="openai",
        capability=ModelCapability(kind=ProviderKind.embedding, embedding_dimensions=3),
    )


async def test_generate_maps_litellm_response() -> None:
    client = FakeLiteLLM()
    provider = LiteLLMProvider("openai", api_key="secret-key", client=client)

    response = await provider.generate(
        _chat_spec(),
        ChatRequest(
            messages=(Message(Role.system, "be terse"), Message(Role.user, "hi")),
            model="gpt-test",
            temperature=0.2,
            max_output_tokens=128,
            response_format="json",
        ),
    )

    assert response.content == "llm answer"
    assert response.provider == "openai"
    assert response.usage.input_tokens == 4
    assert response.usage.output_tokens == 6
    assert response.usage.total_tokens == 10
    assert response.is_mock is False

    method, kwargs = client.calls[0]
    assert method == "chat"
    assert kwargs["model"] == "gpt-test"
    assert kwargs["temperature"] == 0.2
    assert kwargs["max_tokens"] == 128
    assert kwargs["response_format"] == {"type": "json_object"}
    assert kwargs["api_key"] == "secret-key"
    assert kwargs["messages"][0] == {"role": "system", "content": "be terse"}


async def test_embed_maps_litellm_response() -> None:
    client = FakeLiteLLM()
    provider = LiteLLMProvider("openai", client=client)

    response = await provider.embed(
        _embedding_spec(),
        EmbeddingRequest(texts=("a",), model="text-embedding-test"),
    )

    assert response.vectors == ((0.1, 0.2, 0.3),)
    assert response.dimensions == 3
    assert response.is_mock is False


async def test_provider_failures_are_normalized_and_do_not_leak_secrets() -> None:
    provider = LiteLLMProvider("openai", api_key="secret-key", client=FakeLiteLLM(fail=True))

    with pytest.raises(ProviderError) as excinfo:
        await provider.generate(
            _chat_spec(), ChatRequest(messages=(Message(Role.user, "hi"),), model="gpt-test")
        )

    assert "secret-key" not in str(excinfo.value)
    assert excinfo.value.details == {"provider": "openai", "model": "gpt-test"}


async def test_health_reports_available_with_injected_client() -> None:
    provider = LiteLLMProvider("openai", client=FakeLiteLLM())
    assert await provider.health() is True
