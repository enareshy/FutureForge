"""Deterministic mock providers.

Used for tests and local development when no provider credentials exist. Every
response is explicitly labelled (`is_mock=True` and a ``[MOCK]`` prefix) so it
can never be mistaken for real AI output.
"""

from __future__ import annotations

import hashlib
import json
import math
import re

from ai_api.domain.models.provider import (
    ChatRequest,
    ChatResponse,
    EmbeddingRequest,
    EmbeddingResponse,
    ModelSpec,
    TokenUsage,
)

MOCK_LABEL = "[MOCK]"


class MockLLMProvider:
    def __init__(self, code: str = "mock") -> None:
        self.code = code

    @staticmethod
    def _content(spec: ModelSpec, request: ChatRequest) -> str:
        last_user = next(
            (m.content for m in reversed(request.messages) if m.role.value == "user"),
            "",
        )
        if request.response_format == "json":
            return json.dumps(
                {"mock": True, "model": spec.code, "echo": last_user},
                sort_keys=True,
            )
        return (
            f"{MOCK_LABEL} {spec.code} received {len(request.messages)} message(s). "
            f"Echo: {last_user}"
        )

    async def generate(self, spec: ModelSpec, request: ChatRequest) -> ChatResponse:
        content = self._content(spec, request)
        input_tokens = sum(len(m.content.split()) for m in request.messages)
        output_tokens = len(content.split())
        return ChatResponse(
            content=content,
            model=spec.code,
            provider=self.code,
            usage=TokenUsage.create(input_tokens, output_tokens),
            finish_reason="stop",
            is_mock=True,
        )

    async def stream(self, spec: ModelSpec, request: ChatRequest):
        """Yield the (deterministic) mock answer word by word.

        Streaming is simulated for the mock provider only so the SSE path can be
        exercised end to end without provider credentials. Output stays clearly
        labelled as mock.
        """
        content = self._content(spec, request)
        for token in re.findall(r"\S+\s*", content):
            yield token

    async def health(self) -> bool:
        return True


class MockEmbeddingProvider:
    def __init__(self, code: str = "mock") -> None:
        self.code = code

    async def embed(self, spec: ModelSpec, request: EmbeddingRequest) -> EmbeddingResponse:
        dimensions = spec.capability.embedding_dimensions or 1536
        vectors = tuple(deterministic_vector(text, dimensions) for text in request.texts)
        input_tokens = sum(len(text.split()) for text in request.texts)
        return EmbeddingResponse(
            vectors=vectors,
            model=spec.code,
            provider=self.code,
            dimensions=dimensions,
            usage=TokenUsage.create(input_tokens, 0),
            is_mock=True,
        )

    async def health(self) -> bool:
        return True


_TOKEN_RE = re.compile(r"[a-z0-9]+")


def deterministic_vector(text: str, dimensions: int) -> tuple[float, ...]:
    """Return a stable, L2-normalized pseudo-embedding for `text`.

    Uses the hashing trick over word tokens so that texts sharing vocabulary get
    higher cosine similarity. This is a deterministic stand-in for a real
    embedding model (never a substitute): it makes local RAG demos and
    retrieval-quality tests meaningful without provider credentials.
    """
    vector = [0.0] * dimensions
    tokens = _TOKEN_RE.findall(text.lower())
    if not tokens:
        tokens = ["<empty>"]
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:8], "big") % dimensions
        vector[index] += 1.0
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0:
        norm = 1.0
    return tuple(value / norm for value in vector)
