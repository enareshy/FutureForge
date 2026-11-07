"""OpenSearch-backed chunk index (Stage 3).

A thin, fail-closed wrapper over ``opensearch-py``'s async client. The client is
imported lazily so the module stays importable without the dependency; when the
client or the cluster is unavailable, operations raise rather than silently
returning empty results. Internal endpoints and credentials are never exposed to
callers (only a short health summary is returned by ``status``).

Documents are indexed per chunk with tenant/source metadata and ACL labels so
retrieval can apply the same filters as the pgvector path. The index is a single
tenant-filtered index (``<prefix>-chunks``); authorization still happens in the
retrieval service on the fused candidate list, never in OpenSearch.
"""

from __future__ import annotations

from typing import Any

from ai_api.config.settings import Settings
from ai_api.domain.errors import ConfigurationError, ServiceUnavailableError
from ai_api.telemetry.logging import get_logger

logger = get_logger("search.opensearch")

_MAPPING: dict[str, Any] = {
    "settings": {"index": {"number_of_shards": 1, "number_of_replicas": 0}},
    "mappings": {
        "properties": {
            "tenant_id": {"type": "long"},
            "document_id": {"type": "long"},
            "source_id": {"type": "long"},
            "source_code": {"type": "keyword"},
            "source_name": {"type": "keyword"},
            "chunk_id": {"type": "long"},
            "chunk_index": {"type": "integer"},
            "page": {"type": "integer"},
            "section": {"type": "keyword"},
            "classification": {"type": "keyword"},
            "acl": {"type": "object", "enabled": False},
            "title": {"type": "text"},
            "mime_type": {"type": "keyword"},
            "external_id": {"type": "keyword"},
            "document_status": {"type": "keyword"},
            "document_created_at": {"type": "date"},
            "document_updated_at": {"type": "date"},
            "document_metadata": {"type": "object", "enabled": False},
            "content": {"type": "text"},
        }
    },
}


def _iso(value: Any) -> str | None:
    """Best-effort ISO-8601 string for a datetime-like value (or None)."""
    if value is None:
        return None
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else str(value)


class OpenSearchBackend:
    name = "opensearch"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._index = f"{settings.opensearch_index_prefix}-chunks"
        self._client: Any | None = None
        self._index_ready = False

    def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            from opensearchpy import AsyncOpenSearch  # noqa: PLC0415 - optional dependency
        except ImportError as exc:  # pragma: no cover - depends on environment
            raise ConfigurationError(
                "OpenSearch backend requires the opensearch-py dependency",
                details={"reason": "missing_dependency"},
            ) from exc
        auth = None
        if self._settings.opensearch_username:
            auth = (
                self._settings.opensearch_username,
                self._settings.opensearch_password.get_secret_value(),
            )
        self._client = AsyncOpenSearch(
            hosts=[self._settings.opensearch_url],
            http_auth=auth,
            verify_certs=not self._settings.opensearch_insecure,
            ssl_show_warn=False,
            timeout=self._settings.opensearch_timeout_seconds,
        )
        return self._client

    async def _ensure_index(self) -> None:
        if self._index_ready:
            return
        client = self._ensure_client()
        exists = await client.indices.exists(index=self._index)
        if not exists:
            await client.indices.create(index=self._index, body=_MAPPING)
        self._index_ready = True

    async def search(
        self, tenant_id: int, query: str, *, limit: int
    ) -> list[dict[str, Any]]:
        client = self._ensure_client()
        try:
            response = await client.search(
                index=self._index,
                body={
                    "size": max(limit, 1),
                    "query": {
                        "bool": {
                            "filter": [{"term": {"tenant_id": tenant_id}}],
                            "must": [{"match": {"content": {"query": query}}}],
                        }
                    },
                    "_source": [
                        "document_id",
                        "source_id",
                        "source_code",
                        "source_name",
                        "chunk_id",
                        "chunk_index",
                        "page",
                        "section",
                        "classification",
                        "acl",
                        "title",
                        "mime_type",
                        "external_id",
                        "document_status",
                        "document_created_at",
                        "document_updated_at",
                        "document_metadata",
                        "content",
                    ],
                },
            )
        except ConfigurationError:
            raise
        except Exception as exc:  # noqa: BLE001 - reported as dependency failure
            raise ServiceUnavailableError("OpenSearch query failed") from exc
        return [self._to_candidate(hit) for hit in response.get("hits", {}).get("hits", [])]

    @staticmethod
    def _to_candidate(hit: dict[str, Any]) -> dict[str, Any]:
        source = dict(hit.get("_source") or {})
        source["score"] = float(hit.get("_score") or 0.0)
        return source

    async def index_document(
        self,
        tenant_id: int,
        document: dict[str, Any],
        chunks: list[dict[str, Any]],
    ) -> None:
        if not chunks:
            return
        await self._ensure_index()
        client = self._ensure_client()
        document_id = document["id"]
        # Replace any prior chunks for this document, including chunks left
        # behind by an earlier reindex that assigned the document a new id. The
        # stable identity is (source_id, external_id), not document_id.
        await self.delete_document(
            tenant_id,
            document_id,
            source_id=document.get("source_id"),
            external_id=document.get("external_id"),
        )
        operations: list[dict[str, Any]] = []
        for chunk in chunks:
            operations.append(
                {
                    "index": {
                        "_index": self._index,
                        "_id": f"{tenant_id}:{chunk['id']}",
                    }
                }
            )
            operations.append(
                {
                    "tenant_id": tenant_id,
                    "document_id": document_id,
                    "source_id": document.get("source_id"),
                    "source_code": document.get("source_code"),
                    "source_name": document.get("source_name"),
                    "chunk_id": chunk["id"],
                    "chunk_index": chunk.get("chunk_index"),
                    "page": chunk.get("page"),
                    "section": chunk.get("section"),
                    "classification": chunk.get("classification"),
                    "acl": chunk.get("acl") or {},
                    "title": document.get("title"),
                    "mime_type": document.get("mime_type"),
                    "external_id": document.get("external_id"),
                    "document_status": document.get("status"),
                    "document_created_at": _iso(document.get("created_at")),
                    "document_updated_at": _iso(document.get("updated_at")),
                    "document_metadata": document.get("metadata") or {},
                    "content": chunk.get("content", ""),
                }
            )
        try:
            await client.bulk(body=operations, refresh=True)
        except ConfigurationError:
            raise
        except Exception as exc:  # noqa: BLE001 - reported as dependency failure
            raise ServiceUnavailableError("OpenSearch indexing failed") from exc

    async def delete_document(
        self,
        tenant_id: int,
        document_id: int,
        *,
        source_id: int | None = None,
        external_id: str | None = None,
    ) -> None:
        filters: list[dict[str, Any]] = [{"term": {"tenant_id": tenant_id}}]
        if source_id is not None and external_id is not None:
            filters.extend(
                [
                    {"term": {"source_id": source_id}},
                    {"term": {"external_id": external_id}},
                ]
            )
        else:
            filters.append({"term": {"document_id": document_id}})
        await self._delete_by_query(filters)

    async def delete_source(self, tenant_id: int, source_id: int) -> None:
        await self._delete_by_query(
            [
                {"term": {"tenant_id": tenant_id}},
                {"term": {"source_id": source_id}},
            ]
        )

    async def delete_documents(
        self, tenant_id: int, document_ids: list[int]
    ) -> None:
        if not document_ids:
            return
        await self._delete_by_query(
            [
                {"term": {"tenant_id": tenant_id}},
                {"terms": {"document_id": document_ids}},
            ]
        )

    async def scan_documents(
        self,
        tenant_id: int,
        *,
        limit: int,
        after: list[Any] | None = None,
    ) -> tuple[list[dict[str, Any]], list[Any] | None]:
        """Bounded, tenant-scoped scan of distinct indexed document identities.

        Returns at most ``limit`` documents plus a ``search_after`` cursor. Used
        only by reconciliation; it is not an authorization pathway.
        """
        client = self._ensure_client()
        found: dict[int, dict[str, Any]] = {}
        cursor = after
        page_size = min(max(limit * 4, 100), 1000)
        pages = 0
        while len(found) < limit and pages < 20:
            pages += 1
            body: dict[str, Any] = {
                "size": page_size,
                "query": {"term": {"tenant_id": tenant_id}},
                "sort": [{"document_id": "asc"}, {"chunk_id": "asc"}],
                "_source": ["document_id", "source_id", "external_id"],
            }
            if cursor is not None:
                body["search_after"] = cursor
            try:
                response = await client.search(index=self._index, body=body)
            except Exception as exc:  # noqa: BLE001 - reported as dependency failure
                raise ServiceUnavailableError("OpenSearch scan failed") from exc
            hits = response.get("hits", {}).get("hits", [])
            if not hits:
                cursor = None
                break
            for hit in hits:
                source = hit.get("_source") or {}
                document_id = source.get("document_id")
                if document_id is None:
                    continue
                found.setdefault(
                    int(document_id),
                    {
                        "document_id": int(document_id),
                        "source_id": source.get("source_id"),
                        "external_id": source.get("external_id"),
                    },
                )
            cursor = hits[-1].get("sort")
            if len(hits) < page_size:
                cursor = None
                break
        rows = list(found.values())[:limit]
        return rows, cursor

    async def _delete_by_query(self, filters: list[dict[str, Any]]) -> None:
        client = self._ensure_client()
        try:
            if not await client.indices.exists(index=self._index):
                return
            await client.delete_by_query(
                index=self._index,
                body={"query": {"bool": {"filter": filters}}},
                refresh=True,
                conflicts="proceed",
            )
        except ConfigurationError:
            raise
        except Exception as exc:  # noqa: BLE001 - reported as dependency failure
            raise ServiceUnavailableError("OpenSearch delete failed") from exc

    async def status(self) -> dict[str, Any]:
        try:
            client = self._ensure_client()
            health = await client.cluster.health()
        except ConfigurationError as exc:
            return {"backend": self.name, "available": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 - reported, never raised
            return {
                "backend": self.name,
                "available": False,
                "index": self._index,
                "error": str(exc)[:200],
            }
        return {
            "backend": self.name,
            "available": True,
            "index": self._index,
            "status": health.get("status"),
        }
