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


def extract_text(
    data: bytes, *, mime_type: str | None = None, filename: str | None = None
) -> str:
    resolved = resolve_mime_type(mime_type, filename)
    if resolved in PDF_MIME_TYPES:
        return _extract_pdf(data)
    return _decode_text(data)


def _decode_text(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")


def _extract_pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise ValidationError(
            "PDF extraction is unavailable; install the pypdf dependency",
            details={"reason": "missing_dependency"},
        ) from exc

    reader = PdfReader(io.BytesIO(data))
    pages = [(page.extract_text() or "") for page in reader.pages]
    return "\n\n".join(pages)


def normalize_text(text: str) -> str:
    """Normalize whitespace so chunking and hashing are deterministic."""

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
