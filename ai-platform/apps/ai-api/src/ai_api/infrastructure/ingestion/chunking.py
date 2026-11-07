"""Deterministic text chunking with source-location preservation (Phase 7 / Stage 3).

Chunks target a character budget with a bounded overlap so that retrieval keeps
local context. Boundaries prefer paragraph/line/sentence breaks to avoid cutting
mid-thought. Each chunk carries a checksum for idempotency and change detection,
and the page/section of its source segment so citations resolve to a real
location, not just a chunk ordinal.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from ai_api.infrastructure.ingestion.extractors import Segment, normalize_text


@dataclass(frozen=True, slots=True)
class Chunk:
    index: int
    content: str
    token_count: int
    checksum: str
    page: int | None = None
    section: str | None = None


def _split(text: str, size: int, overlap: int) -> list[str]:
    if not text:
        return []
    size = max(1, size)
    overlap = max(0, min(overlap, size - 1))
    pieces: list[str] = []
    start = 0
    length = len(text)
    while start < length:
        end = min(start + size, length)
        if end < length:
            window = text[start:end]
            boundary = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind(". "))
            if boundary > size // 2:
                end = start + boundary + 1
        content = text[start:end].strip()
        if content:
            pieces.append(content)
        if end >= length:
            break
        start = max(end - overlap, start + 1)
    return pieces


def chunk_segments(
    segments: list[Segment], *, size: int = 800, overlap: int = 120
) -> list[Chunk]:
    """Chunk located segments, preserving page/section on every chunk."""

    chunks: list[Chunk] = []
    for segment in segments:
        normalized = normalize_text(segment.text)
        for piece in _split(normalized, size, overlap):
            checksum = hashlib.sha256(piece.encode("utf-8")).hexdigest()
            chunks.append(
                Chunk(
                    index=len(chunks),
                    content=piece,
                    token_count=len(piece.split()),
                    checksum=checksum,
                    page=segment.page,
                    section=segment.section,
                )
            )
    return chunks


def chunk_text(text: str, *, size: int = 800, overlap: int = 120) -> list[Chunk]:
    normalized = normalize_text(text)
    if not normalized:
        return []
    return chunk_segments([Segment(text=normalized)], size=size, overlap=overlap)
