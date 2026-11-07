"""Shared citation validation and answer-status semantics.

The platform uses inline ``[n]`` references that map to the ordered citation
list built from the *authorized* evidence supplied to the model. Validation is
structural: it proves that a reference is well-formed, in range and maps back to
evidence from this request. It does not prove sentence-level entailment.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

CitationStatus = Literal["not_required", "valid", "missing", "invalid"]

ANSWER_STATUS_ANSWERED = "answered"
ANSWER_STATUS_INSUFFICIENT = "insufficient_evidence"
ANSWER_STATUS_CITATION_WARNING = "citation_warning"
ANSWER_STATUS_ERROR = "error"
ANSWER_STATUS_CANCELLED = "cancelled"

ANSWER_STATUSES = frozenset(
    {
        ANSWER_STATUS_ANSWERED,
        ANSWER_STATUS_INSUFFICIENT,
        ANSWER_STATUS_CITATION_WARNING,
        ANSWER_STATUS_ERROR,
        ANSWER_STATUS_CANCELLED,
    }
)

_CITATION_RE = re.compile(r"\[(\d{1,3})\]")
_BRACKET_TOKEN_RE = re.compile(r"\[([^\[\]\n]{1,60})\]")
_MALFORMED_CITATION_RE = re.compile(
    r"^(?:#|citation|cite|ref|source)?\s*[:#]?\s*\d[\d\s,;/\-–]*$",
    re.IGNORECASE,
)
_REQUIRED_METADATA = (
    "source_id",
    "document_id",
    "chunk_id",
    "source_code",
    "chunk_index",
)


@dataclass(frozen=True, slots=True)
class CitationValidation:
    """Authoritative citation outcome for one generated answer."""

    required: bool
    status: CitationStatus
    warnings: tuple[str, ...] = ()
    referenced_ranks: tuple[int, ...] = ()

    @property
    def failed(self) -> bool:
        return self.status in ("missing", "invalid")

    def answer_status(self, *, insufficient: bool = False) -> str:
        if insufficient:
            return ANSWER_STATUS_INSUFFICIENT
        if self.failed:
            return ANSWER_STATUS_CITATION_WARNING
        return ANSWER_STATUS_ANSWERED


def not_required() -> CitationValidation:
    """A response whose existing contract does not use retrieved evidence."""

    return CitationValidation(required=False, status="not_required")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_malformed_citation(token: str) -> bool:
    stripped = token.strip()
    if stripped.isdigit():
        return False
    return bool(_MALFORMED_CITATION_RE.fullmatch(stripped))


def _metadata_warnings(
    citations: list[Any], evidence: list[dict[str, Any]] | None
) -> list[str]:
    warnings: set[str] = set()
    ranks: set[int] = set()
    refs: set[tuple[Any, Any]] = set()
    evidence_refs: set[tuple[Any, Any]] | None = None
    if evidence is not None:
        evidence_refs = {
            (item.get("document_id"), item.get("chunk_id")) for item in evidence
        }

    for index, citation in enumerate(citations, start=1):
        if not isinstance(citation, dict):
            warnings.add("invalid_citation_metadata")
            continue
        rank = citation.get("rank")
        if not _is_int(rank) or rank != index or rank in ranks:
            warnings.add("invalid_citation_metadata")
        else:
            ranks.add(rank)
        if any(citation.get(name) is None for name in _REQUIRED_METADATA):
            warnings.add("invalid_citation_metadata")
        pair = (citation.get("document_id"), citation.get("chunk_id"))
        if all(part is not None for part in pair):
            if pair in refs:
                warnings.add("duplicate_citation_references")
            refs.add(pair)
            if evidence_refs is not None and pair not in evidence_refs:
                warnings.add("unmatched_citation_evidence")
    return sorted(warnings)


def validate_inline_citations(
    content: str,
    citations: list[dict[str, Any]] | None,
    *,
    required: bool,
    evidence: list[dict[str, Any]] | None = None,
) -> CitationValidation:
    """Validate ``[n]`` references against this request's citation list.

    ``evidence`` is optional and lets callers additionally prove that every
    citation row maps to a chunk that was actually part of the model input.
    Metadata and reference failures are reported as opaque warning codes; no
    source identifiers or document content are included in diagnostics.
    """

    if not required:
        return not_required()

    normalized = list(citations or [])
    referenced = tuple(sorted({int(match) for match in _CITATION_RE.findall(content or "")}))
    malformed = any(
        _is_malformed_citation(token)
        for token in _BRACKET_TOKEN_RE.findall(content or "")
        if not token.strip().isdigit()
    )
    metadata = _metadata_warnings(normalized, evidence)
    warnings: list[str] = []
    missing = False
    invalid = bool(metadata) or malformed

    if not normalized:
        warnings.append("no_citations_available")
        missing = True
    if not referenced:
        if normalized:
            warnings.append("no_citation_markers")
        missing = True
    elif any(rank < 1 or rank > len(normalized) for rank in referenced):
        warnings.append("invalid_citation_references")
        invalid = True
    if malformed:
        warnings.append("malformed_citation_markers")
    warnings.extend(metadata)

    if invalid:
        status: CitationStatus = "invalid"
    elif missing:
        status = "missing"
    else:
        status = "valid"
    return CitationValidation(
        required=True,
        status=status,
        warnings=tuple(dict.fromkeys(warnings)),
        referenced_ranks=referenced,
    )


def validate_extraction_citations(
    structured: dict[str, Any] | None,
    *,
    fields: list[dict[str, Any]],
) -> CitationValidation:
    """Validate per-field evidence numbers in structured extraction output."""

    if structured is None:
        return CitationValidation(
            required=True,
            status="invalid",
            warnings=("invalid_extraction_output",),
        )

    values = structured.get("fields") or {}
    evidence = structured.get("evidence") or {}
    missing: set[str] = set(structured.get("citation_missing") or [])
    invalid: set[str] = set(structured.get("citation_invalid") or [])
    if not missing and not invalid:
        for field in fields:
            name = field["name"]
            if values.get(name) is None:
                continue
            refs = evidence.get(name)
            if not isinstance(refs, list) or not refs:
                missing.add(name)
                continue
            if any(not _is_int(ref) or ref < 1 for ref in refs):
                invalid.add(name)

    warnings: list[str] = []
    if missing:
        warnings.append("missing_extraction_citation")
    if invalid:
        warnings.append("invalid_extraction_citation")
    if invalid:
        status: CitationStatus = "invalid"
    elif missing:
        status = "missing"
    else:
        status = "valid"
    return CitationValidation(
        required=True,
        status=status,
        warnings=tuple(warnings),
    )
