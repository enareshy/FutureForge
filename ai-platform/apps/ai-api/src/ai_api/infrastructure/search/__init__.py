"""Full-text search backends for knowledge retrieval (Stage 3).

Two interchangeable implementations satisfy ``application.ports.SearchBackend``:

* ``RepositoryLexicalSearch`` — Postgres full-text search via the repository
  (always available; the default and the documented fallback).
* ``OpenSearchBackend`` — a real OpenSearch/Elasticsearch client with a chunk
  index, used when ``SEARCH_PROVIDER=opensearch``.

Hybrid retrieval fuses the vector and lexical candidate lists with reciprocal
rank fusion in the retrieval service; no backend is allowed to bypass the
authorization filter that runs on the fused candidates.
"""

from __future__ import annotations

from typing import Any

from ai_api.application.ports import AiRepository, SearchBackend
from ai_api.config.settings import Settings

__all__ = [
    "RepositoryLexicalSearch",
    "build_search_backend",
]


class RepositoryLexicalSearch:
    """Lexical search backed by the repository's Postgres full-text query."""

    name = "postgres-fts"

    def __init__(self, repository: AiRepository) -> None:
        self._repository = repository

    async def search(
        self, tenant_id: int, query: str, *, limit: int
    ) -> list[dict[str, Any]]:
        return await self._repository.lexical_search(tenant_id, query, limit=limit)

    async def index_document(
        self,
        tenant_id: int,
        document: dict[str, Any],
        chunks: list[dict[str, Any]],
    ) -> None:
        # Postgres is the source of truth; the chunk rows already are the index.
        return None

    async def delete_document(self, tenant_id: int, document_id: int) -> None:
        return None

    async def status(self) -> dict[str, Any]:
        return {"backend": self.name, "available": True}


def build_search_backend(settings: Settings, repository: AiRepository) -> SearchBackend:
    if settings.search_provider == "opensearch":
        from ai_api.infrastructure.search.opensearch import OpenSearchBackend

        return OpenSearchBackend(settings)
    return RepositoryLexicalSearch(repository)
