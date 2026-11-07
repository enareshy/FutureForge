"""Agent memory (Stage 6 completion).

Three scopes, all tenant-scoped and authorization-checked server-side:

* ``execution`` — working memory bound to one execution; discarded with it.
* ``conversation`` — session context bound to one conversation id.
* ``agent`` — optional persistent memory owned by an agent and (by default) the
  actor who wrote it.

Rules that prevent memory becoming a leakage channel:

* Reads/writes always resolve `tenant_id` from the authenticated principal; a
  browser-supplied tenant is impossible.
* Persistent (agent) entries are readable by their owner and by principals with
  the management capability; execution/conversation entries are readable by
  the execution owner, the conversation owner, or a manager.
* Executions capture the caller's permissions; the runtime re-checks them, so
  memory cannot be used to bypass a later permission revocation.
* Expired entries are never returned and can be purged.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.domain.errors import AuthorizationError, NotFoundError, ValidationError
from ai_api.security.policies import Policy, Principal

_MAX_CONTENT = 20_000
_MAX_ENTRIES_PER_SCOPE = 500


@dataclass(slots=True)
class AgentMemoryService:
    repository: AiRepository
    audit: AuditService
    policy: Policy

    async def list(
        self,
        principal: Principal,
        *,
        agent_id: int | None,
        scope: str | None,
        execution_id: int | None,
        conversation_id: int | None,
        include_expired: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        manager = self._is_manager(principal)
        owner_filter = None if manager else principal.actor_id
        items, total = await self.repository.list_agent_memory(
            tenant_id,
            agent_id=agent_id,
            scope=scope,
            execution_id=execution_id,
            conversation_id=conversation_id,
            owner_actor_id=owner_filter,
            include_expired=include_expired and manager,
            limit=limit,
            offset=offset,
        )
        return [self._out(item) for item in items], total

    async def write(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        self.policy.require(
            principal,
            "ai.agents:execute",
            message="not authorized to write agent memory",
        )
        content = str(payload.content or "")
        if len(content) > _MAX_CONTENT:
            raise ValidationError("memory content is too large")
        if payload.scope == "execution" and payload.execution_id is None:
            raise ValidationError("execution scope requires execution_id")
        if payload.scope == "conversation" and payload.conversation_id is None:
            raise ValidationError("conversation scope requires conversation_id")
        if payload.execution_id is not None:
            execution = await self.repository.get_agent_execution(
                tenant_id, int(payload.execution_id)
            )
            if execution is None:
                raise NotFoundError("execution not found")
            if not self._is_manager(principal) and execution.get("actor_id") != principal.actor_id:
                raise AuthorizationError("execution belongs to another user")
        if payload.agent_id is not None:
            agent = await self.repository.get_agent(tenant_id, int(payload.agent_id))
            if agent is None:
                raise NotFoundError("agent not found")
        current, _ = await self.repository.list_agent_memory(
            tenant_id,
            agent_id=payload.agent_id,
            scope=payload.scope,
            execution_id=None,
            conversation_id=None,
            owner_actor_id=principal.actor_id,
            include_expired=False,
            limit=_MAX_ENTRIES_PER_SCOPE + 1,
            offset=0,
        )
        if len(current) >= _MAX_ENTRIES_PER_SCOPE:
            raise ValidationError("memory scope entry limit reached")
        expires_at = (
            datetime.now(UTC) + timedelta(seconds=payload.ttl_seconds)
            if payload.ttl_seconds
            else None
        )
        entry = await self.repository.upsert_agent_memory(
            tenant_id,
            {
                "agent_id": payload.agent_id,
                "scope": payload.scope,
                "execution_id": payload.execution_id,
                "conversation_id": payload.conversation_id,
                "owner_actor_id": principal.actor_id,
                "owner_username": principal.username,
                "memory_key": payload.memory_key,
                "content": content,
                "metadata": dict(payload.metadata or {}),
                "classification": payload.classification,
                "expires_at": expires_at,
            },
        )
        await self._audit(principal, "ai.agent.memory.write", entry["id"], {
            "scope": payload.scope,
            "agent_id": payload.agent_id,
        })
        return self._out(entry)

    async def delete(self, principal: Principal, entry_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        entry = await self.repository.get_agent_memory(tenant_id, entry_id)
        if entry is None:
            raise NotFoundError("memory entry not found")
        if not self._is_manager(principal) and entry.get("owner_actor_id") != principal.actor_id:
            raise AuthorizationError("memory entry belongs to another user")
        deleted = await self.repository.delete_agent_memory(tenant_id, entry_id)
        if deleted is None:
            raise NotFoundError("memory entry not found")
        await self._audit(principal, "ai.agent.memory.delete", entry_id, {
            "scope": entry.get("scope"),
        })
        return self._out(deleted)

    async def purge_expired(self, principal: Principal) -> dict[str, int]:
        tenant_id = require_tenant(principal)
        self._require_manager(principal)
        removed = await self.repository.purge_expired_agent_memory(tenant_id)
        await self._audit(principal, "ai.agent.memory.purge", 0, {"removed": removed})
        return {"removed": removed}

    async def recall(
        self,
        principal: Principal,
        *,
        agent_id: int,
        execution_id: int | None = None,
        conversation_id: int | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Return the entries the caller may see for an agent-execution run."""

        tenant_id = require_tenant(principal)
        items, _ = await self.repository.list_agent_memory(
            tenant_id,
            agent_id=agent_id,
            scope=None,
            execution_id=None,
            conversation_id=None,
            owner_actor_id=None if self._is_manager(principal) else principal.actor_id,
            include_expired=False,
            limit=limit,
            offset=0,
        )
        visible = []
        for item in items:
            if item.get("scope") == "execution" and execution_id is not None:
                if item.get("execution_id") != execution_id:
                    continue
            if item.get("scope") == "conversation":
                if conversation_id is None or item.get("conversation_id") != conversation_id:
                    continue
            visible.append(self._out(item))
        return visible[:limit]

    def _is_manager(self, principal: Principal) -> bool:
        return self.policy.can(principal, "ai.agents:update")

    def _require_manager(self, principal: Principal) -> None:
        self.policy.require(
            principal, "ai.agents:update", message="not authorized to manage memory"
        )

    @staticmethod
    def _out(entry: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": entry["id"],
            "agent_id": entry.get("agent_id"),
            "scope": entry.get("scope", "agent"),
            "execution_id": entry.get("execution_id"),
            "conversation_id": entry.get("conversation_id"),
            "owner_actor_id": entry.get("owner_actor_id"),
            "owner_username": entry.get("owner_username"),
            "memory_key": entry["memory_key"],
            "content": entry["content"],
            "metadata": entry.get("metadata", {}),
            "classification": entry.get("classification", "internal"),
            "expires_at": entry.get("expires_at"),
            "created_at": entry.get("created_at"),
            "updated_at": entry.get("updated_at"),
        }

    async def _audit(
        self,
        principal: Principal,
        action: str,
        entry_id: int,
        detail: dict[str, Any],
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action=action,
            resource_type="agent_memory",
            resource_id=str(entry_id),
            outcome="success",
            detail=detail,
        )
