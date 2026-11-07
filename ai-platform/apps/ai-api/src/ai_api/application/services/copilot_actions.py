"""Controlled enterprise actions for the Copilot (Stage 5).

The Copilot may *propose* an enterprise action; it can never perform one on its
own. This service encodes the full lifecycle:

    proposed -> approved -> executed | failed
    proposed -> rejected
    proposed -> expired

Hard guarantees:

* Proposing is inert: no enterprise request is made. The model only supplies a
  description and arguments; the server derives the operation hash.
* Approving and executing are separate, individually authorized steps. The
  requester cannot approve their own action (unless a platform superuser).
* Permissions are re-validated at execution time, not only at proposal time, so
  a revoked right cannot be replayed through a stale approval.
* `operation_hash` is unique per tenant and the execution claim is a conditional
  `approved -> executing` update, so a replayed or duplicated execution cannot
  take effect twice.
* Every transition records who requested, decided and executed, plus an audit
  event. The model is never trusted to authorize anything.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_actor_id, require_tenant
from ai_api.config.settings import Settings
from ai_api.domain.errors import (
    AuthorizationError,
    ConflictError,
    FeatureUnavailableError,
    NotFoundError,
    ValidationError,
)
from ai_api.security.permissions import (
    CAP_COPILOT_ACTIONS_DECIDE,
    CAP_COPILOT_ACTIONS_EXECUTE,
)
from ai_api.security.policies import PermissionMap, Policy, Principal
from ai_api.telemetry.logging import get_logger, request_id_var

logger = get_logger("copilot.actions")

ACTION_PROPOSED = "proposed"
ACTION_APPROVED = "approved"
ACTION_REJECTED = "rejected"
ACTION_EXPIRED = "expired"
ACTION_EXECUTED = "executed"
ACTION_FAILED = "failed"

_DECIDABLE = frozenset({ACTION_APPROVED, ACTION_REJECTED})


class ActionExecutor(Protocol):
    """Executes an approved action through an existing enterprise workflow."""

    async def execute(
        self, principal: Principal, action: dict[str, Any]
    ) -> dict[str, Any]: ...


def operation_hash(action_type: str, target: str, arguments: dict[str, Any]) -> str:
    """Deterministic binding of the exact proposed operation."""

    payload = {
        "action_type": action_type,
        "target": target,
        "arguments": arguments,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(slots=True)
class CopilotActionService:
    repository: AiRepository
    audit: AuditService
    policy: Policy
    settings: Settings
    executor: ActionExecutor | None = None
    permissions: PermissionMap = field(default_factory=PermissionMap)

    # --- Proposal ------------------------------------------------------
    async def propose(
        self,
        principal: Principal,
        *,
        action_type: str,
        target: str,
        summary: str,
        arguments: dict[str, Any] | None = None,
        expected_effect: str | None = None,
        evidence: list[dict[str, Any]] | None = None,
        conversation_id: int | None = None,
        message_id: int | None = None,
    ) -> dict[str, Any]:
        if not self.settings.ai_copilot_actions_enabled:
            raise FeatureUnavailableError("controlled actions are disabled")
        tenant_id = require_tenant(principal)
        actor_id = require_actor_id(principal)
        action_type = (action_type or "").strip()
        target = (target or "").strip()
        summary = (summary or "").strip()
        if not action_type or not target or not summary:
            raise ValidationError(
                "an action proposal requires a type, target and summary"
            )
        arguments = dict(arguments or {})
        digest = operation_hash(action_type, target, arguments)
        existing = await self.repository.get_copilot_action_by_hash(tenant_id, digest)
        if existing is not None:
            return {**existing, "duplicate": True}

        expires_at = datetime.now(UTC) + timedelta(
            seconds=self.settings.ai_copilot_action_ttl_seconds
        )
        created = await self.repository.create_copilot_action(
            tenant_id,
            {
                "conversation_id": conversation_id,
                "message_id": message_id,
                "action_type": action_type,
                "target": target,
                "summary": summary,
                "arguments": arguments,
                "expected_effect": expected_effect,
                "evidence": _bounded_evidence(evidence),
                "operation_hash": digest,
                "risk_class": "controlled_mutation",
                "requested_by": actor_id,
                "requested_by_name": principal.username,
                "request_id": request_id_var.get(),
                "expires_at": expires_at,
            },
        )
        if created is None:
            existing = await self.repository.get_copilot_action_by_hash(tenant_id, digest)
            if existing is None:
                raise ConflictError("the action proposal could not be recorded")
            return {**existing, "duplicate": True}
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=actor_id,
            action="ai.copilot.action_proposed",
            resource_type="copilot_action",
            resource_id=str(created["id"]),
            request_id=request_id_var.get(),
            detail={
                "action_type": action_type,
                "target": target,
                "operation_hash": digest,
            },
        )
        return {**created, "duplicate": False}

    # --- Read ----------------------------------------------------------
    async def list(
        self,
        principal: Principal,
        *,
        status: str | None,
        conversation_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_copilot_actions(
            tenant_id,
            status=status,
            conversation_id=conversation_id,
            limit=limit,
            offset=offset,
        )

    async def get(self, principal: Principal, action_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        action = await self.repository.get_copilot_action(tenant_id, action_id)
        if action is None:
            raise NotFoundError(
                "action not found", details={"action_id": action_id}
            )
        return action

    # --- Decision ------------------------------------------------------
    async def approve(
        self, principal: Principal, action_id: int, reason: str | None
    ) -> dict[str, Any]:
        return await self._decide(principal, action_id, ACTION_APPROVED, reason)

    async def reject(
        self, principal: Principal, action_id: int, reason: str | None
    ) -> dict[str, Any]:
        if not (reason or "").strip():
            raise ValidationError("a rejection reason is required")
        return await self._decide(principal, action_id, ACTION_REJECTED, reason)

    async def _decide(
        self,
        principal: Principal,
        action_id: int,
        status: str,
        reason: str | None,
    ) -> dict[str, Any]:
        if not self.settings.ai_copilot_actions_enabled:
            raise FeatureUnavailableError("controlled actions are disabled")
        assert status in _DECIDABLE
        tenant_id = require_tenant(principal)
        self.policy.require(
            principal,
            self.permissions.permission_for(CAP_COPILOT_ACTIONS_DECIDE),
            message="not authorized to decide copilot actions",
        )
        action = await self.repository.get_copilot_action(tenant_id, action_id)
        if action is None:
            raise NotFoundError("action not found")
        if action["status"] != ACTION_PROPOSED:
            raise ConflictError(
                "action was already decided", details={"status": action["status"]}
            )
        expires_at = action.get("expires_at")
        if expires_at is not None and expires_at < datetime.now(UTC):
            await self.repository.decide_copilot_action(
                tenant_id,
                action_id,
                status=ACTION_EXPIRED,
                reviewer_actor_id=principal.actor_id,
                reviewer_name=principal.username,
                reason="expired before decision",
            )
            raise ConflictError("action has expired")

        requester_id = action.get("requested_by")
        same_actor = (
            requester_id is not None and requester_id == principal.actor_id
        ) or (
            requester_id is None
            and action.get("requested_by_name") == principal.username
        )
        if same_actor and not self.policy.is_superuser(principal):
            raise AuthorizationError(
                "requesters cannot approve or reject their own action"
            )

        decided = await self.repository.decide_copilot_action(
            tenant_id,
            action_id,
            status=status,
            reviewer_actor_id=principal.actor_id,
            reviewer_name=principal.username,
            reason=reason,
        )
        if decided is None:
            raise ConflictError("action was already decided")
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action=f"ai.copilot.action_{status}",
            resource_type="copilot_action",
            resource_id=str(action_id),
            request_id=request_id_var.get(),
            detail={
                "action_type": action["action_type"],
                "operation_hash": action["operation_hash"],
                "reason": (reason or "")[:500],
            },
        )
        return decided

    # --- Execution -----------------------------------------------------
    async def execute(
        self, principal: Principal, action_id: int
    ) -> dict[str, Any]:
        if not self.settings.ai_copilot_actions_enabled:
            raise FeatureUnavailableError("controlled actions are disabled")
        tenant_id = require_tenant(principal)
        self.policy.require(
            principal,
            self.permissions.permission_for(CAP_COPILOT_ACTIONS_EXECUTE),
            message="not authorized to execute copilot actions",
        )
        action = await self.repository.get_copilot_action(tenant_id, action_id)
        if action is None:
            raise NotFoundError("action not found")
        if action["status"] != ACTION_APPROVED:
            raise ConflictError(
                "only an approved action can be executed",
                details={"status": action["status"]},
            )

        # Re-validate the substantive permission at execution time. Approval is
        # not a substitute for authorization: a right revoked after approval must
        # not be replayable.
        for capability in _required_capabilities(action):
            self.policy.require(
                principal,
                capability,
                message="not authorized to execute this enterprise action",
            )

        claimed = await self.repository.claim_copilot_action_execution(
            tenant_id,
            action_id,
            executor_actor_id=principal.actor_id,
            executor_name=principal.username,
        )
        if claimed is None:
            raise ConflictError("action was already executed or claimed")

        if self.executor is None:
            await self.repository.complete_copilot_action(
                tenant_id,
                action_id,
                status=ACTION_FAILED,
                result={},
                error_class="executor_unavailable",
            )
            raise FeatureUnavailableError(
                "no approved integration executor is configured for this action"
            )

        try:
            result = await self.executor.execute(principal, claimed)
        except Exception as exc:  # noqa: BLE001 - reported as an outcome
            logger.warning("copilot.action.execution_failed", error=str(exc))
            completed = await self.repository.complete_copilot_action(
                tenant_id,
                action_id,
                status=ACTION_FAILED,
                result={},
                error_class=type(exc).__name__,
            )
            await self.audit.record(
                tenant_id=tenant_id,
                actor_id=principal.actor_id,
                action="ai.copilot.action_failed",
                resource_type="copilot_action",
                resource_id=str(action_id),
                outcome="failure",
                request_id=request_id_var.get(),
                detail={"error_class": type(exc).__name__},
            )
            raise ConflictError(
                "the approved action failed to execute",
                details={"action_id": action_id, "status": ACTION_FAILED},
            ) from exc

        completed = await self.repository.complete_copilot_action(
            tenant_id,
            action_id,
            status=ACTION_EXECUTED,
            result=result or {},
            error_class=None,
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.copilot.action_executed",
            resource_type="copilot_action",
            resource_id=str(action_id),
            request_id=request_id_var.get(),
            detail={
                "action_type": action["action_type"],
                "operation_hash": action["operation_hash"],
            },
        )
        return completed or claimed


def _required_capabilities(action: dict[str, Any]) -> list[str]:
    arguments = action.get("arguments") or {}
    raw = arguments.get("required_capabilities") or []
    if isinstance(raw, str):
        raw = [raw]
    return [str(item)[:120] for item in raw if isinstance(item, str) and item]


def _bounded_evidence(
    evidence: list[dict[str, Any]] | None, *, limit: int = 5
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in (evidence or [])[:limit]:
        if not isinstance(item, dict):
            continue
        rows.append(
            {
                "document_id": item.get("document_id"),
                "chunk_id": item.get("chunk_id"),
                "source_code": item.get("source_code"),
                "rank": item.get("rank"),
            }
        )
    return rows
