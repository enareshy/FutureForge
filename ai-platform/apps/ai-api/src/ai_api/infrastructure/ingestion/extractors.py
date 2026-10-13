"""Text extraction for supported knowledge formats (Phase 7).

Supported by default: ``text/plain``, ``text/markdown`` and ``application/pdf``.
PDF support uses the optional ``pypdf`` dependency; if it is not installed, PDF
extraction fails closed with a validation error rather than silently returning
garbage. Other formats (e.g. DOCX) are rejected until extraction and security
tests exist for them.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path

from ai_api.domain.errors import ValidationError

TEXT_MIME_TYPES = {
    "text/plain": "text",
    "text/markdown": "markdown",
    "text/x-markdown": "markdown",
    "application/json": "text",
}
PDF_MIME_TYPES = {"application/pdf"}
SUPPORTED_MIME_TYPES = set(TEXT_MIME_TYPES) | PDF_MIME_TYPES

_EXTENSION_MIME = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".json": "application/json",
    ".pdf": "application/pdf",
}

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")


@dataclass(frozen=True, slots=True)
class Segment:
    """A unit of extracted text with its source location.

    ``page`` is the 1-based PDF page (when applicable); ``section`` is the
    nearest markdown heading (when applicable). At least one may be ``None``.
    """

    text: str
    page: int | None = None
    section: str | None = None


def resolve_mime_type(mime_type: str | None, filename: str | None) -> str:
    if mime_type and mime_type.split(";")[0].strip() in SUPPORTED_MIME_TYPES:
        return mime_type.split(";")[0].strip()
    if filename:
        suffix = Path(filename).suffix.lower()
        if suffix in _EXTENSION_MIME:
            return _EXTENSION_MIME[suffix]
    raise ValidationError(
        "unsupported document format",
        details={
            "mime_type": mime_type,
            "filename": filename,
            "supported": sorted(SUPPORTED_MIME_TYPES),
        },
    )


def extract_segments(
    data: bytes, *, mime_type: str | None = None, filename: str | None = None
) -> list[Segment]:
    """Extract text with source-location metadata, preserving structure."""

    resolved = resolve_mime_type(mime_type, filename)
    if resolved in PDF_MIME_TYPES:
        return _pdf_segments(data)
    return _text_segments(_decode_text(data), resolved)


def extract_text(
    data: bytes, *, mime_type: str | None = None, filename: str | None = None
) -> str:
    segments = extract_segments(data, mime_type=mime_type, filename=filename)
    return "\n\n".join(segment.text for segment in segments)


def _decode_text(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")


def _text_segments(text: str, kind: str) -> list[Segment]:
    if kind == "markdown":
        segments = _markdown_segments(text)
        if segments:
            return segments
    stripped = text.strip()
    return [Segment(text=stripped)] if stripped else []


def _markdown_segments(text: str) -> list[Segment]:
    segments: list[Segment] = []
    current_section: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        body = "\n".join(buffer).strip()
        if body:
            segments.append(Segment(text=body, section=current_section))

    for line in text.splitlines():
        heading = _HEADING_RE.match(line)
        if heading:
            flush()
            buffer = []
            current_section = heading.group(2).strip()
        else:
            buffer.append(line)
    flush()
    return segments


def _pdf_segments(data: bytes) -> list[Segment]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise ValidationError(
            "PDF extraction is unavailable; install the pypdf dependency",
            details={"reason": "missing_dependency"},
        ) from exc

    reader = PdfReader(io.BytesIO(data))
    segments: list[Segment] = []
    for number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            segments.append(Segment(text=text, page=number))
    return segments


def normalize_text(text: str) -> str:
    """Normalize whitespace so chunking and hashing are deterministic."""

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

