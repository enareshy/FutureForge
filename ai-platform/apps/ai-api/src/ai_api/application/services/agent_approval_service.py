"""AI-native human approval service for controlled agent operations (Stage 6).

Approvals bind an exact operation hash (agent version + step + tool version +
arguments). The model cannot grant approval; only an authorized human reviewer
can, and the requester cannot approve their own operation unless they are a
platform superuser. Deciding an approval never executes the operation itself;
it releases the paused execution for the worker to resume.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.domain.errors import (
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
)
from ai_api.security.policies import Policy, Principal


@dataclass(slots=True)
class AgentApprovalService:
    repository: AiRepository
    audit: AuditService
    policy: Policy

    async def list(
        self,
        principal: Principal,
        *,
        status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_agent_approvals(
            tenant_id, status=status, limit=limit, offset=offset
        )

    async def get(self, principal: Principal, approval_id: int) -> dict:
        tenant_id = require_tenant(principal)
        approval = await self.repository.get_agent_approval(tenant_id, approval_id)
        if approval is None:
            raise NotFoundError(
                "approval not found", details={"approval_id": approval_id}
            )
        return approval

    async def approve(
        self, principal: Principal, approval_id: int, reason: str | None
    ) -> dict:
        return await self._decide(principal, approval_id, "approved", reason)

    async def reject(
        self, principal: Principal, approval_id: int, reason: str | None
    ) -> dict:
        if not (reason or "").strip():
            raise ValidationError("a rejection reason is required")
        return await self._decide(principal, approval_id, "rejected", reason)

    async def _decide(
        self,
        principal: Principal,
        approval_id: int,
        status: str,
        reason: str | None,
    ) -> dict:
        tenant_id = require_tenant(principal)
        self.policy.require(
            principal,
            "ai.agent_approvals:execute",
            message="not authorized to decide agent approvals",
        )
        approval = await self.repository.get_agent_approval(tenant_id, approval_id)
        if approval is None:
            raise NotFoundError("approval not found")
        if approval["status"] != "pending":
            raise ConflictError(
                "approval was already decided", details={"status": approval["status"]}
            )
        expires_at = approval.get("expires_at")
        if expires_at is not None and expires_at < datetime.now(UTC):
            await self.repository.decide_agent_approval(
                tenant_id,
                approval_id,
                status="expired",
                reviewer_actor_id=principal.actor_id,
                reviewer_name=principal.username,
                reason="expired before decision",
            )
            raise ConflictError("approval has expired")
        requester_id = approval.get("requested_by")
        same_actor = (
            requester_id is not None and requester_id == principal.actor_id
        ) or (
            requester_id is None
            and approval.get("requested_by_name") == principal.username
        )
        if same_actor and not self.policy.is_superuser(principal):
            raise AuthorizationError("requesters cannot approve their own operation")

        decided = await self.repository.decide_agent_approval(
            tenant_id,
            approval_id,
            status=status,
            reviewer_actor_id=principal.actor_id,
            reviewer_name=principal.username,
            reason=reason,
        )
        if decided is None:
            raise ConflictError("approval was already decided")
        execution = await self.repository.get_agent_execution(
            tenant_id, int(approval["execution_id"])
        )
        if execution is not None and execution["status"] == "waiting_approval":
            if status == "approved":
                await self.repository.update_agent_execution(
                    tenant_id,
                    int(approval["execution_id"]),
                    expected_state="waiting_approval",
                    fields={
                        "status": "queued",
                        "lease_owner": None,
                        "lease_expires_at": None,
                    },
                )
            else:
                await self.repository.update_agent_execution(
                    tenant_id,
                    int(approval["execution_id"]),
                    expected_state="waiting_approval",
                    fields={
                        "status": "cancelled",
                        "completed_at": datetime.now(UTC),
                        "error": {
                            "class": "approval_rejected",
                            "message": reason or "approval rejected",
                        },
                    },
                )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action=f"ai.agent_approval.{status}",
            resource_type="agent_approval",
            resource_id=str(approval_id),
            outcome="success",
            detail={
                "execution_id": approval["execution_id"],
                "operation_hash": approval["operation_hash"],
                "reason": (reason or "")[:500],
            },
        )
        return decided
