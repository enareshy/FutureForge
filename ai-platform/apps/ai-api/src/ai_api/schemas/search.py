"""Enterprise search request/response models (Stage 4).

The request extends the Stage 3 `SearchRequest` with a retrieval ``mode``,
allowlisted metadata ``filters``, a ``sort`` mode and simple pagination. All
fields are optional so the original `{query, limit}` contract keeps working.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

SearchMode = Literal["hybrid", "lexical", "semantic"]
SearchSort = Literal["relevance", "recency", "title"]
FilterOp = Literal["eq", "ne", "in", "contains", "gte", "lte"]

# A filter value is intentionally narrow: scalars for equality/range operators and
# a homogeneous list for the `in` operator. Free-form structures are rejected by
# the server-side registry so no untrusted shape reaches query construction.
FilterValue = str | int | float | list[str] | list[int]


class SearchFilter(BaseModel):
    """A single metadata filter, validated against the allowlist server-side."""

    field: str = Field(min_length=1, max_length=64)
    op: FilterOp = "eq"
    value: FilterValue


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    limit: int = Field(default=10, ge=1, le=50)
    mode: SearchMode = "hybrid"
    filters: list[SearchFilter] = Field(default_factory=list, max_length=20)
    sort: SearchSort = "relevance"
    page: int = Field(default=1, ge=1)


class SavedSearchCreate(BaseModel):
    """A reusable search: the request (query + mode + filters + sort), not results."""

    name: str = Field(min_length=1, max_length=120)
    query: str = Field(min_length=1, max_length=4000)
    mode: SearchMode = "hybrid"
    filters: list[SearchFilter] = Field(default_factory=list, max_length=20)
    sort: SearchSort = "relevance"
    metadata: dict[str, Any] = Field(default_factory=dict)


class SavedSearchOut(BaseModel):
    id: int
    name: str
    query: str
    mode: SearchMode
    filters: list[SearchFilter] = Field(default_factory=list)
    sort: SearchSort
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class SearchHistoryOut(BaseModel):
    id: int
    query: str
    mode: SearchMode
    filters: list[SearchFilter] = Field(default_factory=list)
    sort: SearchSort
    result_count: int
    fallback: bool
    created_at: datetime


class FacetBucket(BaseModel):
    value: str
    count: int


class Facet(BaseModel):
    field: str
    buckets: list[FacetBucket]


class FacetsResponse(BaseModel):
    query: str
    mode: SearchMode
    fallback: bool
    total: int
    facets: list[Facet]


class SuggestionsResponse(BaseModel):
    query: str
    suggestions: list[str]


class IndexCounts(BaseModel):
    total: int
    indexed: int
    pending: int
    stale: int
    missing: int
    failed: int


class SearchHealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    tenant_id: int
    search_backend: str
    hybrid_search: bool
    documents: IndexCounts
    chunks_total: int
    embeddings_total: int
    jobs: dict[str, int] = Field(default_factory=dict)
    last_indexed_at: datetime | None = None


class SourceIndexStatus(BaseModel):
    source_id: int
    source_code: str
    source_status: str
    documents_total: int
    indexed: int
    pending: int
    stale: int
    missing: int
    failed: int


class ProblemDocument(BaseModel):
    document_id: int
    source_id: int
    external_id: str
    title: str | None = None
    status: str | None = None
    search_indexed_at: datetime | None = None
    indexed_at: datetime | None = None
    error_class: str | None = None
    source_code: str | None = None


class IndexStatusResponse(BaseModel):
    totals: IndexCounts
    sources: list[SourceIndexStatus] = Field(default_factory=list)
    problem_documents: list[ProblemDocument] = Field(default_factory=list)


class ReconcileRequest(BaseModel):
    limit: int = Field(100, ge=1, le=500)
    scan_orphans: bool = False
    purge_orphans: bool = False


class ReconcileResponse(BaseModel):
    sources_candidates: int = 0
    sources_queued: int
    sources_would_queue: int = 0
    jobs: list[int] = Field(default_factory=list)
    orphans_detected: int = 0
    orphan_document_ids: list[int] = Field(default_factory=list)
    missing_source_ids: list[int] = Field(default_factory=list)
    disabled_source_ids: list[int] = Field(default_factory=list)
    orphans_deleted: int = 0


class DuplicateFindingOut(BaseModel):
    id: int
    kind: Literal["duplicate", "conflict"]
    match_type: Literal["checksum", "external_id", "title"]
    confidence: float
    document_a_id: int
    document_b_id: int
    evidence: dict[str, Any] = Field(default_factory=dict)
    status: Literal["open", "dismissed", "resolved"]
    note: str | None = None
    reviewed_by: int | None = None
    reviewed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class DuplicateScanResponse(BaseModel):
    documents_scanned: int
    findings: int
    created: int
    updated: int
    skipped: int
    by_kind: dict[str, int] = Field(default_factory=dict)


class DuplicateReviewRequest(BaseModel):
    status: Literal["dismissed", "resolved"]
    note: str | None = Field(default=None, max_length=2000)
