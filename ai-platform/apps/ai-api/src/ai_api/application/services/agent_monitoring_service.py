"""Agent monitoring and administration (Stage 6 completion).

Read-only aggregation over the existing execution ledger. No secrets, prompts or
enterprise payloads are exposed: only counts, status, timing and bounded
summaries already safe for the execution trace.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.agent_execution_service import AgentExecutionService
from ai_api.application.services.context import require_tenant
from ai_api.domain.errors import NotFoundError
from ai_api.security.policies import Principal


@dataclass(slots=True)
class AgentMonitoringService:
    repository: AiRepository
    executions: AgentExecutionService

    async def overview(self, principal: Principal) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        stats = await self.repository.agent_execution_stats(tenant_id, agent_id=None)
        agents, total_agents = await self.repository.list_agent_catalog(
            tenant_id,
            query=None,
            lifecycle_status=None,
            category=None,
            limit=1,
            offset=0,
        )
        recent, _ = await self.repository.list_agent_executions(
            tenant_id, state=None, agent_id=None, limit=10, offset=0
        )
        return {
            "agents_total": total_agents,
            "executions": stats,
            "recent": [self._public(item) for item in recent],
            "generated_at": datetime.now(UTC),
        }

    async def agent_stats(self, principal: Principal, agent_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        agent = await self.repository.get_agent(tenant_id, agent_id)
        if agent is None:
            raise NotFoundError("agent not found")
        stats = await self.repository.agent_execution_stats(tenant_id, agent_id=agent_id)
        return {
            "agent_id": agent_id,
            "name": agent.get("name"),
            "lifecycle_status": agent.get("lifecycle_status"),
            "enabled": bool(agent.get("enabled", False)),
            "executions": stats,
        }

    async def health(self, principal: Principal, agent_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        agent = await self.repository.get_agent(tenant_id, agent_id)
        if agent is None:
            raise NotFoundError("agent not found")
        stats = await self.repository.agent_execution_stats(tenant_id, agent_id=agent_id)
        total = max(1, stats["total"])
        failure_rate = stats["failed"] / total if stats["total"] else 0.0
        if not agent.get("enabled", False):
            state = "inactive"
        elif failure_rate >= 0.5 and stats["total"] >= 5:
            state = "degraded"
        elif stats["waiting_approval"] > 0:
            state = "waiting_approval"
        else:
            state = "healthy"
        return {
            "agent_id": agent_id,
            "health": state,
            "failure_rate": round(failure_rate, 4),
            "stats": stats,
        }

    async def history(
        self,
        principal: Principal,
        *,
        agent_id: int | None,
        state: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        items, total = await self.repository.list_agent_executions(
            tenant_id, state=state, agent_id=agent_id, limit=limit, offset=offset
        )
        return [self._public(item) for item in items], total

    async def delegations(
        self, principal: Principal, execution_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        execution = await self.repository.get_agent_execution(tenant_id, execution_id)
        if execution is None:
            raise NotFoundError("execution not found")
        rows = await self.repository.list_agent_delegations(tenant_id, execution_id)
        return {"execution_id": execution_id, "delegations": rows}

    async def failures(
        self, principal: Principal, *, agent_id: int | None, limit: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        items, _ = await self.repository.list_agent_executions(
            tenant_id, state="failed", agent_id=agent_id, limit=limit, offset=0
        )
        return [self._public(item) for item in items]

    @staticmethod
    def _public(execution: dict[str, Any]) -> dict[str, Any]:
        keys = (
            "id",
            "agent_id",
            "agent_version_id",
            "status",
            "current_step",
            "step_count",
            "tool_call_count",
            "error",
            "latency_ms",
            "token_usage",
            "created_at",
            "started_at",
            "completed_at",
            "delegation_depth",
            "parent_execution_id",
        )
        return {key: execution.get(key) for key in keys}


def since(hours: int) -> datetime:
    return datetime.now(UTC) - timedelta(hours=hours)
