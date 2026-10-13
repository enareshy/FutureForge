"""Knowledge ingestion service (Phase 7).

Turns supplied documents into indexed chunks + embeddings:
extract -> normalize -> chunk -> embed -> store (documents, chunks, embeddings).

Access-control labels and classification are copied from the source (or the
document override) onto every document and chunk so retrieval can filter without
joining back. Ingestion is idempotent per ``(source_id, external_id)``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ai_api.application.ports import AiRepository, ObjectStorage, SearchBackend
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.config.settings import Settings
from ai_api.domain.errors import (
    ConfigurationError,
    NotFoundError,
    ValidationError,
    classify_error,
)
from ai_api.domain.models.provider import EmbeddingRequest
from ai_api.infrastructure.ingestion.chunking import chunk_segments
from ai_api.infrastructure.ingestion.extractors import (
    Segment,
    extract_segments,
    resolve_mime_type,
)
from ai_api.infrastructure.providers.registry import default_embedding_model
from ai_api.schemas.knowledge import KnowledgeDocumentIn
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger, request_id_var

logger = get_logger("ingestion")


@dataclass(slots=True)
class IngestionService:
    repository: AiRepository
    gateway: ModelGateway
    audit: AuditService
    settings: Settings
    events: EventPublisher | None = None
    storage: ObjectStorage | None = None
    search: SearchBackend | None = None

    async def enqueue(self, principal: Principal, source_id: int, body: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, source_id)
        if source is None:
            raise NotFoundError("knowledge source not found", details={"source_id": source_id})
        job = await self.repository.create_job(
            tenant_id,
            {
                "type": "index",
                "source_id": source_id,
                "idempotency_key": getattr(body, "idempotency_key", None),
                "payload": {"documents": [doc.model_dump() for doc in body.documents]},
            },
        )
        assert job is not None
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge.index_requested",
            resource_type="job",
            resource_id=str(job["id"]),
            request_id=request_id_var.get(),
            detail={"source_id": source_id, "documents": len(body.documents)},
        )
        if self.events is not None:
            await self.events.knowledge_index_requested(
                tenant_id=tenant_id,
                source_id=source_id,
                job_id=job["id"],
                documents=len(body.documents),
                actor_id=principal.actor_id,
            )
        return job

    async def ingest(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, payload.source_id)
        if source is None:
            raise NotFoundError(
                "knowledge source not found", details={"source_id": payload.source_id}
            )
        if source["status"] == "disabled":
            raise ValidationError("knowledge source is disabled")

        documents = list(payload.documents)
        if len(documents) > self.settings.ai_ingest_max_documents:
            raise ValidationError(
                "too many documents in a single ingest request",
                details={"max": self.settings.ai_ingest_max_documents},
            )

        await self.repository.set_source_status(tenant_id, source["id"], "indexing")
        embed_model = default_embedding_model(self.settings)
        stats = {"documents": 0, "chunks": 0, "skipped": 0}
        try:
            for document in documents:
                segments = await self._extract_segments(document)
                if not any(segment.text.strip() for segment in segments):
                    stats["skipped"] += 1
                    continue
                await self._ingest_document(
                    tenant_id, source, document, segments, embed_model, stats
                )
        except Exception:
            await self.repository.set_source_status(tenant_id, source["id"], "failed")
            raise
        await self.repository.set_source_status(tenant_id, source["id"], "ready")

        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge.ingest",
            resource_type="knowledge_source",
            resource_id=str(source["id"]),
            request_id=request_id_var.get(),
            detail=dict(stats),
        )
        return {"source_id": source["id"], "status": "ready", **stats}

    async def reindex_source(self, principal: Principal, source_id: int) -> dict[str, Any]:
        """Rebuild chunks + embeddings for a source from its stored chunk text."""
        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, source_id)
        if source is None:
            raise NotFoundError("knowledge source not found", details={"source_id": source_id})
        if source["status"] == "disabled":
            raise ValidationError("knowledge source is disabled")

        rows = await self.repository.list_source_chunks(tenant_id, source_id)
        grouped: dict[int, dict[str, Any]] = {}
        for row in rows:
            entry = grouped.setdefault(
                row["document_id"],
                {
                    "external_id": row["external_id"],
                    "title": row.get("title"),
                    "mime_type": row.get("mime_type"),
                    "object_key": row.get("object_key"),
                    "classification": row.get("classification"),
                    "acl": row.get("acl") or {},
                    "parts": [],
                },
            )
            entry["parts"].append(
                (
                    row["chunk_index"],
                    row.get("page"),
                    row.get("section"),
                    row["content"],
                )
            )

        await self.repository.set_source_status(tenant_id, source_id, "indexing")
        embed_model = default_embedding_model(self.settings)
        stats = {"documents": 0, "chunks": 0, "skipped": 0}
        try:
            for entry in grouped.values():
                document = KnowledgeDocumentIn(
                    external_id=entry["external_id"],
                    title=entry["title"],
                    mime_type=entry["mime_type"],
                    object_key=entry.get("object_key"),
                    classification=entry["classification"],
                    acl=entry["acl"],
                )
                if document.object_key:
                    segments = await self._extract_segments(document)
                else:
                    segments = self._segments_from_chunks(entry["parts"])
                if not any(segment.text.strip() for segment in segments):
                    stats["skipped"] += 1
                    continue
                await self._ingest_document(
                    tenant_id, source, document, segments, embed_model, stats
                )
        except Exception:
            await self.repository.set_source_status(tenant_id, source_id, "failed")
            raise
        await self.repository.set_source_status(tenant_id, source_id, "ready")

        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge.reindex",
            resource_type="knowledge_source",
            resource_id=str(source_id),
            request_id=request_id_var.get(),
            detail=dict(stats),
        )
        return {"source_id": source_id, "status": "ready", **stats}

    async def _ingest_document(
        self,
        tenant_id: int,
        source: dict[str, Any],
        document: Any,
        segments: list[Segment],
        embed_model: str,
        stats: dict[str, int],
    ) -> None:
        classification = document.classification or source["classification"]
        acl = document.acl if document.acl else source["acl"]
        text = "\n\n".join(segment.text for segment in segments)
        checksum = hashlib.sha256(text.encode("utf-8")).hexdigest()

        document_row = await self.repository.create_or_replace_document(
            tenant_id,
            {
                "source_id": source["id"],
                "external_id": document.external_id,
                "title": document.title or document.external_id,
                "mime_type": document.mime_type,
                "object_key": getattr(document, "object_key", None),
                "checksum": checksum,
                "size_bytes": len(text.encode("utf-8")),
                "classification": classification,
                "acl": acl,
                "metadata": document.metadata,
            },
        )

        chunks = chunk_segments(
            segments, size=self.settings.ai_chunk_size, overlap=self.settings.ai_chunk_overlap
        )
        if not chunks:
            stats["skipped"] += 1
            return

        chunk_rows = await self.repository.add_chunks(
            tenant_id,
            document_row["id"],
            [
                {
                    "chunk_index": chunk.index,
                    "content": chunk.content,
                    "token_count": chunk.token_count,
                    "checksum": chunk.checksum,
                    "classification": classification,
                    "acl": acl,
                    "page": chunk.page,
                    "section": chunk.section,
                }
                for chunk in chunks
            ],
        )

        batch_size = self.settings.llm_max_embedding_batch
        for start in range(0, len(chunk_rows), batch_size):
            batch = chunk_rows[start : start + batch_size]
            response = await self.gateway.embed(
                EmbeddingRequest(
                    texts=tuple(row["content"] for row in batch),
                    model=embed_model,
                )
            )
            if len(response.vectors) != len(batch):
                raise ValidationError("embedding provider returned an unexpected vector count")
            await self.repository.add_embeddings(
                tenant_id,
                [
                    {
                        "chunk_id": row["id"],
                        "model_code": response.model,
                        "dimensions": response.dimensions,
                        "embedding": list(vector),
                    }
                    for row, vector in zip(batch, response.vectors, strict=True)
                ],
            )

        await self._sync_search(tenant_id, source, document_row, chunk_rows)

        stats["documents"] += 1
        stats["chunks"] += len(chunk_rows)

    async def _sync_search(
        self,
        tenant_id: int,
        source: dict[str, Any],
        document_row: dict[str, Any],
        chunk_rows: list[dict[str, Any]],
    ) -> None:
        """Index chunks into the full-text backend, recording sync state.

        A search-backend failure does not lose the pgvector index: it is recorded
        as a classified ``error_class`` on the document so a later reindex can
        retry, while hybrid retrieval falls back to Postgres full-text search.
        """

        if self.search is None:
            return
        search_document = {
            "id": document_row["id"],
            "source_id": document_row.get("source_id") or source["id"],
            "source_code": source.get("code"),
            "source_name": source.get("name"),
        }
        try:
            await self.search.index_document(tenant_id, search_document, chunk_rows)
            await self.repository.set_document_search_state(
                tenant_id,
                document_row["id"],
                search_indexed_at=datetime.now(UTC),
                status="indexed",
                error_class=None,
            )
        except Exception as exc:  # noqa: BLE001 - search sync is best effort
            logger.warning(
                "ingestion.search_sync_failed",
                document_id=document_row["id"],
                error_class=classify_error(exc),
                error=str(exc)[:200],
            )
            await self.repository.set_document_search_state(
                tenant_id,
                document_row["id"],
                search_indexed_at=None,
                status="indexed",
                error_class=classify_error(exc),
            )

    async def _extract_segments(self, document: Any) -> list[Segment]:
        if getattr(document, "object_key", None):
            if self.storage is None:
                raise ConfigurationError("object storage is not configured")
            data = await self.storage.get(document.object_key)
            if data is None:
                raise NotFoundError(
                    "stored document not found",
                    details={"object_key": document.object_key},
                )
            mime = resolve_mime_type(document.mime_type, document.external_id)
            return extract_segments(data, mime_type=mime, filename=document.external_id)
        if document.text:
            return self._text_segments(document)
        if document.content_base64:
            try:
                data = base64.b64decode(document.content_base64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValidationError("content_base64 is not valid base64") from exc
            mime = resolve_mime_type(document.mime_type, document.external_id)
            return extract_segments(data, mime_type=mime, filename=document.external_id)
        raise ValidationError(
            "document must include text, content_base64, or object_key",
            details={"external_id": document.external_id},
        )

    def _text_segments(self, document: Any) -> list[Segment]:
        try:
            mime = resolve_mime_type(document.mime_type, document.external_id)
        except ValidationError:
            return [Segment(text=document.text)]
        return extract_segments(
            document.text.encode("utf-8"),
            mime_type=mime,
            filename=document.external_id,
        )

    @staticmethod
    def _segments_from_chunks(parts: list[tuple[Any, ...]]) -> list[Segment]:
        segments: list[Segment] = []
        for _, page, section, content in sorted(parts, key=lambda part: part[0]):
            if content and content.strip():
                segments.append(Segment(text=content, page=page, section=section))
        return segments
