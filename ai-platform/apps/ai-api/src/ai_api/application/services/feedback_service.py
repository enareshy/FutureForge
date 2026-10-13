"""Feedback capture (Phase 10).

Users may attach a rating and/or comment to an AI execution. Feedback is
tenant-scoped, validated against the referenced execution, and audited so it can
feed later evaluation work without fabricating metrics.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import request_id_var


@dataclass(slots=True)
class FeedbackService:
    repository: AiRepository
    audit: AuditService

    async def create(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        comment = payload.comment.strip() if payload.comment else None
        if payload.rating is None and not comment:
            raise ValidationError("provide a rating or a comment")
        if payload.execution_id is not None:
            execution = await self.repository.get_execution(
                tenant_id, payload.execution_id
            )
            if execution is None:
                raise NotFoundError(
                    "execution not found",
                    details={"execution_id": payload.execution_id},
                )
        record = await self.repository.record_feedback(
            tenant_id,
            {
                "execution_id": payload.execution_id,
                "actor_id": principal.actor_id,
                "rating": payload.rating,
                "comment": comment,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.feedback.create",
            resource_type="execution",
            resource_id=str(payload.execution_id) if payload.execution_id else None,
            request_id=request_id_var.get(),
            detail={"rating": payload.rating},
        )
        return record

    async def list(
        self,
        principal: Principal,
        *,
        execution_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_feedback(
            tenant_id, execution_id=execution_id, limit=limit, offset=offset
        )
