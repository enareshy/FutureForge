from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.domain.errors import ConflictError, NotFoundError
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import request_id_var

__all__ = ["KnowledgeService", "require_tenant"]


@dataclass(slots=True)
class KnowledgeService:
    repository: AiRepository
    audit: AuditService
    events: EventPublisher | None = None

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
