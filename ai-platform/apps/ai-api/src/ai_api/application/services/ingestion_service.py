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
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.config.settings import Settings
from ai_api.domain.errors import (
    AuthorizationError,
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
from ai_api.infrastructure.storage import (
    validate_document_object_key,
    validate_tenant_object_key,
)
from ai_api.schemas.knowledge import StoredKnowledgeDocumentIn
from ai_api.security.access_control import classification_rank, within_ceiling
from ai_api.security.policies import Policy, Principal
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
    governance: GovernanceService | None = None
    policy: Policy | None = None

    async def _caller_ceiling(self, tenant_id: int) -> str:
        if self.governance is None:
            return "internal"
        return (await self.governance.policy_for(tenant_id)).data_classification_ceiling

    def _resolve_labels(
        self,
        principal: Principal,
        source: dict[str, Any],
        document: Any,
        caller_ceiling: str,
    ) -> tuple[str, dict[str, Any], bool]:
        """Return ingestion-safe labels.

        Classification can only move up from the source (never downgrade), and a
        document ACL cannot replace or broaden a non-empty source ACL.
        """
        source_classification = str(source.get("classification") or "internal")
        requested = getattr(document, "classification", None) or source_classification
        classification = (
            requested
            if classification_rank(requested) >= classification_rank(source_classification)
            else source_classification
        )
        relabeled = str(requested) != str(classification)

        is_superuser = (self.policy or Policy()).is_superuser(principal)
        if not is_superuser and not within_ceiling(classification, caller_ceiling):
            raise AuthorizationError(
                "document classification exceeds the caller's data ceiling",
                details={"classification": classification, "ceiling": caller_ceiling},
            )

        source_acl = source.get("acl") or {}
        document_acl = getattr(document, "acl", None) or {}
        if source_acl:
            if document_acl and dict(document_acl) != dict(source_acl):
                raise ValidationError(
                    "document ACL cannot replace or broaden the source ACL",
                    details={"source_id": source.get("id")},
                )
            acl = dict(source_acl)
        else:
            acl = dict(document_acl)
        return classification, acl, relabeled

    async def enqueue(self, principal: Principal, source_id: int, body: Any) -> dict[str, Any]:
        """Queue client-supplied text/base64 documents (never object keys)."""

        return await self._enqueue(
            principal,
            source_id,
            list(body.documents),
            idempotency_key=getattr(body, "idempotency_key", None),
        )

    async def enqueue_stored(
        self, principal: Principal, source_id: int, documents: list[Any]
    ) -> dict[str, Any]:
        """Queue originals previously written by the server-side upload path.

        Callers cannot reach this method from an HTTP route that accepts an
        object key. Every key is still revalidated against the tenant namespace
        here before a durable job references it.
        """

        return await self._enqueue(
            principal, source_id, documents, idempotency_key=None
        )

    async def _enqueue(
        self,
        principal: Principal,
        source_id: int,
        inputs: list[Any],
        *,
        idempotency_key: str | None,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, source_id)
        if source is None:
            raise NotFoundError("knowledge source not found", details={"source_id": source_id})
        ceiling = await self._caller_ceiling(tenant_id)
        documents: list[dict[str, Any]] = []
        stored_keys: list[str] = []
        relabeled = 0
        try:
            for document in inputs:
                object_key = getattr(document, "object_key", None)
                if object_key:
                    stored_keys.append(
                        validate_tenant_object_key(object_key, tenant_id)
                    )
                classification, acl, changed = self._resolve_labels(
                    principal, source, document, ceiling
                )
                data = document.model_dump()
                data["classification"] = classification
                data["acl"] = acl
                documents.append(data)
                relabeled += int(changed)
            job = await self.repository.create_job(
                tenant_id,
                {
                    "type": "index",
                    "source_id": source_id,
                    "idempotency_key": idempotency_key,
                    "payload": {"documents": documents},
                },
            )
        except Exception:
            # No durable job exists yet, so server-written originals would be
            # unreferenced. Only keys already validated into the tenant
            # namespace are eligible for cleanup. Failures after job creation
            # (audit/event publication) must leave the original in place.
            await self._discard_unreferenced_originals(tenant_id, stored_keys)
            raise
        assert job is not None
        detail: dict[str, Any] = {
            "source_id": source_id,
            "documents": len(inputs),
        }
        if relabeled:
            detail["relabeled"] = relabeled
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge.index_requested",
            resource_type="job",
            resource_id=str(job["id"]),
            request_id=request_id_var.get(),
            detail=detail,
        )
        if self.events is not None:
            await self.events.knowledge_index_requested(
                tenant_id=tenant_id,
                source_id=source_id,
                job_id=job["id"],
                documents=len(inputs),
                actor_id=principal.actor_id,
            )
        return job

    async def _discard_unreferenced_originals(
        self, tenant_id: int, keys: list[str]
    ) -> None:
        if not keys or self.storage is None:
            return
        for key in dict.fromkeys(keys):
            try:
                safe_key = validate_tenant_object_key(key, tenant_id)
                await self.storage.delete(safe_key)
            except Exception:  # noqa: BLE001 - cleanup is best effort
                logger.warning(
                    "ingestion.upload_cleanup_failed", tenant_id=tenant_id
                )

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
        ceiling = await self._caller_ceiling(tenant_id)
        stats = {"documents": 0, "chunks": 0, "skipped": 0, "relabeled": 0}
        try:
            for document in documents:
                segments = await self._extract_segments(tenant_id, document)
                if not any(segment.text.strip() for segment in segments):
                    stats["skipped"] += 1
                    continue
                classification, acl, relabeled = self._resolve_labels(
                    principal, source, document, ceiling
                )
                if relabeled:
                    stats["relabeled"] += 1
                await self._ingest_document(
                    tenant_id,
                    source,
                    document,
                    segments,
                    embed_model,
                    stats,
                    classification,
                    acl,
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
                    "document_classification": row.get("document_classification"),
                    "document_acl": row.get("document_acl") or {},
                    "document_metadata": row.get("document_metadata") or {},
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
                document = StoredKnowledgeDocumentIn(
                    external_id=entry["external_id"],
                    title=entry["title"],
                    mime_type=entry["mime_type"],
                    object_key=entry.get("object_key"),
                    classification=entry["classification"],
                    acl=entry["acl"],
                    metadata=entry.get("document_metadata") or {},
                )
                if document.object_key:
                    segments = await self._extract_segments(
                        tenant_id, document, allow_legacy=True
                    )
                else:
                    segments = self._segments_from_chunks(entry["parts"])
                if not any(segment.text.strip() for segment in segments):
                    stats["skipped"] += 1
                    continue
                classification, acl = self._reindex_labels(source, entry)
                await self._ingest_document(
                    tenant_id,
                    source,
                    document,
                    segments,
                    embed_model,
                    stats,
                    classification,
                    acl,
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

    async def reindex_document(
        self, principal: Principal, document_id: int
    ) -> dict[str, Any]:
        """Rebuild one document's chunks/embeddings from its stored content.

        Reuses the same label-clamping and ingestion path as a source reindex so
        a per-document rebuild can never restore stale labels or resurrect a
        document that has been deleted.
        """
        tenant_id = require_tenant(principal)
        document_row = await self.repository.get_document(tenant_id, document_id)
        if document_row is None:
            raise NotFoundError(
                "document not found", details={"document_id": document_id}
            )
        source = await self.repository.get_knowledge_source(
            tenant_id, document_row["source_id"]
        )
        if source is None:
            raise NotFoundError(
                "knowledge source not found",
                details={"source_id": document_row["source_id"]},
            )
        if source["status"] == "disabled":
            raise ValidationError("knowledge source is disabled")

        chunks, _total = await self.repository.list_document_chunks(
            tenant_id, document_id, limit=10000, offset=0
        )
        document = StoredKnowledgeDocumentIn(
            external_id=document_row["external_id"],
            title=document_row.get("title"),
            mime_type=document_row.get("mime_type"),
            object_key=document_row.get("object_key"),
            classification=document_row.get("classification"),
            acl=document_row.get("acl") or {},
            metadata=document_row.get("metadata") or {},
        )
        if document.object_key:
            segments = await self._extract_segments(
                tenant_id, document, allow_legacy=True
            )
        else:
            segments = self._segments_from_chunks(
                [
                    (
                        chunk["chunk_index"],
                        chunk.get("page"),
                        chunk.get("section"),
                        chunk["content"],
                    )
                    for chunk in chunks
                ]
            )
        if not any(segment.text.strip() for segment in segments):
            raise ValidationError("document has no indexable content")

        entry = {
            "document_classification": document_row.get("classification"),
            "document_acl": document_row.get("acl") or {},
            "classification": document_row.get("classification"),
            "acl": document_row.get("acl") or {},
        }
        classification, acl = self._reindex_labels(source, entry)
        stats = {"documents": 0, "chunks": 0, "skipped": 0}
        await self._ingest_document(
            tenant_id,
            source,
            document,
            segments,
            default_embedding_model(self.settings),
            stats,
            classification,
            acl,
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.document.reindex",
            resource_type="document",
            resource_id=str(document_id),
            request_id=request_id_var.get(),
            detail=dict(stats),
        )
        return {"document_id": document_id, **stats}

    @staticmethod
    def _reindex_labels(
        source: dict[str, Any], entry: dict[str, Any]
    ) -> tuple[str, dict[str, Any]]:
        """Labels for rebuilt rows, clamped to current authoritative policy.

        A reindex must never restore a stale, broader label from old chunk rows.
        Classification is the maximum of source/document/chunk labels, and the ACL
        prefers the live document then source ACL; chunk ACLs are only used when
        neither authoritative level carries one.
        """
        classification = max(
            (
                label
                for label in (
                    source.get("classification"),
                    entry.get("document_classification"),
                    entry.get("classification"),
                )
                if label
            ),
            key=classification_rank,
            default="internal",
        )
        document_acl = entry.get("document_acl") or {}
        source_acl = source.get("acl") or {}
        chunk_acl = entry.get("acl") or {}
        # A non-empty source ACL is the authoritative inherited policy: always
        # use the latest source value, even if the document/chunk still carries a
        # stale copy from an earlier ingestion. Document/chunk ACLs apply only
        # when the source has no ACL of its own.
        if source_acl:
            acl = dict(source_acl)
        elif document_acl:
            acl = dict(document_acl)
        else:
            acl = dict(chunk_acl)
        return classification, acl

    async def _ingest_document(
        self,
        tenant_id: int,
        source: dict[str, Any],
        document: Any,
        segments: list[Segment],
        embed_model: str,
        stats: dict[str, int],
        classification: str,
        acl: dict[str, Any],
    ) -> None:
        text = "\n\n".join(segment.text for segment in segments)
        encoded = text.encode("utf-8")
        checksum = getattr(document, "checksum", None) or hashlib.sha256(encoded).hexdigest()
        size_bytes = getattr(document, "size_bytes", None) or len(encoded)

        document_row = await self.repository.create_or_replace_document(
            tenant_id,
            {
                "source_id": source["id"],
                "external_id": document.external_id,
                "title": document.title or document.external_id,
                "mime_type": document.mime_type,
                "object_key": getattr(document, "object_key", None),
                "checksum": checksum,
                "size_bytes": size_bytes,
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
            "external_id": document_row.get("external_id"),
            "title": document_row.get("title"),
            "mime_type": document_row.get("mime_type"),
            "status": document_row.get("status"),
            "classification": document_row.get("classification"),
            "acl": document_row.get("acl") or {},
            "created_at": document_row.get("created_at"),
            "updated_at": document_row.get("updated_at"),
            "metadata": document_row.get("metadata") or {},
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

    async def _extract_segments(
        self, tenant_id: int, document: Any, *, allow_legacy: bool = False
    ) -> list[Segment]:
        object_key = getattr(document, "object_key", None)
        if object_key:
            if self.storage is None:
                raise ConfigurationError("object storage is not configured")
            if allow_legacy:
                safe_key = validate_document_object_key(object_key, tenant_id)
            else:
                safe_key = validate_tenant_object_key(object_key, tenant_id)
            data = await self.storage.get(safe_key)
            if data is None:
                raise NotFoundError("stored document not found")
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
            "document must include text, content_base64, or a stored original",
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
