"""Deterministic text chunking (Phase 7).

Chunks target a character budget with a bounded overlap so that retrieval keeps
local context. Boundaries prefer paragraph/line/sentence breaks to avoid cutting
mid-thought. Each chunk carries a checksum for idempotency and change detection.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from ai_api.infrastructure.ingestion.extractors import normalize_text


@dataclass(frozen=True, slots=True)
class Chunk:
    index: int
    content: str
    token_count: int
    checksum: str


def chunk_text(text: str, *, size: int = 800, overlap: int = 120) -> list[Chunk]:
    normalized = normalize_text(text)
    if not normalized:
        return []

    size = max(1, size)
    overlap = max(0, min(overlap, size - 1))

    chunks: list[Chunk] = []
    start = 0
    length = len(normalized)
    while start < length:
        end = min(start + size, length)
        if end < length:
            window = normalized[start:end]
            boundary = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind(". "))
            if boundary > size // 2:
                end = start + boundary + 1
        content = normalized[start:end].strip()
        if content:
            checksum = hashlib.sha256(content.encode("utf-8")).hexdigest()
            chunks.append(
                Chunk(
                    index=len(chunks),
                    content=content,
                    token_count=len(content.split()),
                    checksum=checksum,
                )
            )
        if end >= length:
            break
        start = max(end - overlap, start + 1)
    return chunks
