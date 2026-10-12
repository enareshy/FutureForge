from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.knowledge_service import require_tenant
from ai_api.domain.errors import FeatureUnavailableError, NotFoundError
from ai_api.security.policies import Principal


@dataclass(slots=True)
class AgentService:
    repository: AiRepository

    async def list_agents(self, principal: Principal) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_agents(tenant_id)

    async def get_agent(self, principal: Principal, agent_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        agent = await self.repository.get_agent(tenant_id, agent_id)
        if agent is None:
            raise NotFoundError("agent not found", details={"agent_id": agent_id})
        return agent

    async def execute(self, principal: Principal, agent_id: int, payload: Any) -> dict[str, Any]:
        await self.get_agent(principal, agent_id)
        raise FeatureUnavailableError(
            "agent execution is not available in this release",
            details={"phase": "Phase 9"},
        )
