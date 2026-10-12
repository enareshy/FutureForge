"""LiteLLM-backed provider adapter.

Kept behind a lazy import and an injectable client so it can be unit-tested
without the LiteLLM dependency making network calls. Credentials come from
configuration and are never logged or returned to callers.
"""

from __future__ import annotations

from typing import Any

from ai_api.domain.errors import ConfigurationError, ProviderError
from ai_api.domain.models.provider import (
    ChatRequest,
    ChatResponse,
    EmbeddingRequest,
    EmbeddingResponse,
    ModelSpec,
    TokenUsage,
)


def _field(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


class LiteLLMProvider:
    """Implements both the LLMProvider and EmbeddingProvider contracts."""

    def __init__(
        self,
        code: str,
        *,
        api_key: str = "",
        base_url: str = "",
        client: Any | None = None,
    ) -> None:
        self.code = code
        self._api_key = api_key
        self._base_url = base_url
        self._client = client

    def _client_module(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            import litellm
        except ImportError as exc:  # pragma: no cover - exercised only without the dep
            raise ConfigurationError(
                "litellm is not installed; install it to use non-mock providers",
                details={"provider": self.code},
            ) from exc
        return litellm

    def _auth_params(self) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if self._api_key:
            params["api_key"] = self._api_key
        if self._base_url:
            params["base_url"] = self._base_url
        return params

    async def generate(self, spec: ModelSpec, request: ChatRequest) -> ChatResponse:
        client = self._client_module()
        params: dict[str, Any] = {
            "model": spec.code,
            "messages": [{"role": m.role.value, "content": m.content} for m in request.messages],
            "temperature": request.temperature,
            **self._auth_params(),
        }
        if request.max_output_tokens is not None:
            params["max_tokens"] = request.max_output_tokens
        if request.response_format == "json":
            params["response_format"] = {"type": "json_object"}
        if request.timeout_seconds is not None:
            params["timeout"] = request.timeout_seconds

        try:
            raw = await client.acompletion(**params)
        except Exception as exc:  # noqa: BLE001 - normalize provider failures
            raise ProviderError(
                "chat completion failed",
                details={"provider": self.code, "model": spec.code},
            ) from exc

        choices = _field(raw, "choices", []) or []
        if not choices:
            raise ProviderError(
                "provider returned no choices",
                details={"provider": self.code, "model": spec.code},
            )
        message = _field(choices[0], "message")
        usage = _field(raw, "usage")
        return ChatResponse(
            content=_field(message, "content") or "",
            model=spec.code,
            provider=self.code,
            usage=TokenUsage.create(
                _field(usage, "prompt_tokens", 0),
                _field(usage, "completion_tokens", 0),
            ),
            finish_reason=_field(choices[0], "finish_reason", "stop"),
            is_mock=False,
        )

    async def embed(self, spec: ModelSpec, request: EmbeddingRequest) -> EmbeddingResponse:
        client = self._client_module()
        params: dict[str, Any] = {
            "model": spec.code,
            "input": list(request.texts),
            **self._auth_params(),
        }
        if request.timeout_seconds is not None:
            params["timeout"] = request.timeout_seconds

        try:
            raw = await client.aembedding(**params)
        except Exception as exc:  # noqa: BLE001 - normalize provider failures
            raise ProviderError(
                "embedding request failed",
                details={"provider": self.code, "model": spec.code},
            ) from exc

        data = _field(raw, "data", []) or []
        vectors = tuple(tuple(_field(item, "embedding", []) or []) for item in data)
        if not vectors:
            raise ProviderError(
                "provider returned no embeddings",
                details={"provider": self.code, "model": spec.code},
            )
        dimensions = len(vectors[0])
        usage = _field(raw, "usage")
        return EmbeddingResponse(
            vectors=vectors,
            model=spec.code,
            provider=self.code,
            dimensions=dimensions,
            usage=TokenUsage.create(_field(usage, "prompt_tokens", 0), 0),
            is_mock=False,
        )

    async def health(self) -> bool:
        try:
            self._client_module()
        except ConfigurationError:
            return False
        return True
