from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository, ObjectStorage
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.config.settings import Settings
from ai_api.domain.errors import ConfigurationError, ConflictError, NotFoundError, ValidationError
from ai_api.infrastructure.ingestion.validation import validate_upload
from ai_api.infrastructure.storage import (
    build_object_key,
    content_checksum,
    sanitize_filename,
)
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import request_id_var

__all__ = ["KnowledgeService", "require_tenant"]


@dataclass(slots=True)
class KnowledgeService:
    repository: AiRepository
    audit: AuditService
    settings: Settings
    events: EventPublisher | None = None
    storage: ObjectStorage | None = None

    async def list_sources(
        self, principal: Principal, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_knowledge_sources(
            tenant_id, limit=limit, offset=offset
        )

    async def create_source(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        created = await self.repository.create_knowledge_source(
            tenant_id,
            {
                "code": payload.code,
                "name": payload.name,
                "kind": payload.kind,
                "uri": payload.uri,
                "classification": payload.classification,
                "acl": payload.acl,
                "config": payload.config,
            },
        )
        if created is None:
            raise ConflictError(
                "a knowledge source with this code already exists",
                details={"code": payload.code},
            )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge_source.create",
            resource_type="knowledge_source",
            resource_id=str(created["id"]),
            request_id=request_id_var.get(),
            detail={"code": created["code"]},
        )
        if self.events is not None:
            await self.events.knowledge_source_registered(
                tenant_id=tenant_id, source=created, actor_id=principal.actor_id
            )
        return created

    async def request_index(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, payload.source_id)
        if source is None:
            raise NotFoundError(
                "knowledge source not found",
                details={"source_id": payload.source_id},
            )
        job = await self.repository.create_job(
            tenant_id,
            {
                "type": "index",
                "source_id": payload.source_id,
                "idempotency_key": payload.idempotency_key,
                "payload": {"force": payload.force},
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
            detail={"source_id": payload.source_id},
        )
        if self.events is not None:
            await self.events.knowledge_index_requested(
                tenant_id=tenant_id,
                source_id=payload.source_id,
                job_id=job["id"],
                documents=0,
                actor_id=principal.actor_id,
            )
        return job

    async def get_job(self, principal: Principal, job_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        job = await self.repository.get_job(tenant_id, job_id)
        if job is None:
            raise NotFoundError("job not found", details={"job_id": job_id})
        return job

    async def list_jobs(
        self, principal: Principal, *, status: str | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_jobs(
            tenant_id, status=status, limit=limit, offset=offset
        )

    async def list_documents(
        self, principal: Principal, source_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, source_id)
        if source is None:
            raise NotFoundError("knowledge source not found", details={"source_id": source_id})
        return await self.repository.list_documents(
            tenant_id, source_id, limit=limit, offset=offset
        )

    async def delete_source(self, principal: Principal, source_id: int) -> None:
        tenant_id = require_tenant(principal)
        deleted = await self.repository.delete_source(tenant_id, source_id)
        if not deleted:
            raise NotFoundError("knowledge source not found", details={"source_id": source_id})
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge_source.delete",
            resource_type="knowledge_source",
            resource_id=str(source_id),
            request_id=request_id_var.get(),
        )

    async def store_upload(
        self,
        principal: Principal,
        source_id: int,
        *,
        filename: str | None,
        content_type: str | None,
        data: bytes,
    ) -> dict[str, Any]:
        """Validate and persist an uploaded original, returning a doc descriptor.

        Rejects unsupported/oversized/mismatched files, deduplicates by content
        checksum, and stores the original under an opaque, tenant-partitioned
        key. The returned mapping feeds an indexing job; no public URL is ever
        produced.
        """

        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, source_id)
        if source is None:
            raise NotFoundError("knowledge source not found", details={"source_id": source_id})
        if source["status"] == "disabled":
            raise ValidationError("knowledge source is disabled")
        if self.storage is None:
            raise ConfigurationError("object storage is not configured")

        resolved_mime = validate_upload(
            data,
            filename=filename,
            declared_mime=content_type,
            max_bytes=self.settings.ai_upload_max_bytes,
        )
        checksum = content_checksum(data)

        existing = await self.repository.find_document_by_checksum(tenant_id, checksum)
        existing_key = (existing or {}).get("object_key")
        if existing is not None and existing_key and await self.storage.exists(existing_key):
            return {
                "external_id": existing["external_id"],
                "title": existing.get("title") or filename,
                "mime_type": existing.get("mime_type") or resolved_mime,
                "object_key": existing_key,
                "checksum": checksum,
                "size_bytes": existing.get("size_bytes") or len(data),
                "deduplicated": True,
            }

        safe_name = sanitize_filename(filename or "document")
        object_key = build_object_key(tenant_id, safe_name)
        await self.storage.put(object_key, data, content_type=resolved_mime)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.document.upload",
            resource_type="knowledge_source",
            resource_id=str(source_id),
            request_id=request_id_var.get(),
            detail={"filename": safe_name, "size_bytes": len(data)},
        )
        return {
            "external_id": safe_name,
            "title": filename or safe_name,
            "mime_type": resolved_mime,
            "object_key": object_key,
            "checksum": checksum,
            "size_bytes": len(data),
            "deduplicated": False,
        }

    async def get_document_content(
        self, principal: Principal, document_id: int
    ) -> tuple[dict[str, Any], bytes]:
        tenant_id = require_tenant(principal)
        document = await self.repository.get_document(tenant_id, document_id)
        if document is None:
            raise NotFoundError("document not found", details={"document_id": document_id})
        object_key = document.get("object_key")
        if not object_key:
            raise NotFoundError("document has no stored original")
        if self.storage is None:
            raise ConfigurationError("object storage is not configured")
        data = await self.storage.get(object_key)
        if data is None:
            raise NotFoundError("stored document not found")
        return document, data

    async def delete_document(self, principal: Principal, document_id: int) -> None:
        tenant_id = require_tenant(principal)
        document = await self.repository.get_document(tenant_id, document_id)
        if document is None:
            raise NotFoundError("document not found", details={"document_id": document_id})
        await self.repository.delete_document(tenant_id, document_id)
        object_key = document.get("object_key")
        if object_key and self.storage is not None:
            await self.storage.delete(object_key)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.document.delete",
            resource_type="document",
            resource_id=str(document_id),
            request_id=request_id_var.get(),
        )
