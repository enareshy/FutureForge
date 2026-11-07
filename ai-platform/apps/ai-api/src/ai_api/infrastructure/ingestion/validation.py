"""Upload validation for supported knowledge formats (Stage 3).

Never trust the client-supplied filename or MIME type: the declared type is only
used to disambiguate between the textual formats, while the actual bytes are
sniffed against known signatures. Files that do not match a supported signature
fail closed with a validation error, and size limits are enforced before any
bytes are persisted.
"""

from __future__ import annotations

from ai_api.domain.errors import ValidationError
from ai_api.infrastructure.ingestion.extractors import (
    PDF_MIME_TYPES,
    SUPPORTED_MIME_TYPES,
    TEXT_MIME_TYPES,
    resolve_mime_type,
)

PDF_SIGNATURE = b"%PDF-"
_UTF8_BOM = b"\xef\xbb\xbf"
_SNIFF_BYTES = 4096

_FAMILY_MIME = {
    "text": "text/plain",
    "markdown": "text/markdown",
    "json": "application/json",
    "pdf": "application/pdf",
}

# Restrict the accept-list to formats we can actually parse safely.
UPLOAD_MIME_TYPES = {
    "text/plain",
    "text/markdown",
    "text/x-markdown",
    "application/json",
    "application/pdf",
}


def _family_for_mime(mime_type: str) -> str:
    base = mime_type.split(";")[0].strip().lower()
    if base in PDF_MIME_TYPES:
        return "pdf"
    if base == "application/json":
        return "json"
    if "markdown" in base:
        return "markdown"
    return "text"


def sniff_family(data: bytes) -> str | None:
    """Return the detected format family, or ``None`` if unrecognized."""

    if data.startswith(PDF_SIGNATURE):
        return "pdf"
    sample = data[:_SNIFF_BYTES]
    if sample.startswith(_UTF8_BOM):
        sample = sample[len(_UTF8_BOM) :]
    if b"\x00" in sample:
        return None
    try:
        sample.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return "text"


def validate_upload(
    data: bytes,
    *,
    filename: str | None,
    declared_mime: str | None,
    max_bytes: int,
) -> str:
    """Validate uploaded bytes and return the resolved MIME type.

    Raises ``ValidationError`` for empty payloads, oversized uploads, unsupported
    formats, or a signature that does not match the format family implied by the
    declared type / filename.
    """

    if not data:
        raise ValidationError("uploaded document is empty")
    if max_bytes and len(data) > max_bytes:
        raise ValidationError(
            "uploaded document exceeds the maximum allowed size",
            details={"max_bytes": max_bytes, "size_bytes": len(data)},
        )

    # Resolve the intended type using the same rules as extraction; this also
    # rejects unsupported extensions / MIME types up front.
    resolved = resolve_mime_type(declared_mime, filename)
    if resolved not in SUPPORTED_MIME_TYPES:
        raise ValidationError(
            "unsupported document format",
            details={"mime_type": declared_mime, "filename": filename},
        )

    expected_family = _family_for_mime(resolved)
    detected_family = sniff_family(data)
    if detected_family is None:
        raise ValidationError(
            "uploaded document signature is not recognized",
            details={"filename": filename, "mime_type": resolved},
        )

    if detected_family == "pdf":
        return _FAMILY_MIME["pdf"]
    if expected_family == "pdf":
        raise ValidationError(
            "uploaded document does not match the declared PDF format",
            details={"filename": filename},
        )
    # Textual bytes: keep the more specific textual declaration, defaulting to
    # plain text (also covers a JSON/Markdown declaration on text content).
    if resolved in TEXT_MIME_TYPES:
        return resolved
    return _FAMILY_MIME.get(expected_family, _FAMILY_MIME["text"])


__all__ = [
    "PDF_SIGNATURE",
    "UPLOAD_MIME_TYPES",
    "sniff_family",
    "validate_upload",
]
