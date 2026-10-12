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
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.config.settings import Settings
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.domain.models.provider import EmbeddingRequest
from ai_api.infrastructure.ingestion.chunking import chunk_text
from ai_api.infrastructure.ingestion.extractors import extract_text, resolve_mime_type
from ai_api.infrastructure.providers.registry import default_embedding_model
from ai_api.schemas.knowledge import KnowledgeDocumentIn
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import request_id_var


@dataclass(slots=True)
class IngestionService:
    repository: AiRepository
    gateway: ModelGateway
    audit: AuditService
    settings: Settings
    events: EventPublisher | None = None

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
                text = self._extract(document)
                if not text.strip():
                    stats["skipped"] += 1
                    continue
                await self._ingest_document(
                    tenant_id, source, document, text, embed_model, stats
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
                    "classification": row.get("classification"),
                    "acl": row.get("acl") or {},
                    "parts": [],
                },
            )
            entry["parts"].append((row["chunk_index"], row["content"]))

        await self.repository.set_source_status(tenant_id, source_id, "indexing")
        embed_model = default_embedding_model(self.settings)
        stats = {"documents": 0, "chunks": 0, "skipped": 0}
        try:
            for entry in grouped.values():
                text = "\n\n".join(part for _, part in sorted(entry["parts"]))
                document = KnowledgeDocumentIn(
                    external_id=entry["external_id"],
                    title=entry["title"],
                    mime_type=entry["mime_type"],
                    text=text,
                    classification=entry["classification"],
                    acl=entry["acl"],
                )
                await self._ingest_document(
                    tenant_id, source, document, text, embed_model, stats
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
        text: str,
        embed_model: str,
        stats: dict[str, int],
    ) -> None:
        classification = document.classification or source["classification"]
        acl = document.acl if document.acl else source["acl"]
        checksum = hashlib.sha256(text.encode("utf-8")).hexdigest()

        document_row = await self.repository.create_or_replace_document(
            tenant_id,
            {
                "source_id": source["id"],
                "external_id": document.external_id,
                "title": document.title or document.external_id,
                "mime_type": document.mime_type,
                "checksum": checksum,
                "size_bytes": len(text.encode("utf-8")),
                "classification": classification,
                "acl": acl,
                "metadata": document.metadata,
            },
        )

        chunks = chunk_text(
            text, size=self.settings.ai_chunk_size, overlap=self.settings.ai_chunk_overlap
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

        stats["documents"] += 1
        stats["chunks"] += len(chunk_rows)

    def _extract(self, document: Any) -> str:
        if document.text:
            return document.text
        if document.content_base64:
            try:
                data = base64.b64decode(document.content_base64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValidationError("content_base64 is not valid base64") from exc
            mime = resolve_mime_type(document.mime_type, document.external_id)
            return extract_text(data, mime_type=mime, filename=document.external_id)
        raise ValidationError(
            "document must include either text or content_base64",
            details={"external_id": document.external_id},
        )
