from __future__ import annotations

from pydantic import BaseModel, Field

from ai_api.schemas.search import SearchFilter, SearchMode, SearchRequest

__all__ = ["RagQueryRequest", "SearchRequest"]


class RagQueryRequest(BaseModel):
    """A RAG question, optionally narrowed by Stage 4 search mode/filters.

    ``mode`` and ``filters`` default to the Stage 3 behaviour (hybrid retrieval,
    no filters) so existing callers are unaffected. Filters are allowlisted and
    applied to already-authorized candidates inside the retrieval service; they
    can only narrow scope, never widen it.
    """

    query: str = Field(min_length=1, max_length=4000)
    limit: int = Field(default=5, ge=1, le=20)
    model: str | None = Field(default=None, max_length=200)
    mode: SearchMode = "hybrid"
    filters: list[SearchFilter] = Field(default_factory=list, max_length=20)
