from __future__ import annotations

from typing import Protocol, runtime_checkable

from ai_api.domain.models.provider import (
    ChatRequest,
    ChatResponse,
    EmbeddingRequest,
    EmbeddingResponse,
    ModelSpec,
)


@runtime_checkable
class LLMProvider(Protocol):
    """Interface for chat-completion providers (illustrative contract)."""

    code: str

    async def generate(self, spec: ModelSpec, request: ChatRequest) -> ChatResponse: ...

    async def health(self) -> bool: ...


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Interface for embedding providers (illustrative contract)."""

    code: str

    async def embed(self, spec: ModelSpec, request: EmbeddingRequest) -> EmbeddingResponse: ...

    async def health(self) -> bool: ...
