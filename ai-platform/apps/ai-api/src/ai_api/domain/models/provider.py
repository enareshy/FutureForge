from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal


class Role(StrEnum):
    system = "system"
    user = "user"
    assistant = "assistant"
    tool = "tool"


class ProviderKind(StrEnum):
    llm = "llm"
    embedding = "embedding"
    rerank = "rerank"


@dataclass(frozen=True, slots=True)
class Message:
    role: Role
    content: str


@dataclass(frozen=True, slots=True)
class ModelCapability:
    """Capability metadata. Never assume two models behave identically."""

    kind: ProviderKind
    context_window: int | None = None
    max_output_tokens: int | None = None
    supports_streaming: bool = False
    supports_tools: bool = False
    supports_json_mode: bool = False
    embedding_dimensions: int | None = None


@dataclass(frozen=True, slots=True)
class ModelSpec:
    code: str
    provider_code: str
    capability: ModelCapability
    input_cost_per_1k: float | None = None
    output_cost_per_1k: float | None = None
    is_mock: bool = False


@dataclass(frozen=True, slots=True)
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0

    @classmethod
    def create(cls, input_tokens: int, output_tokens: int) -> TokenUsage:
        return cls(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
        )


@dataclass(frozen=True, slots=True)
class ChatRequest:
    messages: tuple[Message, ...]
    model: str
    temperature: float = 0.0
    max_output_tokens: int | None = None
    response_format: Literal["text", "json"] = "text"
    json_schema: dict[str, Any] | None = None
    timeout_seconds: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ChatResponse:
    content: str
    model: str
    provider: str
    usage: TokenUsage
    finish_reason: str = "stop"
    estimated_cost_usd: float | None = None
    is_mock: bool = False
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class EmbeddingRequest:
    texts: tuple[str, ...]
    model: str
    timeout_seconds: float | None = None


@dataclass(frozen=True, slots=True)
class EmbeddingResponse:
    vectors: tuple[tuple[float, ...], ...]
    model: str
    provider: str
    dimensions: int
    usage: TokenUsage
    estimated_cost_usd: float | None = None
    is_mock: bool = False


@dataclass(frozen=True, slots=True)
class ProviderHealth:
    provider: str
    available: bool
    is_mock: bool = False
    detail: str = ""
