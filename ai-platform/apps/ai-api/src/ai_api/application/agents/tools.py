"""Allowed-tool registry with tool-level authorization (Phase 9).

Tools are the *only* way an agent may affect or read the outside world. Every
tool declares the enterprise capability it needs; the registry authorizes the
caller against enterprise permissions before the tool runs, and can require an
explicit human-approval token for tools flagged `requires_approval`. Tools may
read; V1 ships read-only tools only and never mutates business objects.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from ai_api.application.services.retrieval_service import RetrievalService
from ai_api.config.settings import Settings
from ai_api.domain.errors import ApprovalRequiredError, AuthorizationError, ValidationError
from ai_api.security.permissions import CAP_KNOWLEDGE_READ
from ai_api.security.policies import PermissionMap, Policy, Principal
from ai_api.telemetry.logging import get_logger
from ai_api.telemetry.metrics import observe_tool_call
from ai_api.telemetry.tracing import span

logger = get_logger("agent.tools")

TOOL_KNOWLEDGE_SEARCH = "knowledge.search"


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """Typed description of a tool an agent is allowed to call."""

    name: str
    description: str
    capability: str
    read_only: bool = True
    requires_approval: bool = False
    input_schema: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ToolCallContext:
    """Authorization context passed to every tool invocation."""

    principal: Principal
    tenant_id: int
    approvals: frozenset[str] = frozenset()


@runtime_checkable
class Tool(Protocol):
    spec: ToolSpec

    async def run(
        self, context: ToolCallContext, args: dict[str, Any]
    ) -> dict[str, Any]: ...


@dataclass(slots=True)
class KnowledgeSearchTool:
    """Read-only authorized knowledge search (Phase 7 retrieval pipeline).

    Reuses the same ACL and classification-ceiling enforcement as the retrieval
    API: similarity never grants access. Returns ranked candidates plus a
    confidence signal the agent uses to decide whether evidence is sufficient.
    """

    retrieval: RetrievalService
    settings: Settings
    spec: ToolSpec = field(
        default_factory=lambda: ToolSpec(
            name=TOOL_KNOWLEDGE_SEARCH,
            description="Search the tenant's authorized enterprise knowledge base.",
            capability=CAP_KNOWLEDGE_READ,
            read_only=True,
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                },
                "required": ["query"],
            },
        )
    )

    async def run(
        self, context: ToolCallContext, args: dict[str, Any]
    ) -> dict[str, Any]:
        query = str(args.get("query") or "").strip()
        if not query:
            raise ValidationError("knowledge.search requires a non-empty query")
        limit = int(args.get("limit") or self.settings.ai_rag_default_limit)
        limit = max(1, min(limit, self.settings.ai_search_default_limit))
        results = await self.retrieval.authorized_search(
            context.principal, query, limit=limit
        )
        best = float(results[0]["score"]) if results else 0.0
        return {
            "query": query,
            "count": len(results),
            "confidence": round(best, 6),
            "results": results,
        }


@dataclass(slots=True)
class ToolRegistry:
    """Registers tools and authorizes every call before it runs."""

    tools: dict[str, Tool]
    policy: Policy
    permissions: PermissionMap
    require_approval: bool = False

    def get(self, name: str) -> Tool | None:
        return self.tools.get(name)

    def names(self) -> list[str]:
        return sorted(self.tools)

    def describe(self) -> list[dict[str, Any]]:
        return [
            {
                "name": tool.spec.name,
                "description": tool.spec.description,
                "capability": tool.spec.capability,
                "read_only": tool.spec.read_only,
                "requires_approval": tool.spec.requires_approval,
                "input_schema": tool.spec.input_schema,
            }
            for tool in (self.tools[name] for name in self.names())
        ]

    async def run(
        self, name: str, context: ToolCallContext, args: dict[str, Any]
    ) -> dict[str, Any]:
        tool = self.tools.get(name)
        if tool is None:
            raise AuthorizationError(
                "the agent requested a tool that is not allowed",
                details={"tool": name, "allowed": self.names()},
            )
        permission = self.permissions.permission_for(tool.spec.capability)
        self.policy.require(
            context.principal,
            permission,
            message="not authorized to use this agent tool",
        )
        needs_approval = tool.spec.requires_approval or self.require_approval
        if needs_approval and name not in context.approvals:
            logger.info("agent.tool.approval_required", tool=name)
            raise ApprovalRequiredError(
                "this tool requires human approval before it can run",
                details={"tool": name},
            )
        logger.info("agent.tool.invoke", tool=name)
        started = time.perf_counter()
        outcome = "success"
        try:
            with span("ai.agent.tool", {"ai.operation": "tool", "ai.tool": name}):
                return await tool.run(context, args)
        except Exception:
            outcome = "error"
            raise
        finally:
            observe_tool_call(
                tool=name,
                outcome=outcome,
                duration_seconds=time.perf_counter() - started,
            )


def build_default_tools(
    retrieval: RetrievalService, settings: Settings
) -> dict[str, Tool]:
    """The tool catalog available to V1 agents (read-only)."""

    tool = KnowledgeSearchTool(retrieval=retrieval, settings=settings)
    return {tool.spec.name: tool}
