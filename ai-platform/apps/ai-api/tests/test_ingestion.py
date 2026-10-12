from __future__ import annotations

import pytest

from ai_api.domain.errors import ValidationError
from ai_api.infrastructure.ingestion.chunking import chunk_text
from ai_api.infrastructure.ingestion.extractors import (
    extract_text,
    normalize_text,
    resolve_mime_type,
)


def test_normalize_text_collapses_blank_lines() -> None:
    assert normalize_text("alpha\r\n\r\n\r\nbeta  \n") == "alpha\n\nbeta"


def test_chunk_text_is_deterministic_and_bounded() -> None:
    text = " ".join(f"token{i}" for i in range(600))
    chunks = chunk_text(text, size=500, overlap=50)

    assert len(chunks) >= 2
    assert [chunk.index for chunk in chunks] == list(range(len(chunks)))
    assert all(chunk.content for chunk in chunks)
    assert all(len(chunk.content) <= 500 for chunk in chunks)
    assert all(len(chunk.checksum) == 64 for chunk in chunks)


def test_chunk_text_prefers_paragraph_boundaries() -> None:
    text = "First paragraph. " * 20 + "\n\n" + "Second paragraph. " * 20
    chunks = chunk_text(text, size=200, overlap=0)
    assert any("Second paragraph" in chunk.content for chunk in chunks)


def test_chunk_text_empty_returns_no_chunks() -> None:
    assert chunk_text("   \n\n  ") == []


def test_resolve_mime_type_by_extension() -> None:
    assert resolve_mime_type(None, "notes.md") == "text/markdown"
    assert resolve_mime_type(None, "data.json") == "application/json"
    assert resolve_mime_type("text/plain; charset=utf-8", "x.bin") == "text/plain"


def test_resolve_mime_type_rejects_unsupported() -> None:
    with pytest.raises(ValidationError):
        resolve_mime_type("application/msword", "report.doc")


def test_extract_text_decodes_supported_formats() -> None:
    assert extract_text(b"hello", mime_type="text/plain") == "hello"
    assert extract_text(b"# Title", filename="doc.md") == "# Title"
    assert extract_text(b'{"a": 1}', mime_type="application/json") == '{"a": 1}'


def test_extract_text_rejects_unsupported_format() -> None:
    with pytest.raises(ValidationError):
        extract_text(b"\x00\x01", mime_type="application/octet-stream")
